# Security audit

Method: source reading of every auth/guard/upload/integration path, live header inspection against the
running stack (`curl -D -`), a scan of the built browser bundle for known secret shapes, and the
existing adversarial suites (`authorization_matrix.py`, `auth_security.py`, `logic_probes.py`).
No finding below is speculative — each names the file or the observed response.

## 1. Controls that are in place (verified, not assumed)

| Control | Evidence | Verdict |
|---|---|---|
| Password hashing | argon2id, m=19456 t=2 p=1 — `apps/api/src/auth/password-hash.ts` | good (OWASP 2024 minimum) |
| Session storage | opaque token, HMAC-SHA256 at rest, `Session.tokenHash` unique | good |
| Session cookie | `httpOnly: true, secure: NODE_ENV==='production', sameSite:'lax', maxAge 7 d` — `auth.controller.ts:24-28` | good |
| CSRF | double-submit, token **derived** from session id via `SESSION_SECRET` (`session.service.ts:112`), verified constant-time; required on every unsafe method (`csrf.guard.ts:28`) | good |
| Authorization | 15 `@Roles('OWNER','ADMIN')` declarations; global `SessionAuthGuard`; live proof that MEMBER gets 403 on `/api/system/*` and 404 on another tenant's ids | good |
| Secrets in the browser | no `@clipforge/database`, `argon2`, `nodemailer`, `firebase-admin`, `bullmq`, `ioredis` in `apps/web`; bundle scan for `bot<digits>:`, `BEGIN PRIVATE KEY`, DB DSN, `SESSION_SECRET`, sandbox password → **0 hits** | good |
| No token storage in JS | 0 uses of `localStorage`/`sessionStorage`/`document.cookie` in the web app | good |
| Same-origin only | `/api` and `/media` are Next rewrites; CORS allow-list (`main.ts:46-60`) with explicit origins and a single-wildcard matcher, `credentials: true` | good |
| OTP design | 6-digit `crypto.randomInt`, 5 min TTL, 5 attempts counted before returning, 60 s cooldown, HMAC-SHA256 over `<challengeId>:<code>`, atomic single use | good |
| Account enumeration | `forgot-password` returns an identical body for unknown addresses (asserted by test) | good |
| OAuth token storage | AES-256-GCM at rest (`packages/database/src/crypto.ts`); never serialised to responses | good |
| Upload validation | mime allow-list (`packages/validation/src/index.ts:52-55`), chunk count/byte windows, server-side ffprobe, size ceiling by config | good |
| SSRF | `apps/api/src/media/ssrf-guard.ts` — scheme allow-list, credential rejection, DNS resolution of every hop, private/loopback/link-local blocking, redirect re-validation, byte + wall-clock caps | good |
| Admin-only notifications | `@Roles('OWNER','ADMIN')` on the whole `NotificationsController` | good |
| Audit trail | `AuditLog` rows for auth, config, publishing, brand assets; never contains OTP codes (asserted) | good |
| Error surface | uniform envelope; provider/DB internals replaced by codes; `requestId` returned for support | good |
| SQL injection | Prisma only, no raw string interpolation of user input except `$queryRaw` in health checks with literals | good |
| Rate limiting | 21 handlers with explicit budgets (login 10/5 min, OTP verify 20/5 min, upload part 600/min…) | partial — see S2 |

## 2. Findings

| ID | Sev | Finding | Where | Why it matters | Fix |
|---|---|---|---|---|---|
| S1 | **HIGH** | **No security headers on either app.** Live check: the API answers with only `Vary`, `Access-Control-Allow-Credentials`, `x-request-id`, `ETag`; Next answers with cache headers only. No `Content-Security-Policy`, no `X-Content-Type-Options`, no `X-Frame-Options`/`frame-ancestors`, no `Referrer-Policy`, no HSTS. Headers exist **only** in `apps/web/vercel.json`, so the protection depends on which host you deploy to | `apps/api/src/main.ts`, `apps/web/next.config.ts:110` | clickjacking, MIME sniffing, and any future XSS is unfettered; local/self-hosted deployments have none of it | `helmet` on the API (CSP `default-src 'none'` — it serves JSON only), `headers()` in `next.config.ts` for CSP + nosniff + frame-ancestors + Referrer-Policy, plus HSTS when `NODE_ENV=production` |
| S2 | **MEDIUM** | **Rate limiting is opt-in.** `RateLimitGuard` is global but no-ops without `@RateLimit()`. 16 mutating routes have no budget: `POST /api/jobs/:id/retry`, `POST /api/publishing/jobs`, `POST /api/publishing/:id/retry`, `PATCH /api/clips/:id/metadata`, `PUT /api/configuration`, `POST /api/brand-profiles`, `POST /api/subtitle-presets`, `PUT /api/auth/security/otp-mode`, `POST /api/auth/security/telegram/link/start`, `/link/complete`, `/unlink`, `DELETE /api/auth/security/sessions[/:id]`, `POST /api/auth/security/sessions/revoke-all`, `DELETE /api/accounts/:id`, `POST /api/accounts/youtube/select-channel` | `common/guards/rate-limit.guard.ts:13-14` (`if (!options) return true;`) | a stolen cookie can loop expensive work (re-renders, publishes, config writes) or brute-force the Telegram link code | default budget per session (e.g. 120/min) when no decorator is present; keep the explicit limits as overrides |
| S3 | **MEDIUM** | **Password reset accepts a weaker password than registration.** Register/bootstrap: ≥12 chars + upper + lower + digit (`packages/validation/src/index.ts:7`). Reset and recovery redemption: ≥10 chars, no complexity (`apps/api/src/auth/security.controller.ts:24`) | both files | an attacker with a reset code can leave the account weaker than policy allows | one exported `passwordSchema`, used everywhere a hash is written |
| S4 | **MEDIUM** | **OpenAPI document is anonymous.** `GET /api/docs/openapi.json` → 200 without a session | `main.ts:70` | full endpoint/method inventory, including admin routes, is public — reconnaissance aid | serve only when `NODE_ENV !== 'production'`, or mount behind the admin guard |
| S5 | **LOW** | **Lint is skipped during the production build** — `eslint: { ignoreDuringBuilds: true }` | `next.config.ts:113` | a rule that catches a real bug (e.g. `no-dangerous-html`, hook deps) cannot fail a deploy | remove the flag; keep `npm run lint` in CI |
| S6 | **LOW** | **Telegram link code shares the OTP attempt model but not a dedicated budget**: `link/start` and `link/complete` are unlimited (S2 covers the fix) and a 6-digit code with 5 attempts per challenge is fine, but an unlimited rate of fresh challenges widens the guess window | `security.controller.ts` | — | included in S2's default budget |
| S7 | **LOW** | **No explicit outbound timeout ceiling** for platform connectors beyond per-call `AbortSignal` | `packages/platform-connectors` | a stalled TLS read can hold a worker slot | wrap provider calls in a `Promise.race` timeout |
| S8 | **INFO** | **`trust proxy` is hardcoded to 1 hop** | `main.ts:20` | correct behind one proxy (Vercel/Render); wrong behind two, which would corrupt IP-based fraud signals | make it `TRUST_PROXY` configurable |
| S9 | **INFO** | **Suspicious-login detection is heuristic** (new IP **and** new device vs 30-day successes) | `security.service.ts:482` | a travelling attacker reusing one device is not flagged | documented limitation; enrich later with impossible-travel or ASN |
| S10 | **INFO** | **Session cookie `sameSite: 'lax'`** | `auth.controller.ts:26` | correct here because everything is same-origin; would need `none`+`secure` only if the API were ever cross-site | keep, re-evaluate if the topology changes |

## 3. Things that looked risky and are not

* **Firebase web config in the browser** — `apiKey`/`authDomain`/`projectId`/`appId` are public
  identifiers by design; the service-account credential never leaves the server, and the ID token is
  verified server-side with the Admin SDK.
* **Chunked upload driven by the browser** — bytes are streamed through authenticated API routes; the
  server owns the storage key, validates the mime from `ffprobe` output (not the client's claim), and
  enforces size/duration from workspace configuration.
* **CSRF token in a JS module variable** — it is a double-submit token tied to the session, useful only
  to the holder of the cookie, and the cookie is httpOnly.
* **`request.ip` used for device history and rate limits** — safe behind a single trusted proxy; see S8.

## 4. Security regression tests that must keep passing

* `tests/e2e/authorization_matrix.py` — 27 checks: anonymous → 401 on 16 sensitive routes, MEMBER → 403
  on operator routes, cross-tenant ids → 404, self-registration refused with CSRF required.
* `tests/e2e/auth_security.py` — 46 checks: policy refusal for an undeliverable channel, no cookie
  before the second factor, wrong-code attempt accounting, replay refused, hashed-at-rest codes,
  reset revoking sessions, recovery-code reuse refused, uniform forgot-password response.
* `tests/unit/auth-security.test.ts` — 17 checks on code generation, hashing, masking, SMTP config,
  device labels, argon2 parameters.
* `tests/e2e/logic_probes.py` — adversarial inputs against the state machine and validation.

## 5. Priority order for the fix phase

1. S1 headers (both apps) — cheapest, widest coverage.
2. S3 one password policy — correctness with a security consequence.
3. S2 default rate limit — closes a real abuse path.
4. S4 OpenAPI gating, S5 lint flag — small, removes two "we don't notice" failure modes.
5. S7/S8 hardening — worker stability and correct client-IP signals.
