# Verification report

Date: **2026-11-09**, re-run **2026-11-10** after the frontend/backend hardening pass (Asia/Kolkata).
Environment: single-node Linux sandbox — PostgreSQL 17.11, Redis 7, Node 20.20.2, Python 3.13.16,
FFmpeg 7.1.5. Nothing below is projected or estimated: every result is a command that was executed
and its actual output.

> **Latest round (2026-11-10):** mobile/tablet navigation, responsive tables, accessible headings and
> tap targets, gzip + cache validators on media, orphaned-media diagnostics, a per-role worker
> supervisor, and a real browser audit (`tests/e2e/ui_responsive.py`, 165 checks × 5 viewports). The
> scoreboard at the bottom of this file is the current one.

> **Audit round note (2026-11-09):** a later independent audit re-tested this system from scratch and
> found nine defects that this report had not caught — including byte-range seeking, out-of-order
> multipart upload, the retry budget, job retry returning HTTP 500 and brand-asset upload. All were
> fixed and re-verified. Read `docs/IMPLEMENTATION_STATUS.md` for the current, authoritative status;
> where the two documents differ, that one wins.

## Deployment URL

**None.** This sandbox has no Docker daemon and no cloud account, so no public deployment exists and
none is claimed. What runs and was verified is the local process stack:

| Service | Address | State |
| --- | --- | --- |
| API (+Swagger at `/api/docs`) | `http://0.0.0.0:4000` | running |
| Dashboard (Next.js 15.5.29) | `http://0.0.0.0:3000` | running, preview available |
| AI engine (FastAPI) | `http://0.0.0.0:8100` | running — `AI_PROVIDER=fixture TEST_MODE=1` for the test suite |
| Video processor (FastAPI) | `http://0.0.0.0:8200` | running |
| Workers | pipeline / render / publish / scheduler / recovery | all 5 alive, heartbeats present |
| PostgreSQL / Redis | `127.0.0.1:5432` / `127.0.0.1:6379` | healthy |

`docker-compose.dev.yml` and `docker-compose.prod.yml` are authored and validated as YAML (11 and 13
services, every required variable demanded explicitly); they have **not** been executed here.

## Completed and verified

### Authentication and security
- First-run bootstrap with `ADMIN_BOOTSTRAP_TOKEN` (no default account, no default password),
  login/logout, DB-backed sessions, Argon2id hashing.
- CSRF double-submit enforced: an authenticated `POST /api/jobs` **without** the header returned
  `403`; the same request **with** the token returned `400` (validation, i.e. it passed the guard).
- Session cookie is HttpOnly and the proxy keeps it first-party (browser → Next.js → API).
- OAuth tokens encrypted with AES-256-GCM (unit-tested round-trip, fresh IV, tamper detection).
- Audit log written for every mutation; verified rows: `AUTH_LOGIN`, `SOURCE_UPLOADED`,
  `RIGHTS_DECLARED`, `JOB_CREATED`, `CLIP_RENDERED`, `CONFIG_CHANGED`.
- CORS allows only the explicit allow-list; the sandbox preview origin is permitted through a
  deliberate wildcard entry, verified with a real preflight-bearing request (`200`).

### Ingestion
- Chunked upload of a 26 303 712-byte file through the dashboard's own API path, FFprobe validation
  (`31.92s 1280x720 h264`), rights declaration recorded.
- Direct-URL import with SSRF protection and mandatory rights statement (validation unit-tested:
  non-HTTPS rejected, missing declaration rejected).

### AI pipeline and rendering
- End-to-end job reached `COMPLETED` with 2 clips: `QUEUED → TRANSCRIBING → AI_ANALYSIS →
  RENDERING → COMPLETED`, progress reported per stage.
- Downloaded clip re-probed: **810×1440, h264/aac, 29.82 s, 22 954 423 bytes** — 9:16, no upscaling.
- Per-platform metadata generated (YouTube title/description/hashtags/tags, Instagram
  caption/hashtags) and exposed as `DRAFT` for preview.
- Branding intro/outro path verified directly against the renderer:
  `local-storage/work/verify-branding/clip-with-branding.mp4` — **10.21 s** = 8.0 s clip + 1.2 s
  intro + 1.0 s outro, 404×720, `branding: {introApplied: true, outroApplied: true}`.
- Earlier standalone render verifications: `local-storage/work/verify-hd/clip-0-30s.mp4`
  (810×1440) and `.../verify-2/clip-0-30s.mp4` (608×1080).

### Durable processing
- Full state machine, illegal transitions rejected, stage bookkeeping closes in-flight stages
  (integration-tested against PostgreSQL).
- Worker leases: second worker refused a held lease; a released lease is not treated as abandonment;
  a stale heartbeat is; the resume point ignores control-state rows.
- Outbox: event written in the same transaction as the job, claimed exactly once with a visibility
  timeout, failure recorded without losing the event.

### Dashboard (10 pages, real data only)
Screenshots captured from the running app: `artifacts/ui/` (in-repo, e.g. `desktop-1440_.png`, `phone-390_.png`, `vercel-wrong-origin-diagnosed.png`)
(`login`, `dashboard`, `jobs`, `job-detail`, `clips`, `clip-detail`, `publishing`, `accounts`,
`brand`, `settings`, `activity`, `admin`).

Verified behaviours:
- login → session established → dashboard renders live counts (sources, clips, published,
  processing, failed), recent jobs with real stage/progress, latest clips, audit entries, and a
  health panel reading the live probes.
- Clip detail plays the **actual rendered MP4** through the API media route and shows the AI
  rationale, transcript, confidence, platform metadata and the publish panel.
- Settings wizard renders every configuration key with its current value and highlights missing
  ones; saving writes through `PUT /api/configuration` and appears in the audit log.
- Connected accounts shows YouTube/Meta as *awaiting credentials* (no fake "connected" state), and
  publishing stays disabled until explicitly enabled per account.
- System administration shows component health, worker heartbeats, queue depths and health events.
- Browser console: **no page errors** during the full navigation sweep.

### Operations
- `healthcheck.sh`: api/ai-engine/video-processor `200`, postgres + redis healthy, exit `0`.
- Backup: `backup-postgres.sh` produced a 128 KB custom-format dump with checksum and
  `pg_restore --list` verification.
- Restore: restored into a scratch database, **30 tables** and **7 `GeneratedClip` rows** present,
  then the scratch database was dropped.
- OpenAPI exported from the running API: **50 paths**, 10 tags → `docs/openapi.json`.

## Test results

Measured on 2026-11-09 against the running stack (see "Verification pass" below for the full audit):

| Suite | Command | Result |
| --- | --- | --- |
| Typecheck (all workspaces) | `npx tsc -p <ws>/tsconfig.json --noEmit` ×6 | clean (`packages/*` ×4, `apps/api`, `apps/web`) |
| Unit | `npm run test:unit` | **54 passed**, 6 files |
| Integration (real PostgreSQL + Redis) | `npm run test:integration` | **14 passed** (database 11, storage 3) |
| Python (renderer logic) | `.venv/bin/python tests/python/test_render_validation.py` | **13 passed** |
| End-to-end (HTTP, real FFmpeg renders) | `.venv/bin/python tests/e2e/scenarios.py` | **45/45 checks, 19 scenarios** |
| Authorization matrix | `.venv/bin/python tests/e2e/authorization_matrix.py` | **27/27** (also run inside scenario 18) |
| Logic probes (adversarial) | `.venv/bin/python tests/e2e/logic_probes.py` | **40/40** |
| Health smoke | `bash infrastructure/scripts/healthcheck.sh` | api / ai-engine / video-processor 200, postgres + redis healthy |
| Browser UI audit (5 viewports × 10 routes) | `python3 tests/e2e/ui_responsive.py` | **165 checks, 0 failures** |
| Python module import sweep | import all 17 modules under `services/*/app/` | clean |

## Verification pass — 2026-11-09 (code and logic audit)

A full pass over the repository, not just a test run: every workspace was type-checked, every Python
module imported, every shell script parsed with `bash -n`, every JSON/YAML file parsed, then the
suites above were executed against the live stack, and finally the core algorithms were probed
adversarially (`tests/e2e/logic_probes.py`).

### What the probes proved

| Area | Assertion (all passing) |
| --- | --- |
| Selection | rubric weights sum to exactly 1.0 over 10 factors; score bounds 0→0 / 10→100; a missing factor scores 0, not full marks; non-numeric input degrades to a number instead of raising |
| Selection | rejects `TOO_SHORT`, `INVERTED_RANGE`, `TARGET_DURATION_NOT_REQUESTED`, `BELOW_MIN_QUALITY`, `MALFORMED_TIMESTAMPS`, `NO_SPEECH_IN_WINDOW` — each with a machine-readable reason, never a crash |
| Selection | the model cannot inflate its score: claimed 100 with a rubric score of 90 is stored as 90 and the recomputation is noted on the candidate |
| Selection | boundaries are snapped to real word timings (`13.70 → 13.50`, `46.20 → 46.40`) and every snap is recorded in `validation_notes` |
| De-duplication | keeps the higher-quality of two overlapping candidates (`DUPLICATE` with the clash recorded), honours `max_clips`, keeps genuinely distinct windows |
| Variants | every derived variant stays inside its parent candidate and carries a decision record |
| Subtitles | ASS carries a valid header, every spoken word, real dialogue timings, upper-casing and the active-word highlight; an empty word list raises `ValueError` instead of emitting a blank script |
| Framing | `center_crop` centres, `manual` clamps an out-of-range offset, `background_blur` needs no crop window, an unknown mode raises `FramingError`, a missing video degrades to the configured fallback |
| Framing (live) | face tracking on a real 1280×720 talking-head clip: **6/6 sampled frames, coverage 1.00**, smoothed keyframes and a valid FFmpeg `crop_x` expression |
| State machine | illegal transitions are refused; a retry never rewinds a job to an earlier stage (see defect 1) |

### Defects found and fixed in this pass

1. **Retries rewound the job instead of resuming it (product bug).** A render failure left the job at
   `RENDERING`; the pipeline's resume path called `ensureStatus('AI_ANALYSIS')`, which issued
   `RENDERING → AI_ANALYSIS` — not an edge in the state machine. The job died with
   `PIPELINE_ERROR: Illegal job transition RENDERING -> AI_ANALYSIS`, which also *masked the real
   cause*, and a second attempt re-ran AI analysis and selection (deleting clip rows that queued
   render jobs still referenced, logged as `Clip … not found`).
   *Fix:* `ensureStatus` is now monotonic (a job already past the target stage is never dragged
   back), and a job whose resume point is at or after `RENDERING` with clips already planned goes
   straight back to rendering (`resumed at RENDERING: re-queued N of M clip(s)`). Verified: a job
   stuck at `RENDERING` with 2 clips re-entered, logged `not rewinding to AI_ANALYSIS` +
   `resumed at RENDERING`, and completed with 2 `READY` clips and **no** second analysis call.
2. **A missing brand asset failed every render (robustness bug).** A `BrandProfile` referencing a
   logo/intro/outro object that no longer exists threw a raw `ENOENT` from storage, burning every
   BullMQ attempt and failing the whole job.
   *Fix:* brand assets are resolved through a guarded helper — a missing or unreadable asset is
   skipped with a warning, the reference is preserved for the operator to repair, and the skip is
   recorded per variant in `renderProfile.skippedBrandAssets`. Verified: the same job now renders
   to `COMPLETED` and the variant records
   `["logo:…", "intro:…", "outro:…"]` as skipped.
3. **Cancelling a `FAILED` job returned HTTP 500 (product bug).** The cancel endpoint treated
   every non-completed job as cancellable, but the state machine has no `FAILED → CANCELLED` edge,
   so `IllegalTransitionError` escaped as `INTERNAL_ERROR`. *Fix:* `FAILED` is reported as
   `409 CONFLICT` ("Job is already FAILED") and any residual illegal transition is mapped to the same
   conflict; a unit test now pins the absence of that edge. Verified live: cancel a `FAILED` job →
   `409 CONFLICT`, retry the same job → `201` and the pipeline resumes from `PROBING`.
4. **ASR words were joined assuming Whisper's leading-space convention (robustness bug).** Every
   Whisper token carries the space that preceded it (`" the"`, `" quick"`), and the code relied on
   that: `"".join(words)` rebuilt the sentence. A provider that emits bare tokens would collapse a
   whole window into a single "word" — the six-word speech gate then rejected **every** candidate as
   `NO_SPEECH_IN_WINDOW`, and subtitles rendered `HELLOWORLD` with a wrong line length. *Fix:*
   `_join_words` / `join_words` join bare tokens with spaces (space-prefixed tokens are unchanged),
   used by the selector, the static subtitle line and the karaoke renderer. Verified by two new
   probes: bare tokens yield a 22-word accepted transcript and correctly spaced ASS text
   (**40/40** probes).
5. **The e2e suite aborted instead of reporting (test-harness bug).** A failed pipeline made
   scenario 10 raise `IndexError`, so scenarios 10–19 reported nothing. Each scenario now runs
   inside a guard, clip-dependent scenarios fail with the job's status and message, and the run
   always reaches a summary. The suite is green at **45/45** after the fix.

### Re-verified on a rebuilt environment

After the fixes were committed, the whole stack was rebuilt from nothing (fresh OS packages —
PostgreSQL 17.11, Redis 7, FFmpeg 7.1.5; fresh `npm install`; fresh Python venv with
`faster-whisper`; fresh database with all migrations) and the suites re-run against it:
typecheck 6/6 clean · unit **54/54** · integration **14/14** · Python **13/13** · logic probes
**40/40** · e2e scenarios **45/45** (27/27 authorization checks inside scenario 18) · real
faster-whisper transcription (`tiny.en`, 90 word timestamps) · real FFmpeg render (404×720, 9:16,
`quality.passed=true`).

`tests/e2e/scenarios.py` exit code is now a reliable gate: `0` only when every scenario passed.

## Awaiting credentials (integration built, not live-verified)

| Capability | Code | Missing to go live |
| --- | --- | --- |
| Gemini structured analysis + metadata | complete, schema-validated, fixture mode for tests | `GEMINI_API_KEY`, `GEMINI_TEXT_MODEL`, `GEMINI_VISION_MODEL` |
| YouTube Shorts upload | OAuth2 with state, channel selection, resumable upload, explicit privacy | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI` |
| Instagram Reels publish | container → status poll → `media_publish`, Graph v27.0 | `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`, `META_GRAPH_API_VERSION`, public HTTPS media URL |
| S3 / Cloudflare R2 storage | S3 SDK client + presigning | `S3_*` (endpoint, region, bucket, keys) |
| TLS + public deployment | Caddy/Nginx configs, ACME email | a host, a DNS name, a Docker-capable target |

These are labelled **BLOCKED — awaiting credentials** in `docs/TESTING.md`; the UI reports
`awaiting credentials` and the affected API calls return HTTP 428 `CONFIGURATION_REQUIRED`.

## Incomplete / known limitations

1. **No public deployment.** Compose stack authored, validated and documented but never run; no
   claim of a deployment URL.
2. **Test-suite AI provider is the fixture.** Production requires `AI_PROVIDER=gemini`; the
   fixture is deterministic, `TEST_MODE=1`-gated and every output is prefixed
   `[fixture provider — no model was called]`.
3. **Brand asset upload has no UI.** The renderer consumes logo/intro/outro assets and the API
   accepts `logoStorageKey` / `introAssetKey` / `outroAssetKey` (with validation that enabling an
   intro requires an asset), but there is no upload widget in Brand studio — assets must be placed
   in storage and the keys submitted through the API. Tracked as a UI gap, not a rendering gap.
4. **Background music is not configurable.** There is no configuration surface for it, so nothing
   is ever mixed in — which satisfies "no automatic copyrighted music" but also means an operator
   cannot attach licensed music yet. The renderer supports it if a path is supplied.
5. **Prometheus scraping of `/api/system/health` returns JSON, not exposition format.** The
   availability alerts work; per-metric time series need the exporters noted in
   `infrastructure/monitoring/README.md`.
6. **Single-node assumptions.** Local storage driver is verified end to end; the S3 path is
   code-complete but unverified. Horizontal scaling of the render worker is untested (rendering is
   CPU-bound; concurrency is deliberately 1).
7. **Rate limiting depends on Redis.** With Redis unavailable, rate-limited endpoints fail closed
   rather than silently allowing traffic — verify Redis in any production topology.
8. **Retention sweeper** deletes per the configured windows; it was exercised by configuration
   assertions, not by waiting out a multi-day window.

## Reproducing this report

```bash
# 1. static gates
for ws in packages/database packages/shared-types packages/validation packages/platform-connectors apps/api apps/web; do
  npx tsc -p "$ws/tsconfig.json" --noEmit || exit 1
done

# 2. suites
npm run test:unit && npm run test:integration
.venv/bin/python tests/python/test_render_validation.py

# 3. live stack (API :4000, AI :8100, video processor :8200, 5 workers, postgres, redis)
bash infrastructure/scripts/healthcheck.sh
.venv/bin/python tests/e2e/scenarios.py
.venv/bin/python tests/e2e/authorization_matrix.py
.venv/bin/python tests/e2e/logic_probes.py

# 4. regenerate the docs that are derived from the tree
.venv/bin/python scripts/build-code-map.py
npm run openapi:export
```

The integration suite stops the workers (it asserts queue and lease behaviour); restart them with
`node dist/workers/{pipeline,render,publish,scheduler,recovery}.worker.js` from `apps/api`.


## Verification pass — 2026-11-10 (full audit, hardened frontend and backend)

Scope: every workspace type-checked, every suite re-run against the live stack, and the dashboard
audited in a real headless Chromium at five viewports. Everything below was executed, not asserted.

### Defects found and fixed

| # | Defect | Evidence before | Fix |
| --- | --- | --- | --- |
| 1 | No navigation at all below `lg` — the sidebar is `hidden lg:flex` and nothing replaced it | phone viewport had no reachable route other than the current one | slide-over drawer + 5-slot bottom bar, focus trap, Escape/route-change close, scroll lock |
| 2 | Dashboard and clip library scrolled sideways on phones | `window.scrollX` reached 206 px at 360 px wide | `min-w-0` cards, `overflow-wrap: break-word` instead of `anywhere`, `block truncate` links |
| 3 | `/admin` and `/settings` health rows overflowed the viewport | 73 px and 48 px of horizontal scroll at 360 px | `flex-wrap` + `min-w-0` + `shrink-0` badges |
| 4 | Nine of ten pages had no `h1` (a11y and SEO) | axe-style probe reported "no h1 on page" | `Section` gained an `as` prop; every page's first section is its `h1` |
| 5 | Text-only links were 16 px tall — below the 24 px WCAG 2.5.8 target | "View all", "Details", filenames, "Manage accounts" | `inline-flex min-h-[24px]` / `block … py-1` on every such link |
| 6 | `/activity`'s page-size `<select>` had no accessible name | probe: "unlabelled field: SELECT" | explicit `aria-label` |
| 7 | Jobs and publishing forced a sideways scroll at phone widths | table cut off at `STATUS` column | real card list below `sm`, table from `sm` up; secondary columns hidden on small screens |
| 8 | A missing stored object returned **500 INTERNAL_ERROR** from the media route | `ENOENT … stat '…/30s-5768941567ae.mp4'` | `MEDIA_NOT_FOUND` 404, and the player renders an honest "Preview unavailable" state |
| 9 | Media responses carried no cache validator; every seek re-downloaded the file | no `etag`, no `cache-control` on the ranged path | strong ETag + `private, max-age=86400, immutable`, `304` verified at 0 bytes |
| 10 | No compression on JSON responses | `/api/system/overview` sent uncompressed | `compression` 1.8.2, threshold 1 KiB; gzip confirmed, video confirmed **not** re-encoded |
| 11 | `content-type` on streamed media was hard-coded `video/mp4` even for `.mov`/`.webm`/`.m4a` | — | extension → MIME map, `octet-stream` fallback |
| 12 | Workers: one role exiting killed all five | `wait -n` then shutdown | per-role restart with 2→30 s backoff and a 6-failures/5-min escalation; proven live when scenario 19 killed the render worker and it came back on its own |
| 13 | Diagnostics never looked at storage, so "clip 404s" was invisible until a user hit it | diagnostics had 6 findings, none about media | new `media.integrity` finding (bounded sample of 25 variants + 10 sources), surfaced on `/admin` |
| 14 | The E2E workflow asserted against `clips[0]` — someone else's leftover | failed with 404 when a stale clip was newest | asserts on `?jobId=<this run>` |
| 15 | Scenario 19 restarted the render worker with a bare `node`, without `.env` | timed out after 900 s | restarts it the way the stack does (`set -a && . ./.env`) |
| 16 | The E2E fixtures were not reproducible (a hard-coded `/home/user/testdata` path with no generator) | `test video not found` | `scripts/make-testdata.sh` narrates `tests/fixtures/speech-script.txt` with espeak-ng and muxes it onto a test pattern |

### Test results (2026-11-10)

| Suite | Result |
| --- | --- |
| Typecheck, 6 workspaces | clean |
| Unit (`npm run test:unit`) | **54 passed**, 6 files |
| Integration (`npm run test:integration`) | **14 passed** |
| Python renderer (`npm run test:python`) | **13 passed** |
| Workflow E2E (`tests/e2e/full_workflow.py`) | **PASSED** — upload → transcript (11 segments) → selection → render → download, 404×720 h264/aac 28.63 s, 12.1 MB verified with ffprobe |
| Scenarios (`tests/e2e/scenarios.py`) | **45/45** checks, 19 scenarios |
| Authorization matrix | **27/27** |
| Logic probes | **40/40** |
| Browser UI audit (`tests/e2e/ui_responsive.py`) | **165 checks, 0 failures** (360, 390, 768, 1024, 1440 px × 10 routes + drawer behaviour) |
| Media protocol | `200` + ETag + `cache-control: private, max-age=86400, immutable`; `304` on `If-None-Match` (0 bytes); `206` with `content-range: bytes 0-2047/12114378` |
| Compression | `content-encoding: gzip` on a large JSON body, absent on `video/mp4` (range requests must never be re-encoded) |

### Vercel-dashboard hardening (2026-11-09)

The reported defect: with the API down, the dashboard logged the user out. Root cause found by
killing the API and loading `/` — `useSession()` failed, the shell treated any failure as "not
authenticated" and rendered "Redirecting to sign in…" while the browser console showed `500`.

| # | Defect | Reproduction | Fix |
| --- | --- | --- | --- |
| 17 | A dead API looked like a logout | killed the API, loaded `/` → "Redirecting to sign in…" + console 500 | `ApiError` code `BACKEND_UNREACHABLE` for network failures, 502/503/504 **and** any 5xx without the API's `error` envelope; shell + login render a diagnosis screen instead |
| 18 | No way to tell *what* the build was pointed at | `/healthz` did not exist | new `apps/web/app/healthz/route.ts` — reports baked API origin, upstream status/latency/error, region, commit; 200 when reachable, 503 when not |
| 19 | Operators had no in-app signal | — | `/admin` → "Dashboard → API link" card, 30 s refresh |
| 20 | Deployment was multi-step and silent | — | `scripts/deploy-vercel.sh` refuses localhost/http origins, curls `/api/system/health` first, builds with that origin, then prints the two API-side env vars |

Verified in this sandbox:

| Check | Result |
| --- | --- |
| `VERCEL=1 next build` with **no** origin configured | build **succeeds** against the sentinel with a loud deployment notice; `/healthz` → `apiTarget: https://api-not-configured.invalid`, hint names both ways to set it; `/login` renders “This dashboard cannot reach its API” |
| `VERCEL=1 API_INTERNAL_URL=http://127.0.0.1:4000 next build` | rejected as a local address → sentinel + notice (a hosted build never ships pointing at localhost) |
| `VERCEL=1 API_INTERNAL_URL=https://clipforge-api.onrender.com/api/ next build` | compiles, warns that the value was normalised to `https://clipforge-api.onrender.com` |
| `VERCEL=1 API_INTERNAL_URL=https://example.onrender.com next build` | passes, `/healthz` compiled as a dynamic route |
| `GET /healthz` with the API up | `200` — `{"ok":true,…,"upstream":{"status":200,"latencyMs":18}}` |
| `GET /healthz` with the API killed | `503` — `{"ok":false,…,"upstream":{"status":null,"error":"fetch failed"}}` |
| API down, load `/` and `/login` | both render "This dashboard cannot reach its API" (+ check list, self-check button) — screenshots `artifacts/ui/api-down-{dashboard,login}.png` |
| API back up, sign in | dashboard loads, `/admin` shows the card `connected` / `200 · 21 ms`, **0 console errors** |
| `ALLOW_LOCAL_API=1 scripts/deploy-vercel.sh http://127.0.0.1:4000` | rehearsal path passes preflight + build and prints the Vercel settings |
| `scripts/deploy-vercel.sh http://127.0.0.1:4999` | stops at preflight: "did not answer… deploy the API first" |
| `scripts/deploy-vercel.sh http://localhost:4000` | stops immediately: local origins cannot be deployed |
| Suites re-run after the change | unit **54/54**, integration **14/14**, logic probes **40/40**, browser UI **165 checks / 0 failures** |

### Firebase Auth / Google sign-in (2026-11-09)

Added alongside the existing password login — never instead of it. Gate chosen because Firebase is
an identity provider, not a database: Postgres/Prisma remains the source of truth (jobs, leases,
outbox, audit), and the two new columns (`firebaseUid`, `avatarUrl`) plus a nullable `passwordHash`
are the entire schema change.

| Piece | Where | What it does |
| --- | --- | --- |
| `FirebaseService` | `apps/api/src/auth/auth.service.ts` + `firebase.service.ts` | verifies ID tokens with a service account, `checkRevoked: true`; absent config = disabled, **not** broken |
| `POST /api/auth/firebase` | `auth.controller.ts` | token → user → the same httpOnly session cookie a password login issues; rate limited 10/300 s |
| `GET /api/auth/providers` | `auth.controller.ts` | tells the login screen what exists; serves the **public** web config so Vercel needs no Firebase env |
| `resolveFirebaseUser` | `auth.service.ts` | linking/refusal rules, separated from verification so they are testable |
| Login screen | `apps/web/app/login/page.tsx`, `components/google-button.tsx`, `lib/firebase-client.ts` | split-panel layout, Google button that is disabled-with-reason until configured, per-field validation, mapped error copy; SDK loaded on demand |
| Account card | `apps/web/app/settings/page.tsx` | shows the signed-in identity, linked methods and how to link/unlink |
| Guide | `docs/FIREBASE-AUTH.md` | 9 numbered steps with exact console clicks, env block, troubleshooting table, rollback |

Verified in this sandbox (no Firebase project exists here, so the *disabled* and *misconfigured*
paths are what can be proven end to end — those are the ones that break silently):

| Check | Result |
| --- | --- |
| `GET /api/auth/providers` | `{"password":true,…,"firebase":{"enabled":false,"config":null,"error":null}}` — password honoured, Google honestly absent |
| `POST /api/auth/firebase` with an unverifiable token | `503 FIREBASE_NOT_CONFIGURED` (never a 500), message names the three env vars |
| `POST /api/auth/firebase` with a 5-char body | `400 VALIDATION_FAILED` before any verifier runs |
| Half-configured service account | API **refuses to boot**: "Firebase Auth is half-configured (FIREBASE_PROJECT_ID set)…" |
| Password login on a Google-only account (`passwordHash` null) | generic `401 UNAUTHENTICATED`, no 500, no account disclosure |
| Unit (`tests/unit/firebase-config.test.ts`) | 4 cases: disabled-is-not-broken, half-config throws, public config carries no private key, unconfigured verify → 503 |
| Integration (`tests/integration/firebase-auth.test.ts`, real DB) | **8 cases**: unknown account refused, first sign-in links to the password account (hash untouched), idempotent re-sign-in, second Google account on a linked email refused, suspended account refused, unverified email refused, email-less identity refused, provisioning creates user + workspace + OWNER membership |
| E2E (`tests/e2e/firebase_auth.py`) | **16 checks**: providers contract, token refusal, validation, session `authMethods`, Google button rendered-but-disabled with a reason, inline email validation, password sign-in still reaches the dashboard with 0 console errors, and — with an intercepted providers response — the button becomes live, the Firebase SDK loads **on demand** and its failure surfaces as "The Firebase web API key is wrong…" |
| Screens | `artifacts/ui/login-final-{desktop,mobile}.png`, `login-google-enabled.png`, `settings-account.png` |
| Layout | no horizontal overflow at 390/1440 (`scrollX=0`), first-run setup reachable on both |

Full re-run after the change: unit **58/58**, integration **22/22**, browser UI audit **165 checks /
0 failures**, `eslint .` clean, `next build` clean, `tsc` clean in all workspaces.

### Deploying the backend for a live dashboard (2026-11-09)

The deployed dashboard was working exactly as designed — honest "cannot reach its API" — because no
API existed. Making that path short was the work:

| Change | Why |
| --- | --- |
| `render.yaml` rewritten as a self-contained **free** stack: `clipforge-db` (Render Postgres) + `clipforge-redis` (Key Value) + `clipforge-api`, all wired via `fromDatabase` / `fromService` | removes the Neon + Upstash + R2 sign-ups that stood between "deployed" and "usable" |
| previous full stack preserved as `render.pipeline.yaml` | the paid path (workers, transcription, rendering) is still one rename away |
| `RUN_MIGRATIONS=1` on the API service | the image runs `prisma migrate deploy` on start, so a fresh Render database is usable without a shell |
| `apps/web/api-target.json` prefilled with `https://clipforge-api.onrender.com` | the dashboard picks up the API by editing one committed line instead of hunting Vercel settings |
| `api-target.json` is consulted **only for hosted builds** | local `npm run dev` keeps talking to the local API instead of silently proxying production |

### A live origin that is not your API (2026-11-09)

`apps/web/api-target.json` was shipped prefilled with `https://clipforge-api.onrender.com`. That host
answers — it is somebody else's service (`/api/system/health` → 404, `/api/docs` → "Atomiser API
Documentation") — so the dashboard looked *reachable* and 404'd on every route. Two changes:

| Change | Why |
| --- | --- |
| `api-target.json` ships `apiOrigin: null` again | a guessed origin is worse than none: it hid the failure |
| `/healthz` reports `identity: "clipforge" \| "other" \| "unknown"` by checking the API's own `checks` body | a 404 from a live host is indistinguishable from "down" without identifying who answered |
| `backend-down.tsx` prints that verdict and the hint | the screen now says "that host is not a ClipForge API" instead of "failed with status 404" |
| docs: Render names are global, a taken name gets a suffix | the actual cause of the wrong URL |

Verified against the real hosts: wrong origin → `ok:false, identity:"other", upstream.status:404` with
the suffix hint; correct local origin → `ok:true, identity:"clipforge"`; no origin → sentinel +
"no API origin was configured". Screenshot: `artifacts/ui/vercel-wrong-origin-diagnosed.png`.

Verified locally: `render.yaml` and `render.pipeline.yaml` parse; with `VERCEL=1` and no env var the
build reads `api-target.json` and inlines `https://clipforge-api.onrender.com` into
`CLIPFORGE_API_TARGET`; a local build ignores the file and inlines `http://127.0.0.1:4000`; the local
stack still passes UI **165/0** and `firebase_auth` **18/18**.

### Structure, flow and a clean build (2026-11-09)

The tree was audited against `docs/FOLDER-STRUCTURE.md` and then made self-checking. Three real
defects were found, all of which produced errors for anyone starting from a clean checkout:

| Defect | Symptom | Fix |
| --- | --- | --- |
| `npm run build` ran every workspace in parallel | **141 TS errors** (`Cannot find module '@clipforge/database'`) on a clean tree, because the API compiled before the packages existed | `build` = `build:packages` (shared-types → validation → platform-connectors → database) then `build:apps`; `typecheck` builds the packages first; `pretest:unit` does too |
| `docs/DOCUMENT-INDEX.md` was referenced by `FOLDER-STRUCTURE.md` but never existed | a promise the repository did not keep | written, and the checker now fails if a document is unindexed or a `docs/…` reference dangles |
| `packages/` and `docs/` had no entry README | a reader had to guess which package to open | `packages/README.md` (ownership + rules), `docs/README.md` (by intent), plus rule 2 in the checker |

Enforcement, so this cannot drift again: `scripts/check-structure.sh` (77 checks, 11 rule groups:
required areas, area READMEs, tidy root, real workspace packages, wired controllers/modules, tests
only in `tests/`, import direction, complete Python services, deployment paths, file naming,
resolving docs). Wired as `npm run verify:structure`, and `npm run verify` chains it with build,
typecheck, lint and unit tests.

Verified from an empty `dist/` and `.next/`:

| Command | Result |
| --- | --- |
| `npm run verify:structure` | **77 passed, 0 failed** — `STRUCTURE: OK` |
| `npm run build` | **rc 0, 0 TS errors** (was rc 2, 141 errors) |
| `npm run typecheck` | **rc 0, 0 errors** |
| `npm run lint` | **rc 0, 0 problems** |
| `npm run test:unit` | **7 files, 60 tests passed** |
| `npm run verify` (all of the above) | **rc 0** |
| `python3 -m compileall services` | **rc 0** |

Not verified here: `test:integration`, `test:e2e` and `test:python` need Postgres, Redis and a
`.venv`; this sandbox had neither after the workspace reset. They are covered in the rows above.

### Firebase: wiring a real project (an existing Firebase project) — 2026-11-09

The web config alone does **not** make Google sign-in work: the browser can obtain an ID token, but
only a service account lets the API verify it. That state used to be reported as a flat
`enabled: false`, which reads like "the feature is off" rather than "you are one step away". The
provider response now reports the two halves separately, and the login screen repeats the precise
message.

| Check | Result |
| --- | --- |
| `.env` with only the web config (`FIREBASE_PROJECT_ID` + `FIREBASE_WEB_*`) | API **boots** (a project id alone is a valid web-config-only deployment — the old guard would have refused) |
| `GET /api/auth/providers` | `webConfigured:true`, `verifyConfigured:false`, `enabled:false`, `error:"The browser config is set but the API has no service account…"` |
| Login screen with that config | email form works, Google button disabled, note names the service account and `docs/FIREBASE-AUTH.md step 5` |
| Split credentials (`CLIENT_EMAIL` without `PRIVATE_KEY`) | API refuses to boot: "must be set together" |
| Verifier without web config | `error:"The API can verify Google tokens but the browser has no web config…"` |
| `scripts/check-firebase.sh` against the real key | probe of `accounts:createAuthUri` returned `CONFIGURATION_NOT_FOUND` → script concludes **Firebase Authentication has never been initialised in that project** and prints the Get started path; step 2 correctly reports `webConfigured=true verifyConfigured=false enabled=false` |
| Suites after the change | unit **60/60**, integration **22/22**, `firebase_auth.py` **18/18**, UI audit **165 checks / 0 failures**, `tsc` clean, `next build` clean |

Still requires the user's Firebase project: steps 1–9 of `docs/FIREBASE-AUTH.md`. Nothing below can
be verified without real credentials — a real Google account signing in, and Firebase's own
`auth/unauthorized-domain` behaviour on the deployed domain.

### Deliberate behaviours confirmed (not bugs)

- A source with no speech fails with `ANALYSIS_REJECTED`: "Transcription produced no speech
  segments. The source may be silent or music-only, so no highlight can be identified honestly."
  The fixtures therefore contain real narrated speech.
- Rendered height never exceeds the source height (no upscaling): a 960×540 source yields a 304×540
  vertical clip, and the renderer logs the downgrade.
- `MEDIA_NOT_FOUND` rather than a 500 when a database row outlives its object.

See `docs/SECURITY-NOTES.md` for the dependency (audit) triage and the planned upgrade queue.
