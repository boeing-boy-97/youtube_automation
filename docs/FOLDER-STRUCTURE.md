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

## The flow: what actually happens

Two paths run through this structure. Everything else is a detail of one of them.

### A. A request from the browser to a row in Postgres

```
browser
  └─ apps/web/app/<page>/page.tsx          renders; calls fetch('/api/...')
       └─ apps/web/lib/api.ts              adds cookies, CSRF header, parsing, error mapping
            └─ rewrite in apps/web/next.config.ts  proxy → API origin (build-time constant)
                 └─ apps/api/src/main.ts   helmet, cookie parser, validation pipe, global prefix /api
                      ├─ SessionAuthGuard   apps/api/src/common/guards/   (who are you)
                      ├─ CsrfGuard          apps/api/src/common/guards/   (did this come from us)
                      ├─ RateLimitGuard     apps/api/src/common/guards/   (is this abusive)
                      ├─ <domain>.controller.ts   parse the request with a zod schema
                      │    └─ packages/validation  → reject before any work starts
                      ├─ <domain>.service.ts      business rules, tenancy, usage accounting
                      │    ├─ packages/database   Prisma client + transactions
                      │    └─ packages/platform-connectors  (only for publish/account work)
                      └─ response DTO             shared shape from packages/shared-types
```

Failure handling is uniform, so a page never has to guess: a thrown `HttpException` becomes
`{ statusCode, message, error }`, `apps/api/src/common/filters` logs it with the request id, and
`apps/web/lib/api.ts` turns it into either a toast or the "backend unreachable" screen
(`apps/web/components/backend-down.tsx`).

### B. A job, from upload to published clip

```
POST /api/jobs                 apps/api/src/jobs/jobs.controller.ts
  └─ jobs.service.ts           validates the source, creates Job(status=QUEUED), records usage
       └─ packages/shared-types/src  state machine: the only legal transitions live here
            └─ apps/api/src/queues/queue.service.ts   enqueue BullMQ job
                 └─ Redis (REDIS_URL)

apps/api/src/workers/pipeline.worker.ts    consumes the queue
  ├─ sources.service.ts        download the source into WORK_DIR
  ├─ services-client.ts        HTTP POST services/ai-engine  (transcribe → analyse → select)
  │    └─ services/ai-engine/app/{transcribe,vision,selection}.py
  ├─ services-client.ts        HTTP POST services/video-processor (crop, subtitles, loudness, render)
  │    └─ services/video-processor/app/{framing,subtitles,audio,renderer}.py
  ├─ storage.service.ts        write the clip via STORAGE_DRIVER (local dir or S3/R2)
  └─ Clip rows + Job(status=READY)   → the dashboard polls /api/jobs/:id and shows progress

apps/api/src/workers/render.worker.ts     re-render requests
apps/api/src/workers/publish.worker.ts    platform upload; packages/platform-connectors
apps/api/src/workers/scheduler.worker.ts  scheduled publishing
apps/api/src/workers/recovery.worker.ts   reclaim jobs whose lease expired (JOB_LEASE_SECONDS)
```

Rules that keep this honest:

* **Workers own the writes during processing.** A controller never renders media; a worker never
  answers HTTP.
* **Every stage is retryable and leased.** A crashed worker's job is picked up by
  `recovery.worker.ts` after `JOB_LEASE_SECONDS`, so no job is lost and none runs twice.
* **Progress is reported, never invented.** If a service is down, the job fails with the reason
  instead of sitting at 90%.
* **The Python services are stateless.** Files go in and come out; the API is the only writer to
  Postgres, and the only holder of credentials.

## Checking the structure

The layout is enforced, not just described:

```bash
npm run verify:structure    # bash scripts/check-structure.sh — 77 rules, exits non-zero on drift
npm run verify              # the same, plus build, typecheck, lint and unit tests
npm run build               # packages in dependency order, then apps (clean tree: 0 errors)
npm run typecheck           # builds packages first, then every workspace
npm run test:unit           # 60 tests, no I/O
```

`scripts/check-structure.sh` fails the build when a rule below is broken:

| # | Rule | Why it exists |
| --- | --- | --- |
| 1 | every required area exists | a missing `tests/fixtures` breaks suites far from where you deleted it |
| 2 | every area has a `README.md` | a directory you cannot explain in three lines is a directory that is wrong |
| 3 | the repository root holds only entry points | root clutter is how `scripts/`, `infrastructure/` and stray dumps start |
| 4 | every `packages/*` is `@clipforge/*` with `build` + `typecheck` | a package nobody can build is not shared, it is dead |
| 5 | every controller is registered in a module, every module is imported | an unregistered controller is a route that silently 404s |
| 6 | tests live only in `tests/` | two test systems in one repo means one of them stops being run |
| 7 | `apps/*` never import `apps/*` or `services/*` | sideways imports turn the tree into one entangled app |
| 8 | each Python service has `main.py`, `/health`, `requirements.txt`, snake_case modules | the health endpoint is what makes a container deployable |
| 9 | every Dockerfile referenced by compose or Render exists | a broken path is discovered at deploy time, the worst time |
| 10 | TypeScript files are kebab-case | case-insensitive filesystems make `Foo.ts`/`foo.ts` a real bug |

The old "Checking the structure" numbers (`git ls-files | wc -l`) were a snapshot, not a check —
they are replaced by the rules above.

## If you are tempted to move things

Do not reorganise this tree to look tidier. Every path is referenced by a Dockerfile, a compose
service, a Render blueprint, a test or a document; a rename costs a day and buys nothing a reader
gains from the table above. Add a directory only when it owns a concept, and delete one only when it
has no files left.
