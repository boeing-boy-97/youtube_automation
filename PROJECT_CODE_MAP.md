# ClipForge AI — complete source map

Every file that makes up this project, with its line count and what it does. This is an index, not a copy: the code itself lives at the path shown.

**141 source files · 20,583 lines · 172 total files tracked in git**

Repository root: `/home/user/clipforge-ai` · branch `master` · HEAD `2cc82d0`


## 1. API server — `apps/api`

62 source files · 7,474 lines

| file | lines | purpose |
| --- | ---: | --- |
| `apps/api/package.json` | 52 | — |
| `apps/api/src/accounts/accounts.controller.ts` | 95 | — |
| `apps/api/src/accounts/accounts.module.ts` | 6 | — |
| `apps/api/src/accounts/accounts.service.ts` | 486 | Signed, single-use, server-stored OAuth state (Redis, 10 minute TTL). |
| `apps/api/src/app.module.ts` | 42 | — |
| `apps/api/src/auth/auth.controller.ts` | 103 | — |
| `apps/api/src/auth/auth.module.ts` | 7 | — |
| `apps/api/src/auth/auth.service.ts` | 203 | One-time administrator bootstrap. Refuses once any user exists, so there is no permanently privileged public account and |
| `apps/api/src/auth/session.service.ts` | 157 | Creates a session row; returns the raw token to be set as an httpOnly cookie. |
| `apps/api/src/clips/clips.controller.ts` | 39 | — |
| `apps/api/src/clips/clips.module.ts` | 7 | — |
| `apps/api/src/clips/clips.service.ts` | 225 | Records an explicit download intent in the audit trail. |
| `apps/api/src/common/decorators/auth.decorators.ts` | 23 | Marks a route as reachable without a session (login/register/health/callbacks). |
| `apps/api/src/common/decorators/rate-limit.decorator.ts` | 9 | — |
| `apps/api/src/common/env.ts` | 102 | Environment parsing with zod. Every value a feature needs is required explicitly; there are no silent fallbacks. Failure |
| `apps/api/src/common/filters/all-exceptions.filter.ts` | 79 | Single error shape for the whole API: { error: { code, message, details?, missingConfiguration?, requestId } } |
| `apps/api/src/common/guards/csrf.guard.ts` | 50 | Double-submit CSRF protection. The token is delivered in the session-info payload (never in a cookie readable by JS), an |
| `apps/api/src/common/guards/rate-limit.guard.ts` | 33 | Redis-backed fixed-window limiter. Per-user when authenticated, per-IP otherwise. |
| `apps/api/src/common/guards/session-auth.guard.ts` | 52 | — |
| `apps/api/src/common/interceptors/request-id.interceptor.ts` | 23 | — |
| `apps/api/src/common/prisma.service.ts` | 15 | — |
| `apps/api/src/common/services/config.service.ts` | 77 | Reads configuration and fails closed with the exact missing keys. |
| `apps/api/src/common/services/logger.service.ts` | 39 | Structured JSON logs (pino) — one line per event, machine-parseable. |
| `apps/api/src/common/services/redis.service.ts` | 37 | Redis is used for: rate limits, worker presence/heartbeats, queue metadata and short-lived caches. It is never the sourc |
| `apps/api/src/common/services/usage-cost.ts` | 114 | Unit economics for everything the pipeline spends money on. Every `UsageRecord` written to the database carries a `quant |
| `apps/api/src/jobs/jobs.controller.ts` | 45 | — |
| `apps/api/src/jobs/jobs.module.ts` | 8 | — |
| `apps/api/src/jobs/jobs.service.ts` | 304 | Manual retry: re-enters the state machine and re-enqueues a durable intent. |
| `apps/api/src/load-env.ts` | 15 | Loads .env for local/container runs. In production the platform injects real environment variables; .env is only used wh |
| `apps/api/src/main.ts` | 75 | — |
| `apps/api/src/media/media-validation.service.ts` | 129 | FFprobe-backed media validation. Never trusts the declared MIME type alone. |
| `apps/api/src/media/media.controller.ts` | 97 | Object delivery. The local storage driver exposes objects here with HTTP Range support so the dashboard can scrub video. |
| `apps/api/src/media/ssrf-guard.ts` | 158 | SSRF protection for the "import from direct URL" source path. Rules enforced before any outbound request: - scheme must  |
| `apps/api/src/publishing/publishing.controller.ts` | 55 | — |
| `apps/api/src/publishing/publishing.module.ts` | 14 | — |
| `apps/api/src/publishing/publishing.service.ts` | 377 | Enables/disables automatic publishing for one connected account. Every precondition is explicit: connected account, perm |
| `apps/api/src/queues/queue.service.ts` | 109 | BullMQ queue registry + transactional-outbox relay. Business code never enqueues directly: it writes an OutboxEvent insi |
| `apps/api/src/queues/queues.module.ts` | 7 | — |
| `apps/api/src/sources/sources.controller.ts` | 79 | — |
| `apps/api/src/sources/sources.module.ts` | 15 | — |
| `apps/api/src/sources/sources.service.ts` | 426 | Local driver only: store one part at its deterministic offset. The part number is authoritative, so retries and out-of-o |
| `apps/api/src/storage/storage.module.ts` | 6 | — |
| `apps/api/src/storage/storage.service.ts` | 309 | Object storage abstraction. `STORAGE_DRIVER` is explicit (env). There is no driver fallback: if S3 is selected but misco |
| `apps/api/src/system/dashboard.controller.ts` | 16 | — |
| `apps/api/src/system/diagnostics.controller.ts` | 23 | Diagnostics live in their own controller so the route table reads as two surfaces: `/api/system` (health, queues, events |
| `apps/api/src/system/diagnostics.service.ts` | 333 | Builds the operator diagnostics report. Thresholds are deliberately conservative and are written into the finding text,  |
| `apps/api/src/system/diagnostics.types.ts` | 64 | Diagnostics: the questions an operator actually asks when something looks wrong at 2am. - is anything stuck, and since w |
| `apps/api/src/system/system.controller.ts` | 48 | — |
| `apps/api/src/system/system.module.ts` | 14 | — |
| `apps/api/src/system/system.service.ts` | 276 | Worker presence is derived from Redis heartbeats renewed by each worker. |
| `apps/api/src/usage/usage.controller.ts` | 38 | Usage and cost reporting. Operator-only: spend per workspace is commercially sensitive and is not part of a member's job |
| `apps/api/src/usage/usage.module.ts` | 7 | — |
| `apps/api/src/usage/usage.service.ts` | 221 | Default reporting window: the last 30 days, which is what a monthly review looks at. |
| `apps/api/src/workers/base.ts` | 124 | Boots a long-lived worker process: - registers itself in Redis with a heartbeat so the admin dashboard shows real livene |
| `apps/api/src/workers/pipeline.worker.ts` | 469 | Pipeline worker — owns stages PROBING → TRANSCRIBING → AI_ANALYSIS → CLIP_SELECTION → RENDERING hand-off. Durability: ev |
| `apps/api/src/workers/publish.worker.ts` | 468 | Publishing worker — YouTube upload and Instagram Reel publication. Guarantees: - exactly one attempt per (clip, platform |
| `apps/api/src/workers/recovery.worker.ts` | 148 | Recovery worker — makes the platform survive crashes. Every 30 seconds it looks for jobs whose worker lease expired whil |
| `apps/api/src/workers/render.worker.ts` | 335 | Render worker — turns one planned clip into a real vertical MP4 with burned subtitles, stores it, and advances the job o |
| `apps/api/src/workers/scheduler.worker.ts` | 168 | Scheduler worker — the only process allowed to talk to BullMQ for dispatch. Duties: 1. drain the transactional outbox in |
| `apps/api/src/workers/services-client.ts` | 188 | Typed clients for the Python services. Every call has a timeout and surfaces the service's structured error instead of s |
| `apps/api/src/workspace/workspace.controller.ts` | 78 | Branding assets (logo overlay, intro, outro) must be *uploadable*: the render pipeline reads them from storage, so leavi |
| `apps/api/src/workspace/workspace.module.ts` | 7 | — |
| `apps/api/src/workspace/workspace.service.ts` | 198 | Stores a brand asset and returns the storage key the render pipeline will download from. The key is workspace-scoped, so |
| `apps/api/tsconfig.json` | 14 | — |

## 2. Web dashboard — `apps/web`

22 source files · 3,013 lines

| file | lines | purpose |
| --- | ---: | --- |
| `apps/web/app/accounts/page.tsx` | 272 | — |
| `apps/web/app/activity/page.tsx` | 53 | — |
| `apps/web/app/admin/page.tsx` | 142 | — |
| `apps/web/app/brand/page.tsx` | 272 | — |
| `apps/web/app/clips/page.tsx` | 305 | Per-platform metadata is editable before publishing — the API has supported PATCH since the start, so a read-only panel  |
| `apps/web/app/create/page.tsx` | 173 | — |
| `apps/web/app/globals.css` | 24 | — |
| `apps/web/app/jobs/[id]/page.tsx` | 142 | — |
| `apps/web/app/jobs/page.tsx` | 70 | — |
| `apps/web/app/layout.tsx` | 21 | — |
| `apps/web/app/login/page.tsx` | 105 | — |
| `apps/web/app/page.tsx` | 146 | — |
| `apps/web/app/publishing/page.tsx` | 107 | — |
| `apps/web/app/settings/page.tsx` | 256 | — |
| `apps/web/components/providers.tsx` | 16 | — |
| `apps/web/components/shell.tsx` | 121 | — |
| `apps/web/components/ui.tsx` | 205 | — |
| `apps/web/lib/api.ts` | 178 | Chunked upload through the API with the rights declaration sent at completion. |
| `apps/web/lib/config-schema.ts` | 61 | Field metadata only — no values. Defaults are deliberately absent: every value must be set explicitly by an operator, ma |
| `apps/web/lib/hooks.ts` | 315 | Operator surfaces (system, usage, workspace configuration, brand assets, OAuth accounts) are OWNER/ADMIN only on the API |
| `apps/web/next-env.d.ts` | 6 | — |
| `apps/web/next.config.ts` | 20 | The browser only ever talks to this Next.js origin. /api and /media are proxied to the NestJS API, so session cookies st |
| `apps/web/package.json` | 28 | — |
| `apps/web/tailwind.config.ts` | 27 | /*.{ts,tsx}', './components/* |
| `apps/web/tsconfig.json` | 10 | — |

## 3. Shared packages — `packages`

18 source files · 4,093 lines

| file | lines | purpose |
| --- | ---: | --- |
| `packages/database/package.json` | 8 | — |
| `packages/database/prisma/migrations/20261109065140_init/migration.sql` | 873 | — |
| `packages/database/prisma/migrations/20261109081312_brand_asset_audit_action/migration.sql` | 10 | — |
| `packages/database/prisma/schema.prisma` | 846 | — |
| `packages/database/src/client.ts` | 23 | Single Prisma client per process. Workers and API both use this. Connection pooling is handled by pg via the DATABASE_UR |
| `packages/database/src/config.ts` | 103 | Configuration resolution. Precedence: workspace-scoped ApplicationConfiguration row > global row. There is NO code-level |
| `packages/database/src/crypto.ts` | 78 | Cryptography helpers. - OAuth tokens are encrypted at rest with AES-256-GCM using CREDENTIAL_ENCRYPTION_KEY (32 bytes, b |
| `packages/database/src/index.ts` | 5 | — |
| `packages/database/src/outbox.ts` | 85 | Transactional outbox. The row is written inside the same transaction as the state change, so a committed business change |
| `packages/database/src/repositories.ts` | 249 | Creates the job + its initial stage row + the outbox intent atomically. Nothing is put in memory: a crash immediately af |
| `packages/database/src/seed.ts` | 122 | Seed script. Deliberately creates NO user, NO password and NO business configuration. The only rows inserted are the *ca |
| `packages/database/tsconfig.json` | 1 | — |
| `packages/platform-connectors/package.json` | 4 | — |
| `packages/platform-connectors/src/http.ts` | 116 | Shared HTTP + error classification used by every platform connector. No simulated responses: these functions only ever r |
| `packages/platform-connectors/src/index.ts` | 3 | — |
| `packages/platform-connectors/src/instagram.ts` | 216 | Instagram content publishing connector — official Meta API only. Documentation verified 2026-11-09: - Latest Graph API v |
| `packages/platform-connectors/src/youtube.ts` | 291 | YouTube Data API v3 connector. Docs (verified 2026-11-09): - videos.insert (resumable upload, 1600 quota units per uploa |
| `packages/platform-connectors/tsconfig.json` | 10 | — |
| `packages/shared-types/package.json` | 2 | — |
| `packages/shared-types/src/index.d.ts` | 279 | @clipforge/shared-types Contract shared by the API, workers and the web app. Kept dependency-free. |
| `packages/shared-types/src/index.ts` | 373 | @clipforge/shared-types Contract shared by the API, workers and the web app. Kept dependency-free. |
| `packages/shared-types/tsconfig.json` | 1 | — |
| `packages/validation/package.json` | 4 | — |
| `packages/validation/src/domain.ts` | 159 | Domain rules that both the API and workers depend on. Pure functions only — unit-tested in tests/unit. |
| `packages/validation/src/index.ts` | 262 | Usage reporting window. Defaults to the last 30 days; `from`/`to` are inclusive ISO dates so an operator can reconcile a |
| `packages/validation/tsconfig.json` | 10 | — |

## 4. Python services — `services`

17 source files · 3,362 lines

| file | lines | purpose |
| --- | ---: | --- |
| `services/ai-engine/app/__init__.py` | 1 | — |
| `services/ai-engine/app/captions.py` | 167 | Platform-specific caption/metadata generation. YouTube and Instagram get genuinely different copy (search-oriented vs. h |
| `services/ai-engine/app/config.py` | 74 | Runtime configuration for the AI engine. Nothing here has a silent default for a business-critical decision: - The AI pr |
| `services/ai-engine/app/fixture_provider.py` | 78 | TEST-ONLY analysis provider. This module exists so the pipeline can be exercised end-to-end in isolated automated test e |
| `services/ai-engine/app/gemini.py` | 148 | Gemini API client with structured output, bounded retries and schema validation. Docs (verified 2026-11-09): https://ai. |
| `services/ai-engine/app/main.py` | 177 | AI engine HTTP service. Endpoints GET /health — liveness + capability report (never claims readiness it lacks) POST /tra |
| `services/ai-engine/app/media.py` | 230 | FFmpeg / FFprobe wrappers: probing, audio extraction and resource-efficient frame sampling with scene-change detection.  |
| `services/ai-engine/app/pipeline.py` | 241 | Full analysis pipeline: inspect → extract audio → transcribe → see → understand → validate → de-duplicate → plan dual-du |
| `services/ai-engine/app/selection.py` | 566 | Highlight candidate generation, validation, scoring, de-duplication and dual-duration variant planning. Design rules enc |
| `services/ai-engine/app/transcribe.py` | 98 | Accurate transcription with word-level timestamps (faster-whisper). Timestamps come straight from the model and are neve |
| `services/ai-engine/app/vision.py` | 142 | Visual intelligence: describe representative frames with a vision model. Cost control: only frames that survived scene-d |
| `services/video-processor/app/__init__.py` | 1 | — |
| `services/video-processor/app/audio.py` | 121 | Audio analysis: loudness, true peak, silence ranges, clipping detection. All measurements come from FFmpeg's own filters |
| `services/video-processor/app/framing.py` | 238 | Intelligent vertical framing. Face detection uses OpenCV's Haar cascade (CPU-only, no model download) sampled at a fixed |
| `services/video-processor/app/main.py` | 176 | Video processor HTTP service. Endpoints GET /health — liveness + FFmpeg availability POST /probe — ffprobe inspection (u |
| `services/video-processor/app/renderer.py` | 604 | FFmpeg rendering: vertical composition, framing, burned subtitles and loudness-normalised audio. Output is verified with |
| `services/video-processor/app/subtitles.py` | 300 | Word-timed subtitle generation (ASS) with karaoke-style highlighting. The style is always an explicit user/administrator |

## 5. Tests — `tests`

15 source files · 2,319 lines

| file | lines | purpose |
| --- | ---: | --- |
| `tests/e2e/authorization_matrix.py` | 220 | Authorization matrix against a running ClipForge stack. Three questions this answers, with evidence rather than inspecti |
| `tests/e2e/full_workflow.py` | 257 | End-to-end workflow test against a running ClipForge stack. Exercises the real HTTP API and the real workers: login → co |
| `tests/e2e/harness.py` | 187 | Shared helpers for the ClipForge end-to-end suites. Both `authorization_matrix.py` and `scenarios.py` drive the live sta |
| `tests/e2e/scenarios.py` | 607 | Nineteen end-to-end scenarios against a running ClipForge stack. Each scenario answers one question an operator or revie |
| `tests/integration/database.test.ts` | 245 | Integration tests against the real PostgreSQL database. These exercise the durable primitives the workers rely on: the j |
| `tests/integration/storage.test.ts` | 89 | Integration tests for the local storage driver's byte-exact behaviour. Both cases are regressions from a real defect: ra |
| `tests/python/test_render_validation.py` | 210 | Tests for render output validation (probe + content scanning). Run with: .venv/bin/python tests/python/test_render_valid |
| `tests/unit/crypto.test.ts` | 51 | — |
| `tests/unit/diagnostics.test.ts` | 40 | — |
| `tests/unit/platform-connectors.test.ts` | 103 | — |
| `tests/unit/state-machine.test.ts` | 90 | — |
| `tests/unit/usage-cost.test.ts` | 83 | Prices are passed explicitly so the tests describe the arithmetic, not the deployment's environment. The defaults in env |
| `tests/unit/validation.test.ts` | 99 | — |
| `tests/vitest.config.ts` | 19 | — |
| `tests/vitest.integration.config.ts` | 19 | — |

## 6. Infrastructure & deployment — `infrastructure`, compose, root config

7 source files · 322 lines

| file | lines | purpose |
| --- | ---: | --- |
| `README.md` | 89 | — |
| `docker-compose.dev.yml` | 178 | — |
| `docker-compose.prod.yml` | 218 | — |
| `infrastructure/monitoring/README.md` | 25 | — |
| `infrastructure/monitoring/alerts.yml` | 38 | — |
| `infrastructure/monitoring/prometheus.yml` | 34 | — |
| `infrastructure/scripts/backup-loop.sh` | 8 | !/usr/bin/env sh |
| `infrastructure/scripts/backup-postgres.sh` | 26 | !/usr/bin/env bash |
| `infrastructure/scripts/docker-entrypoint.sh` | 9 | !/usr/bin/env sh |
| `infrastructure/scripts/healthcheck.sh` | 41 | !/usr/bin/env bash |
| `infrastructure/scripts/restore-postgres.sh` | 14 | !/usr/bin/env bash |
| `infrastructure/scripts/run-service.sh` | 18 | !/usr/bin/env bash |
| `infrastructure/scripts/verify-pipeline.py` | 206 | End-to-end verification of the AI analysis + video rendering chain. Runs against the real ai-engine and video-processor  |
| `package.json` | 46 | — |
| `tsconfig.base.json` | 22 | — |
| `tsconfig.json` | 1 | — |

## 7. Documentation — `docs`

0 source files · 0 lines

| file | lines | purpose |
| --- | ---: | --- |
| `docs/AI-PIPELINE.md` | 93 | — |
| `docs/ARCHITECTURE.md` | 87 | — |
| `docs/CONFIGURATION.md` | 79 | — |
| `docs/IMPLEMENTATION_STATUS.md` | 210 | — |
| `docs/OPERATIONS.md` | 76 | — |
| `docs/PLATFORM-SETUP.md` | 63 | — |
| `docs/TESTING.md` | 90 | — |
| `docs/VERIFICATION.md` | 152 | — |
| `docs/openapi.json` | 1 | — |

---

## How to run it

```bash
cd /home/user/clipforge-ai
npm install                      # workspace dependencies
npm run db:migrate               # Prisma migrations
bash infrastructure/scripts/run-service.sh ai-engine 8100
bash infrastructure/scripts/run-service.sh video-processor 8200
npm run dev:api                  # API on :4000
npm run dev:web                  # dashboard on :3000
npm run worker:ai                # + worker:render / publish / scheduler / recovery
npm run test:unit && npm run test:python
npm run test:e2e                 # full pipeline end to end
.venv/bin/python tests/e2e/scenarios.py   # 19 scenarios
.venv/bin/python tests/e2e/authorization_matrix.py   # 27 authz checks
```

## Where the work actually happens

| question | file |
| --- | --- |
| How is a video turned into clips? | `apps/api/src/workers/pipeline.worker.ts` (orchestration) + `services/ai-engine/app/pipeline.py` (analysis) |
| How are clips rendered? | `services/video-processor/app/renderer.py`, `framing.py`, `subtitles.py`, `audio.py` |
| How are candidates chosen? | `services/ai-engine/app/selection.py` (rubric, validation, dedup, variants) |
| How is publication done? | `apps/api/src/workers/publish.worker.ts` + `packages/platform-connectors/src/{youtube,instagram}.ts` |
| Where is the data model? | `packages/database/prisma/schema.prisma` (34 models) |
| Where is auth/session/CSRF? | `apps/api/src/auth/`, `apps/api/src/common/guards/` |
| Where is cost accounting? | `apps/api/src/common/services/usage-cost.ts`, `apps/api/src/usage/` |
| Where are the 19 end-to-end scenarios? | `tests/e2e/scenarios.py` |
