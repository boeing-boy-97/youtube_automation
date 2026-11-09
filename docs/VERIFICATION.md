# Verification report

Date: **2026-11-09** (Asia/Kolkata). Environment: single-node Linux sandbox — PostgreSQL 17.11,
Redis 7, Node 20.20.2, Python 3.13.16, FFmpeg 7.1.5. Nothing below is projected or estimated: every
result is a command that was executed and its actual output.

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

| Suite | Command | Result |
| --- | --- | --- |
| Unit | `npm run test:unit` | **37 passed**, 4 files |
| Integration (real PostgreSQL) | `npm run test:integration` | **10 passed** |
| End-to-end (HTTP) | `.venv/bin/python tests/e2e/full_workflow.py /home/user/testdata/light-source.mp4` | **E2E PASSED** (job `ca03f0af-42bc-4a3b-ad4a-b9828eb00199`, 2 clips) |
| Health smoke | `bash infrastructure/scripts/healthcheck.sh` | all healthy |
| Renderer branding | direct `render_clip` call with intro/outro | 10.21 s, intro+outro applied |
| Backup/restore | `backup-postgres.sh` + `restore-postgres.sh` | dump verified, restore verified |

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
npm run test:unit && npm run test:integration
bash infrastructure/scripts/healthcheck.sh
.venv/bin/python tests/e2e/full_workflow.py /home/user/testdata/light-source.mp4
npm run openapi:export
```
