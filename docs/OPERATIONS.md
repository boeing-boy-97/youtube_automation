# Operations

## Deployment topology

`docker-compose.prod.yml` runs: `postgres`, `redis`, `api`, five worker roles, `ai-engine`,
`video-processor`, `web`, `caddy`, `backup`. Only Caddy publishes ports (80/443); every application
port stays on the internal network.

```bash
# production
cp .env.example .env                 # fill every required value; compose refuses to start otherwise
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec api node node_modules/prisma/build/index.js migrate deploy --schema packages/database/prisma/schema.prisma
```

`api` starts with `RUN_MIGRATIONS=1`, so the entrypoint applies pending migrations once before the
process starts; workers wait on the API.

Caddy terminates TLS with automatic ACME for `CLIPFORGE_DOMAIN` and proxies `/api` and `/media` to
the API and everything else to Next.js, keeping cookies first-party. `infrastructure/deployment/nginx.conf`
is the equivalent configuration if you standardise on nginx.

## Health

* `GET /api/system/health` — dependency checks (PostgreSQL, Redis, storage, AI engine, video
  processor).
* `GET /api/system/readiness` — can this instance serve work (configuration + integrations).
* `GET /api/system/overview` — the payload behind the System administration page: components,
  worker heartbeats, queue depths, counts, health events, storage driver, Graph version, uptime.
* `bash infrastructure/scripts/healthcheck.sh` — operator smoke test over all three services.

## Backups

`infrastructure/scripts/backup-postgres.sh` writes a custom-format `pg_dump` (compressed, no
ownership), a SHA-256 sidecar, verifies it with `pg_restore --list`, and prunes files older than
`BACKUP_RETENTION_DAYS`. In compose the `backup` service runs it at startup and every
`BACKUP_INTERVAL_SECONDS` (default 86400).

Restore is `infrastructure/scripts/restore-postgres.sh <dump> --yes`: it verifies the checksum and
runs `pg_restore --clean --if-exists`.

Both were executed against this environment's database: a dump was produced, restored into a
scratch database, and the restored schema contained all 30 tables with the expected row counts
(`docs/VERIFICATION.md`, run log 2026-11-09).

Object storage is *not* covered by pg_dump: back up the bucket (or the `storage-data` volume) with
the same cadence. The database stores keys, not bytes.

## Retention

The scheduler worker prunes per workspace at the configured `retention.source_days` and
`retention.asset_days`. The asset window must be longer than the window in which Meta may fetch a
Reel; shortening it below that breaks pending Instagram publishes (the API will report the failed
fetch rather than pretend it succeeded).

## Runbook

| Symptom | Check | Action |
| --- | --- | --- |
| Jobs stuck in `QUEUED` | `GET /api/system/queue-status`, worker status | Start the missing worker role; confirm Redis reachable |
| Job stuck in a stage with no progress | System administration → worker heartbeat age | If the heartbeat is stale, the recovery sweep will requeue it within 30 s |
| `RETRYING` loop | `GET /api/jobs/:id` events + `errorCode` | A `PERMANENT` platform error will not clear by retrying; fix the account/privacy/metadata |
| `NEEDS_CONFIGURATION` | Settings page → missing keys | Fill the listed keys; retry the job |
| Publish `401`/`AUTH` | Connected accounts → token health | Re-connect the account; refresh tokens are used automatically until they are revoked |
| Instagram `ERROR` container | publish job detail | Usually the media URL is not publicly reachable or the file is outside the allowed spec |
| Disk filling up | storage root usage | Lower retention windows or move to object storage |

## Upgrades

1. Back up the database.
2. Pull, `docker compose -f docker-compose.prod.yml build`.
3. `docker compose -f docker-compose.prod.yml up -d` — the entrypoint applies migrations.
4. Verify with `bash infrastructure/scripts/healthcheck.sh` and the System administration page.

Rollback is a code revert plus, when a migration is destructive, a restore from the pre-upgrade
dump.
