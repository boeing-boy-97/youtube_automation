#!/usr/bin/env bash
# Logical PostgreSQL backup: custom-format dump (restorable with pg_restore) + checksum.
# Usage: backup-postgres.sh [output_dir]
set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"

OUT_DIR="${1:-${BACKUP_DIR:-./infrastructure/scripts/backups}}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR"

FILE="$OUT_DIR/clipforge-$STAMP.dump"
pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$FILE"
sha256sum "$FILE" > "$FILE.sha256"

# Verify the dump is readable before declaring success.
pg_restore --list "$FILE" > /dev/null
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"

find "$OUT_DIR" -name 'clipforge-*.dump' -type f -mtime "+$RETENTION_DAYS" -delete
find "$OUT_DIR" -name 'clipforge-*.dump.sha256' -type f -mtime "+$RETENTION_DAYS" -delete
echo "pruned backups older than $RETENTION_DAYS days"
