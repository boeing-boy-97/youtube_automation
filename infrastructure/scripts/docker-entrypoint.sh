#!/usr/bin/env sh
# Runs pending Prisma migrations once (api role only) before starting the process.
# Workers and the API share this image; only the api service sets RUN_MIGRATIONS=1.
set -eu
if [ "${RUN_MIGRATIONS:-0}" = "1" ]; then
  echo "[entrypoint] applying database migrations"
  node node_modules/prisma/build/index.js migrate deploy --schema packages/database/prisma/schema.prisma
fi
exec "$@"
