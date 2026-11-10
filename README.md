# ClipForge AI

Production-grade AI video repurposing and automatic social publishing: a long-form source video
becomes AI-selected vertical clips (15 s and 30 s, burned-in captions) that are published to
YouTube Shorts and Instagram Reels on an explicit, auditable schedule.

Everything in this repository is real functionality — there are no mocked endpoints, no seeded
"demo" analytics and no simulated uploads. Where a third-party credential is missing, the
integration is built, the configuration flow is real, and the feature reports
**awaiting credentials** (HTTP 428 `CONFIGURATION_REQUIRED` for the affected operation) instead of
pretending to work.

## Layout

A monorepo with six top-level areas. Every folder has its own README explaining what belongs in it.

```
apps/api                 NestJS API + 5 worker roles (pipeline, render, publish, scheduler, recovery)
apps/web                 Next.js 15 dashboard (10 pages, operator-aware)
packages/database        Prisma schema (34 models), repositories, job transitions, outbox, crypto
packages/shared-types    Job state machine, config keys, enums, DTO shapes
packages/validation      Zod schemas shared by the API and the dashboard
packages/platform-connectors  YouTube Data API v3 + Instagram Graph API clients, error classification
services/ai-engine       FastAPI: Whisper transcription, frame sampling, Gemini analysis, selection
services/video-processor FastAPI: FFmpeg framing, subtitles, loudness, 9:16 render + content validation
tests                    unit (vitest) · integration (vitest + Postgres) · python · e2e (live stack)
infrastructure           Dockerfiles, compose, Caddy, backups, run/health scripts
scripts                  developer automation (not shipped)
docs                     architecture, configuration, AI pipeline, platform setup, operations, testing
```

Read next: [`docs/FOLDER-STRUCTURE.md`](docs/FOLDER-STRUCTURE.md) (tree + "where does this file go?")
and [`docs/CODE-MAP.md`](docs/CODE-MAP.md) (every file, with line counts and purpose).

## What it does

1. **Ingest** — chunked upload to object storage, or a direct-URL import with SSRF protection.
   FFprobe validates mime/signature/duration/resolution/codecs/audio. A rights declaration is
   mandatory and audited. YouTube URLs are accepted as *reference metadata only*; nothing is
   scraped or downloaded.
2. **Analyse** — FFprobe → FFmpeg audio extraction → Faster-Whisper word-level timestamps →
   frame sampling → Gemini structured analysis → validated highlight candidates.
3. **Select** — timestamp reconciliation against the transcript, sentence/word-aware boundaries,
   a documented nine-factor scoring rubric, duplicate suppression, and an emergent clip count
   (never a padded target). 15 s variants exist only where they are coherent on their own.
4. **Render** — 1080×1920 H.264/AAC, explicit framing mode with an explicit configured fallback,
   word-highlight captions from a workspace subtitle preset, branding, −14 LUFS loudness target.
5. **Publish** — a job per platform with idempotency keys, ambiguity reconciliation, jittered
   exponential backoff, retryable/permanent classification, token refresh and full audit history.

## Quickstart (development)

Requirements: Node 20.20+, Python 3.13, PostgreSQL 17, Redis 7, FFmpeg 7.

```bash
cp .env.example .env                 # then fill in every REQUIRED value — nothing is defaulted
npm install
npm run db:generate && npm run db:migrate
npm run build                        # shared packages + api
npm run dev:api                      # http://localhost:4000  (Swagger at /api/docs)
npm run dev:web                      # http://localhost:3000
.venv/bin/uvicorn app.main:app --app-dir services/ai-engine --port 8100
.venv/bin/uvicorn app.main:app --app-dir services/video-processor --port 8200
bash apps/api/scripts/run-workers.sh             # all five roles, with per-role restart/backoff
```

The end-to-end suites need real media. Generate it offline (no downloads) with
`bash scripts/make-testdata.sh /home/user/testdata` — it narrates
`tests/fixtures/speech-script.txt` with `espeak-ng` and muxes the speech onto a moving test pattern,
because the pipeline (correctly) refuses to invent highlights from silent video.

First run: open `/login` → **First-run setup** and create the owner with `ADMIN_BOOTSTRAP_TOKEN`.
There is no seeded user and no default password.

Or run the whole stack in containers: `docker compose -f docker-compose.dev.yml up --build`
(see `docs/OPERATIONS.md`; only Caddy publishes ports in production).

## Quality gates

| Gate | Command | Last result |
| --- | --- | --- |
| Typecheck (6 workspaces) | `npx tsc -p <workspace>/tsconfig.json --noEmit` | clean |
| Unit tests | `npm run test:unit` | 54 passed |
| Integration tests (real Postgres + Redis) | `npm run test:integration` | 14 passed |
| Renderer logic (Python) | `.venv/bin/python tests/python/test_render_validation.py` | 13 passed |
| End-to-end scenarios (HTTP) | `.venv/bin/python tests/e2e/scenarios.py <video>` | 45/45 checks, 19 scenarios |
| Authorization matrix | `.venv/bin/python tests/e2e/authorization_matrix.py` | 27/27 |
| Logic probes (adversarial) | `.venv/bin/python tests/e2e/logic_probes.py` | 40/40 |
| End-to-end workflow (single journey) | `.venv/bin/python tests/e2e/full_workflow.py <video>` | PASSED |
| Browser UI audit (5 viewports × 10 routes) | `python3 tests/e2e/ui_responsive.py` | 165 checks, 0 failures |
| Service smoke test | `bash infrastructure/scripts/healthcheck.sh` | all healthy |

`npm audit` findings and their triage live in `docs/SECURITY-NOTES.md`; nothing is silently accepted.

Deployment: `docs/DEPLOY-VERCEL.md` — the dashboard runs on Vercel; the API, the five workers and
both Python services run as containers (Render blueprint included), because serverless functions
cannot host queue consumers or FFmpeg. Ship the dashboard with:

```bash
./scripts/deploy-vercel.sh https://your-api-host        # preflight + exact Vercel settings
```

A deployed dashboard never hides a broken backend: `https://<app>/healthz` reports the API origin it
was built against and probes it, `/admin` shows the same link, and with the API unreachable the app
says *that* instead of pretending you are logged out.

`docs/VERIFICATION.md` records exactly what was executed, what passed, what is blocked on
third-party credentials, and the known limitations. The dashboard is responsive by construction —
drawer navigation below `lg`, a bottom bar on phones, card lists instead of wide tables on small
screens — and that is enforced by the browser audit rather than by review.

## Status of external integrations

| Integration | Code | Live verification |
| --- | --- | --- |
| Gemini (analysis + metadata) | implemented | **awaiting credentials** — runs use the deterministic fixture provider with `TEST_MODE=1` |
| YouTube Data API v3 | implemented | **awaiting credentials** |
| Instagram Graph API (v27.0) | implemented | **awaiting credentials** |
| S3 / Cloudflare R2 | implemented | local filesystem driver verified |

No cloud deployment is claimed: the compose stack is authored and validated, but this sandbox has
no Docker daemon, so the verified environment is the local process stack described above.
