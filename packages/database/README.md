# `packages/database` — schema, client, repositories

The only code that talks to PostgreSQL. Exports a configured Prisma client, the transactional
helpers (`transitionJob`, `writeOutbox`, `appendAuditLog`, leases) and crypto utilities.

## Layout

```
prisma/schema.prisma   data model (34 models; workspaceId is the tenant boundary)
prisma/migrations/     forward-only SQL migrations
src/index.ts           client + repository exports
src/repositories.ts    job transitions, outbox, audit log, lease helpers
src/crypto.ts          AES-256-GCM for OAuth tokens, HMAC for tokens
```

## Rules

* Every business table carries `workspaceId`; every read is scoped by it.
* State changes go through `transitionJob` so the state machine, stages, outbox and audit trail stay
  consistent — no ad-hoc `update` on `ProcessingJob.status`.
* Migrations are additive and reversible in intent; never edit an applied migration.
