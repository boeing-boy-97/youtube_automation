# Backend audit

`apps/api` (NestJS 10, Prisma 6, BullMQ), `services/video-processor` and `services/ai-engine`
(FastAPI). 73 TypeScript files / 10 748 lines, plus 3 386 lines of Python. Evidence is `file:line`.

## 1. Request path

```
controller (zod parse) → guard chain (RateLimit → SessionAuth → Csrf) → service → prisma / queue / provider
                                                     ↘ AllExceptionsFilter → {error:{code,message,details?,requestId}}
```

* Validation is central: `packages/validation/src/index.ts` holds every input schema; controllers call
  `.parse()` and failures become `400 VALIDATION_FAILED` with per-field `details`.
* One error envelope (`common/filters/all-exceptions.filter.ts:30-73`) including
  `428 CONFIGURATION_REQUIRED` with the exact missing keys and `SSRF_BLOCKED`.
* `RequestIdInterceptor` stamps every response; logs are structured JSON with the same id.

## 2. Modules, services, routes

| Module | Controllers | Routes | Services | Notes |
|---|---|---|---|---|
| auth | `auth`, `security` | 8 + 13 | `auth`, `session`, `firebase`, `otp`, `security`, `email` | argon2id, OTP, recovery codes, devices, RBAC |
| accounts | `accounts` | 7 | `accounts` | OAuth connect/callback/select/verify/disconnect |
| sources | `sources` | 6 | `sources`, `media-validation`, `ssrf-guard` | chunked upload, URL import (SSRF-guarded), ffprobe validation |
| jobs | `jobs` | 6 | `jobs`, `state-machine` | create/list/detail/events/cancel/retry |
| clips | `clips` | 5 | `clips` | list/detail/preview/download/metadata PATCH |
| publishing | `publishing` | 6 | `publishing` | enable/disable per account, jobs, history, retry |
| notifications | `notifications` | 5 | `notifications`, `telegram.client`, `format` | Telegram only; categories, dedupe, retry, history |
| system | `system`, `diagnostics`, `dashboard` | 8 | `system` | health, readiness, overview, workers, queues, events, diagnostics, dashboard |
| usage | `usage` | 3 | `usage` | cost model + records |
| workspace | `workspace` | 8 | configuration, brand, presets, activity | |
| media | `media` | 3 | — | authenticated media streaming + embedded probe MP4 |
| queues | — | — | `queue` | BullMQ producer + outbox relay |
| storage | — | — | `storage` | local + S3 drivers |

82 routes total; full list in `API_CONNECTION_AUDIT.md`.

## 3. Background engine

| Piece | File | Behaviour |
|---|---|---|
| Queues | `queues/queue.service.ts:8` | `pipeline`, `render`, `publish`, `schedule`; 3 attempts, exponential backoff 5 s, job retention caps |
| Durable hand-off | `OutboxEvent` + relay in `queue.service.ts` | API commit → outbox row → relay enqueues; a crash between them cannot lose work |
| Pipeline worker | `workers/pipeline.worker.ts` | stages with forward-only transitions (`job.status` never rewinds), lease + heartbeat |
| Render / publish workers | `workers/render.worker.ts`, `publish.worker.ts` | call the Python services / platform APIs, classify permanent vs transient |
| Scheduler worker | `workers/scheduler.worker.ts` | delayed publishing jobs, missed-run detection |
| Recovery worker | `workers/recovery.worker.ts` | reclaims expired leases, marks orphans |
| Supervisor | `apps/api/scripts/run-workers.sh` | one process per role, per-role restart with backoff, escalates after `WORKER_MAX_FAILURES` in `WORKER_FAILURE_WINDOW_SECONDS` |

Permanent-failure handling is explicit: a configuration error (`GEMINI_API_KEY` missing) retries a
bounded number of times and then fails the job with the true reason — observed live in this session
(`full_workflow.py`: `RETRYING ×2 → FAILED: GEMINI_API_KEY is not configured`).

## 4. Database access

* One `PrismaClient` per process (`packages/database/src/client.ts`), shared by API and workers.
* Workspace scoping is applied in services (`where: { workspaceId, … }`); cross-tenant probes in
  `authorization_matrix.py` return 404, not 403 — the correct answer, since existence must not leak.
* Transactions: publishing claims and OTP verification use conditional `updateMany` inside a
  transaction so a race cannot double-publish or double-consume a code.
* Encryption: OAuth tokens AES-256-GCM (`packages/database/src/crypto.ts`), session tokens HMAC-SHA256,
  OTP codes HMAC-SHA256, recovery codes SHA-256, passwords argon2id.
* Migrations: 7, all generated with `prisma migrate diff` and applied; no drift
  (`migrate diff --from-migrations → empty`).

## 5. Findings

### B1 — `worker:ai` script points at a file that does not exist (HIGH)
`apps/api/package.json` declares `"worker:ai": "tsx src/workers/ai.worker.ts"`. The directory holds
`pipeline.worker.ts`, `render.worker.ts`, `publish.worker.ts`, `scheduler.worker.ts`,
`recovery.worker.ts`. Anyone following the script (or a host configured with it) gets a crash loop.
The docker/Blueprint path uses `run-workers.sh` with the correct names, which is why nothing caught it.

### B2 — Duplicated system read models (MEDIUM)
`GET /api/system/overview` (`system.service.ts:183`) already returns `readiness`, `queues`, `workers`,
`counts`, `healthEvents`, storage and uptime. Four additional endpoints expose pieces of the same data
(`worker-status`, `queue-status`, `events`, `readiness`) and **nothing calls them** (verified against
the web app). Either delete them or make them the real source and slim the aggregate.

### B3 — Usage/cost reporting is write-only in practice (MEDIUM)
`UsageRecord` is populated by the workers and `UsageController` exposes
`/api/usage/{summary,daily,records}` — no consumer anywhere. Cost data exists in the database and is
invisible to the operator. This is the backing data for the missing Analytics page.

### B4 — Password policy is not defined in one place (MEDIUM)
Registration/bootstrap: 12 chars + upper/lower/digit (`packages/validation/src/index.ts:7`).
Password reset and recovery-code redemption: local 10-char schema
(`apps/api/src/auth/security.controller.ts:24`). A weaker password can be set by the recovery path.
Fix: export one `passwordSchema` and use it in every place that writes a password hash.

### B5 — Dashboard aggregate is incomplete for the requested overview (MEDIUM)
`system.service.ts:225` returns counts, platform split, variant split, 6 recent jobs, 6 recent clips,
12 activity rows. Missing: connected-account counts/health, upcoming scheduled publishes, latest
notification deliveries, worker/queue summary (only present for OWNER/ADMIN through the separate
admin-only call), API status. The dashboard page currently compensates by calling
`/api/system/overview` for operators only.

### B6 — `publishing.enable|disable` unreachable from any client (HIGH — cross-layer)
Backend contract requires an explicit enable per connected account before a publishing job is
accepted (`publishing.service.ts:157`). No caller exists. Tracked as F1 in `FRONTEND_AUDIT.md`; the
fix is frontend-side, the backend is correct.

### B7 — Rate limiting is opt-in per route (MEDIUM)
`RateLimitGuard` is global but does nothing without `@RateLimit()`. 21 handlers declare a limit;
mutating handlers without one include `POST /api/jobs/:id/retry`, `POST /api/publishing/jobs`,
`POST /api/publishing/:id/retry`, `PATCH /api/clips/:id/metadata`, `PUT /api/configuration`. A
compromised session can loop those. Fix: a safe default limit (e.g. 120/min per session) applied when
no decorator is present, with the explicit limits staying as overrides.

### B8 — No request timeout on outbound provider calls in the API process (LOW)
`TelegramClient` has `TELEGRAM_TIMEOUT_MS`; the YouTube/Meta calls in
`packages/platform-connectors` rely on `AbortSignal` per call (present) but there is no global ceiling
for a stalled TLS connection. Verified per-call signals exist; the ceiling is the gap.

### B9 — OpenAPI document is public (MEDIUM)
`SwaggerModule.setup('api/docs', …)` with no guard (`main.ts:70`) — `curl /api/docs/openapi.json`
returns 200 anonymously. Fix: expose only when `NODE_ENV !== 'production'`, or behind the admin guard.

### B10 — No worker health surface for the free tier (LOW)
`render.yaml` (free path) runs no worker service. Jobs stay `QUEUED` with no banner explaining why.
The API already knows the queue depths — the gap is communication, not code.

## 6. What the backend does well (keep)

* Every admin route is authorised server-side (15 `@Roles('OWNER','ADMIN')` declarations, verified live).
* Errors are truthful: 428 for missing configuration, `NETWORK_ERROR`/`AI_PROVIDER_ERROR` classification,
  never a fabricated success.
* Idempotency: publishing claims + `PublishAttempt` rows; notifications deduplicate on a unique key.
* Storage abstraction (local and S3) with byte-range streaming for media.
* SSRF guard resolves every DNS hop, blocks private ranges, re-validates redirects, caps bytes and time.
