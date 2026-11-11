# Upgrade plan — 17 modules, implementation order and honest status

This file is the contract for the upgrade: **what is implemented and verified**, what is partially
implemented, and what is not started. A module is only marked **DONE** when it runs on the local
stack and its behaviour has been checked by a test that exercises it. "Code exists" is not a status.

Legend: **DONE** = implemented + exercised by a test on the live stack · **PARTIAL** = some of the
module is real and tested, the rest is listed as missing · **PLANNED** = not started (no code).

Last updated: phase 2 (auth/security) complete, phase 3 not started.

| # | Module | Status | What is real today | What is missing |
|---|--------|--------|--------------------|-----------------|
| 1 | Auth & security | **PARTIAL → phase 2 done** | Password + argon2id, Google/Firebase login, email/Telegram/dual OTP with step-up, forgot/reset password (no account enumeration), Telegram chat linking, device/session list + revoke, revoke-all, sign-in history, suspicious sign-in alert, recovery codes, RBAC guard, CSRF, rate limits | User invitations / member management (a workspace is effectively single-user; see `docs/AUTH-SECURITY.md`), WebAuthn/passkeys |
| 2 | Multi-account YouTube/Instagram + token refresh + quota | **PARTIAL** | OAuth connect/callback, encrypted token storage (AES-256-GCM), channel selection, account verify/delete, quota errors surfaced truthfully | Quota **monitoring** dashboard (usage recorded per call, not yet aggregated per day/quota %) |
| 3 | 13-stage video pipeline | **PARTIAL** | Upload → ffprobe → transcription → AI analysis → clip selection → render (9:16, subtitles, watermark, intro/outro, brand) → completion, with per-stage events and bounded retries | Face-aware crop (currently centre/letterbox modes), scene detection, licensed-music library |
| 4 | AI content generation | **PARTIAL** | Titles/descriptions/captions/hashtags/SEO come from the AI engine and are editable per platform | Thumbnail generation, hooks/ideas/scripts/calendar, quality score display, "no fake engagement guarantees" wording audit |
| 5 | Idempotent publishing | **PARTIAL** | Official APIs only, idempotency keys, status only advances on a confirmed platform response | Instagram container polling edge cases |
| 6 | Advanced scheduler | **PARTIAL** | Scheduled publishing, workspace timezone, pause/resume, missed-run detection | Calendar UI, conflict detection between scheduled slots |
| 7 | BullMQ background engine | **PARTIAL** | Queues, priorities, retries with backoff, DLQ, worker heartbeats, cancellation | Explicit per-job timeouts on every stage, poison-message quarantine report |
| 8 | Notifications (Telegram + email) | **DONE** (Telegram) / **PARTIAL** (email) | Telegram delivery with categories, history, retry, dedupe, per-workspace settings, admin-only config; `SECURITY_ALERT` category | Telegram **commands** (`/status /start /pause /resume /stop /history /help`) — no webhook exists yet, so this is documented as not implemented; email notifications beyond OTP |
| 9 | Visual workflow builder | **PLANNED** | — | Everything. Every node must have a real backend implementation; none exist yet |
| 10 | Analytics from real platform APIs | **PLANNED** | — | Views/likes/watch-time/subscribers, "unavailable" marking, CSV/PDF export |
| 11 | AI provider abstraction | **PARTIAL** | Provider calls isolated behind the AI engine service; failures are explicit (`GEMINI_API_KEY is not configured`) | Provider-swap interface, local/free model fallback |
| 12 | Admin dashboard | **PARTIAL** | System overview, worker/queue status, events, diagnostics, notifications panel; every admin route is server-side role-checked | Per-user admin actions, audit export |
| 13 | Reliability / self-healing | **PARTIAL** | Bounded retries, permanent-failure classification, retry resume point, DLQ; a job that cannot continue fails with a truthful reason | Automated recovery sweeps for orphaned `PROCESSING` rows |
| 14 | Premium UI upgrade | **PARTIAL** | Light-first design system, 13 pages (security page added), loading/empty/error states, no decorative dead buttons | Analytics/calendar/AI-studio pages, PDF export UI |
| 15 | DB models, constraints, migrations, encryption | **DONE** (for what exists) | Unique constraints, indexes, migrations via `migrate diff`, OAuth tokens encrypted, OTP/recovery codes hashed (HMAC / sha256), sessions hashed | Models for modules 9/10 do not exist yet |
| 16 | Real tests | **DONE** (for what exists) | Unit 97, integration 41, authorization matrix 27, Telegram E2E 36, auth/security E2E 46 — all on the live stack, mocks only in unit tests | Tests for modules 9/10 will come with them |
| 17 | Phased delivery + docs | **DONE** | This file + `docs/AUTH-SECURITY.md` + updated index/testing docs; tests re-run after each phase | — |

## Phase log

| Phase | Scope | Result |
|-------|-------|--------|
| 0 | Audit of the existing codebase before writing anything | 5 files in `apps/api/src/auth`, no OTP/login-event/recovery models, `nodemailer` installed but unimported, no analytics or workflow models |
| 1 | Telegram notification system (module 8) | `df7e5fc` — unit 20, integration 19, E2E 36 |
| 2 | Auth & security (module 1, and the model work for module 15) | This commit — see the feature list and test results below |

## Phase 2 — what actually changed

New database objects (migration `20261111080000_otp_security`, `20261111081500_security_audit_events`,
`20261111083000_user_otp_fields`):

* Enums `OtpChannel`, `OtpPurpose`, `OtpMode {OFF, EMAIL, TELEGRAM, DUAL}`, `LoginOutcome`,
  `LoginMethod`; new `AuditAction` values; notification category `SECURITY_ALERT`.
* `OtpChallenge` (hashed code, attempts, expiry, delivery error), `LoginEvent`, `RecoveryCode`.
* `User.otpMode` (default **OFF**), `User.telegramChatId`, `User.telegramLinkedAt`,
  `Session.deviceLabel`.

New API surface under `/api/auth/security` (13 routes) plus a changed `POST /api/auth/login` that
returns challenges instead of a session when a second factor is required.

Two pre-existing defects were found by this work and fixed, because the feature could not be built on
top of them:

* **CSRF tokens rotated on every read.** `GET /api/auth/session` re-issued the token, so two browser
  tabs (or a reload racing a request) invalidated each other and produced spurious `403 CSRF_FAILED`.
  The token is now derived from the session id with `SESSION_SECRET` — stable, still unforgeable, and
  old rows keep verifying through the stored hash so a deploy does not sign everyone out.
* **Session issuing existed in two places** (`AuthService.issueSession` and a copy inside the new
  security service). Consolidated into `SessionService.issue()`; there is now one definition of what
  a freshly signed-in user receives.

Also fixed while testing: `PATCH /api/clips/None/metadata` returned **500** for a non-UUID id; clip
routes now validate the id and answer **404**.

## Verification run for phase 2 (local stack, 2026-11-11)

| Suite | Result |
|---|---|
| `npm run typecheck` / `npm run lint` / `scripts/check-structure.sh` | pass / pass / 79 checks, 0 failed |
| `npm run build` (api + web + packages) | pass |
| `npm run test:unit` | **97/97** (17 new security unit tests) |
| `npm run test:integration` | **41/41** |
| `tests/e2e/authorization_matrix.py` | **27/27** |
| `tests/e2e/telegram_notifications.py` | **36/36** |
| `tests/e2e/run_auth_security.sh` | **46/46** (real SMTP sink) |
| `tests/e2e/full_workflow.py` | **blocked**: reaches `AI_ANALYSIS`, then fails with `GEMINI_API_KEY is not configured` |

The full-workflow suite cannot finish on this machine because no AI provider key is configured — the
pipeline refuses to invent an analysis (`docs/ADD-API-KEYS.md` explains how to add the key later; the
same job then continues). Two related notes from that run: the tests needed a speech-bearing fixture
(`/home/user/testdata/speech-source.mp4`, generated with ffmpeg's `flite` filter) because the older
sythetic fixture is silent and is now rejected by design, and the cancel scenario in the Telegram suite
was hardened to retry against a *live* job, since a fast-failing pipeline made the old single attempt a
race rather than a cancellation test.

## Next phase (phase 3)

Order chosen so that each step unblocks a visible, testable feature:

1. **Analytics (module 10)** — models for per-clip metrics snapshots pulled from the platform APIs,
   "unavailable" marking, CSV/PDF export. Blocked on nothing.
2. **Scheduler calendar + conflicts (module 6)**.
3. **AI content generation completion (module 4)** — thumbnails, hooks, quality score.
4. **Workflow builder (module 9)** — last, because every node must map to a real backend action and
   most of those actions only exist once the above land.
