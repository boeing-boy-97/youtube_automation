# Folder structure

A single repository, six top-level areas, each with one job. The rule is that **a file belongs to
exactly one area**, and the area is chosen by *who consumes it*, not by who wrote it.

```
clipforge-ai/
├── apps/                         # things that serve a user or hold the domain
│   ├── api/                      # NestJS backend: REST API + all background workers
│   └── web/                      # Next.js dashboard (App Router)
├── services/                     # Python services that process media / call models
│   ├── ai-engine/                # transcription, vision, highlight selection
│   └── video-processor/          # FFmpeg: crop, subtitles, loudness, validation
├── packages/                     # shared libraries, imported by apps and services
│   ├── database/                 # Prisma schema, client, repositories, crypto
│   ├── shared-types/             # enums, state machine, config keys, API shapes
│   ├── validation/               # every zod request/response schema
│   └── platform-connectors/      # YouTube + Instagram clients
├── tests/                        # all test code, in four clearly separated kinds
│   ├── unit/                     # vitest, no I/O
│   ├── integration/              # vitest, real Postgres + Redis
│   ├── e2e/                      # live-stack suites (python)
│   └── python/                   # python service tests (unittest)
├── infrastructure/               # everything needed to run the system
│   ├── docker/                   # Dockerfiles per service
│   ├── deployment/               # Caddy, compose overrides
│   ├── monitoring/               # log/metric plumbing
│   └── scripts/                  # run-service, healthcheck, backup, restore
├── scripts/                      # developer automation (not shipped)
├── docs/                         # design, operations, and status documents
├── docker-compose.dev.yml        # local stack
├── docker-compose.prod.yml       # production stack
├── tsconfig.base.json            # shared TS compiler options
└── package.json                  # npm workspaces + all top-level commands
```

## Where does a new file go?

| I am adding… | it goes in | notes |
| --- | --- | --- |
| A new REST endpoint | `apps/api/src/<domain>/<domain>.controller.ts` | Register the module in `app.module.ts` |
| Business rules for that endpoint | `apps/api/src/<domain>/<domain>.service.ts` | Never put Prisma calls in controllers |
| A request/response contract | `packages/validation/src/index.ts` | One zod schema, reused by API and web |
| A background job type | `apps/api/src/workers/<name>.worker.ts` | Add the `npm run worker:<name>` script and a heartbeat |
| A shared enum or state | `packages/shared-types/src/index.ts` | Imported by both apps |
| A database table | `packages/database/prisma/schema.prisma` | Then `npm run db:migrate` |
| A model/vision/ASR call | `services/ai-engine/app/<stage>.py` | Keep prompts out of the API |
| Anything touching FFmpeg | `services/video-processor/app/<concern>.py` | One concern per module (render, framing, subtitles, audio) |
| A platform integration | `packages/platform-connectors/src/<platform>.ts` | Shared HTTP client + error classification |
| A unit test | `tests/unit/<subject>.test.ts` | Fast, no network, no database |
| A test that needs Postgres | `tests/integration/<subject>.test.ts` | Uses the real database, cleans up |
| A user-journey test | `tests/e2e/<journey>.py` | Drives the live API with real cookies/CSRF |
| A deployment change | `infrastructure/` | Not `scripts/` — that is dev-only |
| A new document | `docs/` | See `docs/DOCUMENT-INDEX.md` for the map |

## Conventions

**Naming.** Directories are lowercase and hyphenated (`video-processor`, `platform-connectors`).
TypeScript files are `kebab-case.ts` except NestJS classes, which follow `feature.controller.ts`,
`feature.service.ts`, `feature.module.ts`. Python modules are `snake_case.py`.

**Boundaries.**
* `apps/web` talks to the backend over HTTP only — it never imports `@clipforge/database`.
* `services/*` are HTTP services with a static API key; they never touch Postgres.
  The API is the only writer to the database.
* `packages/*` may depend on each other; they must not import from `apps/*`.
* Tests may import anything.

**One responsibility per file.** `renderer.py` renders, `framing.py` decides the crop,
`subtitles.py` builds the ASS file, `audio.py` measures loudness. If a module needs the word "and"
to describe it, split it.

**No generated files in git.** `dist/`, `.next/`, `node_modules/`, `.venv/`, `local-storage/`,
`*.mp4`, `*.local` are ignored. Build output is reproducible; media is test data.

**Secrets never enter the tree.** Configuration arrives through `.env` (from `.env.example`) or the
database. `.bootstrap-token.local` was removed from tracking for exactly this reason — rotate
`ADMIN_BOOTSTRAP_TOKEN` if a checkout predates that fix.

## Checking the structure

```bash
git ls-files | wc -l                    # 189 tracked files
npm run build                           # every workspace compiles
npm run test:unit && npm run test:python
.venv/bin/python tests/e2e/scenarios.py
```
