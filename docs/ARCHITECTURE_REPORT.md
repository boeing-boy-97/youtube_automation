# Architecture report

Scope: the whole repository as it stands at commit `536f1c8` (master). Every statement below was
produced by reading the files named; nothing here is inferred from a README.

Sizes (measured): API 73 files / 10 748 lines · web 15 pages + 8 components + 5 lib files / 4 087
lines · Prisma 1 039 lines · video-processor 1 451 lines (Python) · ai-engine 1 935 lines (Python) ·
tests 26 files / 5 080 lines.

---

## 1. System map

```
                         ┌──────────────────────── browser ────────────────────────┐
                         │ Next.js 15 App Router (apps/web), React 19, TanStack Query │
                         │ httpOnly session cookie · no token in JS · no localStorage │
                         └───────────────┬─────────────────────────────────────────┘
                                         │ same-origin: /api/* and /media/* are Next rewrites
                                         │ (apps/web/next.config.ts:110) → nothing else is public
                         ┌───────────────▼─────────────────────────────────────────┐
                         │ NestJS API (apps/api) — session cookie + CSRF double submit │
                         │ 14 controllers · 82 routes · global guards: RateLimit,      │
                         │ SessionAuth, Csrf · AllExceptionsFilter (uniform envelope)  │
                         └──┬──────────┬───────────┬──────────────┬─────────────────┘
                            │          │           │              │
        Prisma (33 models)  │   BullMRQ │  HTTP     │   HTTP       │  HTTPS
                            │  (Redis)  │           │              │
                   ┌────────▼───┐ ┌────▼─────────┐ ┌▼────────────┐ ┌▼──────────────┐
                   │ PostgreSQL │ │ 4 queues + 5 │ │video-       │ │ ai-engine     │
                   │ + pg       │ │ worker roles │ │processor    │ │ (FastAPI)     │
                   └────────────┘ │ (separate    │ │(FastAPI,    │ │ transcribe /  │
                                  │ processes)   │ │ ffmpeg)     │ │ analyze /     │
                                  └──────────────┘ └─────────────┘ │ captions      │
                                                                   └───────────────┘
                        external: YouTube Data API + OAuth · Meta Graph (IG) · Telegram Bot API
                                  · SMTP · Firebase Auth (Google sign-in) · Gemini
```

### Layers and who owns what

| Layer | Location | Owns | Must never contain |
|---|---|---|---|
| Presentation | `apps/web/app/**`, `components/**` | rendering, input format checks, loading/empty/error states, navigation | secrets, DB access, token refresh, permission decisions |
| Transport proxy | `apps/web/next.config.ts` rewrites | same-origin proxying of `/api`, `/media` | business logic |
| HTTP edge | `apps/api/src/**/*.controller.ts` | validation (zod), status codes, RBAC decorators | SQL, provider SDK calls |
| Domain | `apps/api/src/**/*.service.ts`, `workers/**`, `queues/**` | business rules, state machines, retries, scheduling | HTTP concerns |
| Persistence | `packages/database` (Prisma + repositories + outbox) | schema, migrations, transactions, token encryption | presentation |
| Media/AI | `services/video-processor`, `services/ai-engine` | ffmpeg, probing, transcription, Gemini calls | user/session logic |
| Connectors | `packages/platform-connectors` | YouTube/IG API calls, backoff, error classification | storage of long-lived secrets in plaintext |

---

## 2. Frontend inventory

### Pages (`apps/web/app`)

| Route | File | Primary data source | Notes |
|---|---|---|---|
| `/` | `page.tsx` | `GET /api/dashboard/summary` + `/api/system/overview` | counts, recent jobs w/ live stage+progress, latest clips, activity, system health |
| `/login` | `login/page.tsx` | `/api/auth/{session,providers,csrf,login,register,bootstrap,firebase,security/otp/*}` | 4 states: login, register, first-run bootstrap, **two-step verification** (added phase 2) |
| `/create` | `create/page.tsx` | `/api/sources/upload/{initiate,part,complete}`, `/api/sources/import`, `/api/jobs` | chunked upload with real progress from XHR events |
| `/jobs` | `jobs/page.tsx` | `GET /api/jobs?pageSize=50` | list + status |
| `/jobs/[id]` | `jobs/[id]/page.tsx` | `GET /api/jobs/:id` (embeds stage events) | retry/cancel |
| `/clips` | `clips/page.tsx` | `GET /api/clips?...`, `/api/clips/:id/metadata` | duration filter, inline metadata editor |
| `/publishing` | `publishing/page.tsx` | `/api/publishing/jobs`, `/api/publishing/history`, `/api/publishing/:id/retry` | **no enable/disable toggle** (see API_CONNECTION_AUDIT) |
| `/accounts` | `accounts/page.tsx` | `/api/accounts*` | connect / verify / disconnect |
| `/brand` | `brand/page.tsx` | `/api/configuration`, `/api/brand-profiles`, `/api/brand-assets`, `/api/subtitle-presets` | brand + subtitle preset authoring |
| `/security` | `security/page.tsx` | `/api/auth/security/*` | added phase 2 |
| `/settings` | `settings/page.tsx` | `GET/PUT /api/configuration` | 25 typed config fields |
| `/activity` | `activity/page.tsx` | `GET /api/activity` | audit log |
| `/admin` | `admin/page.tsx` | `/api/system/overview`, `/api/system/diagnostics`, `/api/notifications/*` | operator-only (RBAC enforced server-side) |
| `/healthz` | `healthz/route.ts` | server route → `GET /api/system/health` | deployment self-diagnosis, names the API origin |

### Components (`apps/web/components`, 8)

`shell.tsx` (nav + session chrome), `ui.tsx` (design system: Card, Section, StatCard, Badge,
StatusBadge, ProgressBar, Field, EmptyState, ErrorState, Skeleton, Toast), `clip-player.tsx`,
`notifications-panel.tsx` (admin), `backend-down.tsx`, `google-button.tsx`, `deploy-check.tsx`,
`providers.tsx`. **All eight are referenced**; no dead component.

### Client libraries (`apps/web/lib`, 5 files / 1 051 lines)

`api.ts` (fetch wrapper: CSRF, error classification, `BACKEND_UNREACHABLE` distinction),
`hooks.ts` (39 exported hooks), `auth-messages.ts` (error copy + credential format checks),
`config-schema.ts` (25 config field descriptors), `firebase-client.ts` (lazy Google sign-in).

### Data-fetching model

TanStack Query with explicit polling intervals (10 s dashboard, 5 s active job, 8 s publishing, 10 s
system, 60 s notifications) and `staleTime: 5 min` on slow-moving queries. **No SSE/WebSocket
anywhere** — `grep EventSource|WebSocket` finds only type definitions in `node_modules`. Polling is
therefore the real-time mechanism; it is honest (progress comes from `ProcessingJob.progressPercent`)
but it is polling, not push.

---

## 3. Backend inventory

### Modules (13) — `apps/api/src`

`AuthModule` (auth + security controllers, OTP, sessions, Firebase, email), `AccountsModule`
(OAuth connect/callback/verify/disconnect), `SourcesModule` (chunked upload, URL import, ffprobe
validation), `JobsModule` (create/list/detail/cancel/retry), `ClipsModule`, `PublishingModule`
(enable/disable, jobs, history, retry), `NotificationsModule` (Telegram), `QueuesModule` (BullMQ
producer + outbox relay), `StorageModule` (local + S3), `SystemModule` (health, readiness, overview,
worker/queue status, events, diagnostics, dashboard), `UsageModule` (cost/usage reporting),
`WorkspaceModule` (configuration, brand profiles/assets, subtitle presets, activity).

### Routes

82 HTTP routes across 14 controllers (full inventory in `API_CONNECTION_AUDIT.md`). Three global
guards: `RateLimitGuard`, `SessionAuthGuard`, `CsrfGuard` (`app.module.ts:39-42`). Rate limits are
declared per route on 21 handlers in 8 controllers; the guard is a no-op when no decorator is present,
so **un-decorated mutating routes are unlimited** (listed in SECURITY_AUDIT).

### Background engine

* BullMQ queues (`queues/queue.service.ts:8`): `clipforge.pipeline`, `clipforge.render`,
  `clipforge.publish`, `clipforge.schedule`. Default job options: 3 attempts, exponential backoff
  from 5 s, `removeOnComplete` age/count caps.
* Worker roles (`apps/api/src/workers/`): `pipeline`, `render`, `publish`, `scheduler`, `recovery` —
  each its own process, launched by `apps/api/scripts/run-workers.sh` (supervises, restarts with
  backoff, escalates after N failures in a window).
* Durable hand-off: `OutboxEvent` table + relay, so an API process that dies after committing does not
  lose the queued work.
* Leases/heartbeats: `JOB_LEASE_SECONDS`, `JOB_HEARTBEAT_SECONDS`; `recovery` worker reclaims jobs whose
  lease expired.

### Integrations (external)

| Integration | Where | Credential handling |
|---|---|---|
| YouTube Data API v3 + OAuth | `packages/platform-connectors`, `accounts.service` | refresh token AES-256-GCM encrypted (`OAuthCredential`), never returned to browser |
| Meta Graph (Instagram) | same | same |
| Telegram Bot API | `notifications/telegram.client.ts` | `TELEGRAM_BOT_TOKEN` server env only; chat id masked in API responses |
| SMTP | `common/services/email.service.ts` (nodemailer) | `SMTP_*` server env only; credentials never echoed |
| Firebase Auth (Google) | `auth/firebase.service.ts` | service-account creds server-side; browser gets only the public web config from `/api/auth/providers` |
| Gemini | `services/ai-engine` | `GEMINI_API_KEY` on the AI engine |
| video-processor / ai-engine | `workers/services-client.ts` | shared API keys (`VIDEO_PROCESSOR_API_KEY`, `AI_ENGINE_API_KEY`) |

### Authentication mechanisms (inventory, all server-side)

1. Password (argon2id, OWASP parameters) + optional second factor (email / Telegram / dual) —
   `auth.service`, `security.service`.
2. Firebase ID token → ClipForge session — `auth/firebase.service.ts`, verified with the Firebase
   Admin SDK.
3. First-run bootstrap token (`ADMIN_BOOTSTRAP_TOKEN`, rate-limited 5/5 min).
4. Optional self-registration (`ALLOW_SELF_REGISTRATION`, default false).
5. Sessions: opaque token, HMAC-SHA256 at rest, httpOnly `cf_session` cookie, 7-day TTL, CSRF token
   derived from the session id.
6. Recovery codes (10, hashed) and password reset by one-time code.
7. RBAC: `UserRole` OWNER/ADMIN/MEMBER, enforced by `@Roles()` + guard on 15 handlers.

### Environment variables

76 keys validated by zod in `apps/api/src/common/env.ts` — groups: core/runtime (7), database/redis
(3), security (4), storage (11), work dirs (1), services (4), Firebase (8), Telegram (5), SMTP (6),
OTP (4), Gemini (3), YouTube/Meta (6), unit prices (8), worker concurrency/leases (4). The web app
reads **only** `API_INTERNAL_URL`, `CLIPFORGE_API_TARGET`, `VERCEL_*` (server-side); there is no
`NEXT_PUBLIC_*` secret anywhere (verified by grep, and by scanning the built bundle for known secret
patterns — see SECURITY_AUDIT).

---

## 4. Database

33 models, 25 enums, 7 migrations (`20260909…` → `20261111083000`). Notable structure:

* Tenancy: `Workspace` / `WorkspaceMember` / `User`; every workspace-scoped table carries
  `workspaceId` and is queried with it (verified by tests: cross-tenant reads return 404).
* Pipeline: `SourceVideo → ProcessingJob → JobStage → Transcript(→segments) → HighlightCandidate →
  GeneratedClip → ClipVariant` (+`ClipMetadata`, `MediaAsset`, `StorageObject`).
* Publishing: `PublishingJob → PublishingAttempt → PublishedPost`, with idempotency keys.
* Security: `Session`, `OAuthCredential`, `OtpChallenge`, `LoginEvent`, `RecoveryCode`, `AuditLog`,
  `LoginEvent`.
* Ops: `OutboxEvent`, `SystemHealthEvent`, `WebhookEvent`, `UsageRecord`, `NotificationDelivery`,
  `ApplicationConfiguration`.
* 52 `@@index`/`@@unique` declarations.

---

## 5. Deployment topology

| Artifact | Target | Notes |
|---|---|---|
| `apps/web/vercel.json` | Vercel | security headers (nosniff, Referrer-Policy, X-Frame-Options, Permissions-Policy) |
| `apps/web/next.config.ts` | any Node host | rewrites `/api`,`/media` to `API_INTERNAL_URL` frozen at build time; sentinel host when unset |
| `render.yaml` | Render Blueprint | **db + redis + api only — no worker service** (free path: queues accumulate) |
| `render.pipeline.yaml` | Render (paid) | api + `clipforge-workers` (docker, `run-workers.sh`) + video-processor + ai-engine |
| `infrastructure/docker/*` | containers | api, web, video-processor, ai-engine images |

---

## 6. What is genuinely well-built (do not regress)

1. **Server-side authorization on every admin route.** `@Roles('OWNER','ADMIN')` on system,
   diagnostics, usage, notifications, accounts, workspace writes, publishing-account control;
   verified live by `tests/e2e/authorization_matrix.py` (27/27, including member→403 and
   cross-tenant→404).
2. **No secrets reachable from the browser.** No `@clipforge/database`, `argon2`, `nodemailer`,
   `firebase-admin`, `bullmq` or `ioredis` import in the web app; bundle scan for known secrets and
   token shapes returns nothing.
3. **Honest failures.** `AllExceptionsFilter` emits one envelope (`{error:{code,message,details?,requestId}}`);
   configuration gaps return 428 with the exact missing keys rather than a generic 500; the pipeline
   refuses to fabricate AI output when `GEMINI_API_KEY` is absent.
4. **Same-origin architecture.** The browser never talks to the API host directly, so there is no
   CORS credential dance and no token in JavaScript.
5. **Durable background work.** Outbox + BullMQ + leases + a recovery role; retries are bounded and
   permanent failures are classified.
6. **Real tests at every layer** (unit 97, integration 41, five Python E2E suites) with mocks confined
   to unit tests.

## 7. Architectural problems, ranked

| # | Problem | Where | Impact |
|---|---|---|---|
| A1 | Automatic publishing cannot be turned on from the UI — `/api/publishing/enable|disable` has no caller | `apps/web/lib/hooks.ts` (absent), `publishing.controller.ts:14,23` | publishing is unreachable without curl |
| A2 | Security headers exist only in `vercel.json`; Next itself and the API send none; **no CSP anywhere** | `apps/web/next.config.ts`, `apps/api/src/main.ts` | clickjacking/XSS hardening depends on host |
| A3 | Frontend re-declares domain types and all 25 config keys instead of importing `@clipforge/shared-types` | `apps/web/lib/config-schema.ts` vs `packages/shared-types/src/index.ts` | drift: 5 keys in `shared-types` are absent from the form, 5 form keys unknown to `shared-types` |
| A4 | Password policy differs between registration (12 chars + complexity) and password reset (10 chars) | `packages/validation/src/index.ts:7` vs `apps/api/src/auth/security.controller.ts:24` | reset weakens the account |
| A5 | `usage` and `system/worker-status|queue-status|events|readiness` endpoints have no consumer; `systemOverview` duplicates three of them | `usage.controller.ts`, `system.controller.ts` | dead API surface, duplicated logic |
| A6 | `npm run worker:ai` points at `src/workers/ai.worker.ts`, which does not exist | `apps/api/package.json` | broken documented command |
| A7 | Free `render.yaml` runs no workers, so jobs queue forever | `render.yaml` | silent stall on the $0 path (needs an explicit banner) |
| A8 | OpenAPI JSON is public at `/api/docs` | `apps/api/src/main.ts:70` | endpoint inventory disclosed |
| A9 | Dashboard lacks connected accounts, upcoming schedules, notifications, worker/API status | `system.service.ts:225` | requested overview not complete |
| A10 | `eslint.ignoreDuringBuilds: true` | `apps/web/next.config.ts:113` | lint can regress unnoticed by `next build` (CI script still runs it) |

## 8. Missing capability (no code at all — must not be faked in the UI)

Analytics (platform metrics), Workflows builder, AI Studio content generation UI, publishing
calendar, user management/invites, database health, API monitoring page (beyond overview), PDF/CSV
exports, Telegram command handling. Each is listed as NOT IMPLEMENTED in `IMPLEMENTATION_PLAN.md`;
none of them gets a placeholder page or button.
