# `apps/api` — backend API and workers

NestJS application. It owns the domain, the database, and every queue. Nothing else writes to
PostgreSQL.

## Layout

```
src/
├── main.ts                 bootstrap: pino logger, request ids, cookies, Swagger at /api/docs
├── app.module.ts           module registry + global guards (rate limit → session → CSRF)
├── auth/                   login, logout, sessions, CSRF issuing, Argon2id hashing
├── jobs/                   processing jobs: create, list, cancel, retry, stage timeline
├── sources/                chunked upload (initiate/part/complete), URL import with SSRF guard
├── clips/                  clip list/detail, per-platform metadata, download registration
├── publishing/             enable/disable auto-publish, publish jobs, history, retry
├── accounts/               OAuth connect/callback/verify/disconnect (tokens encrypted at rest)
├── media/                  Range-capable object streaming + the public 0.2 s probe asset
├── workspace/              configuration writes, brand profiles, assets, subtitle presets
├── usage/                  cost ledger: summary, daily series, raw records
├── system/                 health, readiness, queues, diagnostics (actionable findings)
├── queues/                 BullMQ queue registry and depth reporting
├── storage/                local + S3 drivers behind one interface
├── common/                 env (zod), guards, decorators, filters, interceptors, services
└── workers/                pipeline | render | publish | scheduler | recovery (+ base, clients)
```

## Commands

```bash
npm run dev:api        -w @clipforge/api   # tsx watch
npm run build          -w @clipforge/api
npm run worker:ai      -w @clipforge/api   # and render | publish | scheduler | recovery
```

## Rules

* Controllers parse input with a zod schema from `@clipforge/validation`, then call a service.
* Every query is scoped by `workspaceId` from the session — never from the request body.
* Operator-only routes carry `@Roles('OWNER', 'ADMIN')`; add them deliberately, not by accident.
* Long work never happens in a request. It becomes a durable job + an outbox event.
