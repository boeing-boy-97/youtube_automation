# Verification report

Date: **2026-11-09** (Asia/Kolkata). Environment: single-node Linux sandbox — PostgreSQL 17.11,
Redis 7, Node 20.20.2, Python 3.13.16, FFmpeg 7.1.5. Nothing below is projected or estimated: every
result is a command that was executed and its actual output.

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
Screenshots captured from the running app: `/home/user/screenshots/`
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
| Logic probes (adversarial) | `.venv/bin/python tests/e2e/logic_probes.py` | **38/38** |
| Health smoke | `bash infrastructure/scripts/healthcheck.sh` | api / ai-engine / video-processor 200, postgres + redis healthy |
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
4. **The e2e suite aborted instead of reporting (test-harness bug).** A failed pipeline made
   scenario 10 raise `IndexError`, so scenarios 10–19 reported nothing. Each scenario now runs
   inside a guard, clip-dependent scenarios fail with the job's status and message, and the run
   always reaches a summary. The suite is green at **45/45** after the fix.

### Re-verified on a rebuilt environment

After the fixes were committed, the whole stack was rebuilt from nothing (fresh OS packages —
PostgreSQL 17.11, Redis 7, FFmpeg 7.1.5; fresh `npm install`; fresh Python venv with
`faster-whisper`; fresh database with all migrations) and the suites re-run against it:
typecheck 6/6 clean · unit **54/54** · integration **14/14** · Python **13/13** · logic probes
**38/38** · e2e scenarios **45/45** (27/27 authorization checks inside scenario 18) · real
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
