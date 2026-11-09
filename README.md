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

```
apps/web                 Next.js 15 dashboard (light premium UI, 10 pages)
apps/api                 NestJS API + 5 worker roles (pipeline, render, publish, scheduler, recovery)
packages/database        Prisma schema (24 entities), repositories, configuration, crypto, outbox
packages/shared-types    Job state machine, error model, config keys, DTO shapes
packages/validation      Zod schemas shared by the API and the UI
packages/platform-connectors  YouTube Data API v3 + Instagram Graph API connectors, error classification
services/ai-engine       FastAPI: Whisper transcription, frame sampling, Gemini structured analysis, selection
services/video-processor FastAPI: FFmpeg framing, subtitles, loudness analysis, 9:16 render
infrastructure           Dockerfiles, compose (dev/prod), Caddy/Nginx, backups, monitoring, scripts
tests                    unit (vitest), integration (vitest + real Postgres), e2e (python HTTP harness)
docs                     architecture, configuration, AI pipeline, platform setup, operations, testing, verification
```

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
node apps/api/dist/workers/pipeline.worker.js   # plus render/publish/scheduler/recovery
```

First run: open `/login` → **First-run setup** and create the owner with `ADMIN_BOOTSTRAP_TOKEN`.
There is no seeded user and no default password.

Or run the whole stack in containers: `docker compose -f docker-compose.dev.yml up --build`
(see `docs/OPERATIONS.md`; only Caddy publishes ports in production).

## Quality gates

| Gate | Command | Last result |
| --- | --- | --- |
| Unit tests | `npm run test:unit` | 37 passed |
| Integration tests (real Postgres) | `npm run test:integration` | 10 passed |
| End-to-end workflow (HTTP) | `.venv/bin/python tests/e2e/full_workflow.py <video>` | PASSED |
| Service smoke test | `bash infrastructure/scripts/healthcheck.sh` | all healthy |

`docs/VERIFICATION.md` records exactly what was executed, what passed, what is blocked on
third-party credentials, and the known limitations.

## Status of external integrations

| Integration | Code | Live verification |
| --- | --- | --- |
| Gemini (analysis + metadata) | implemented | **awaiting credentials** — runs use the deterministic fixture provider with `TEST_MODE=1` |
| YouTube Data API v3 | implemented | **awaiting credentials** |
| Instagram Graph API (v27.0) | implemented | **awaiting credentials** |
| S3 / Cloudflare R2 | implemented | local filesystem driver verified |

No cloud deployment is claimed: the compose stack is authored and validated, but this sandbox has
no Docker daemon, so the verified environment is the local process stack described above.
