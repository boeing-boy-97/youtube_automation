#!/usr/bin/env bash
# Restore a logical backup produced by backup-postgres.sh.
# Usage: restore-postgres.sh <dump-file> [--yes]
set -euo pipefail

DUMP="${1:?usage: restore-postgres.sh <dump-file> [--yes]}"
if [ "${2:-}" != "--yes" ]; then
  echo "This overwrites the objects inside database '${PGDATABASE:?PGDATABASE is required}'." >&2
  echo "Re-run with --yes to proceed." >&2
  exit 2
fi
sha256sum --check "$DUMP.sha256"
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="${PGDATABASE}" "$DUMP"
echo "restore complete from $DUMP"
