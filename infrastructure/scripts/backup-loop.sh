#!/usr/bin/env sh
# Container entrypoint for the `backup` service: one backup at startup, then daily.
set -eu
INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
while true; do
  /scripts/backup-postgres.sh "${BACKUP_DIR:-/backups}" || echo "backup failed at $(date -u +%FT%TZ)" >&2
  sleep "$INTERVAL_SECONDS"
done
