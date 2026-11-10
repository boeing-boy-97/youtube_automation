#!/usr/bin/env bash
# One command that brings the whole local stack up from whatever state it is in.
#
#   bash scripts/dev-up.sh            # build if needed, start everything
#   bash scripts/dev-up.sh --stop     # stop everything it started
#
# Generated directories (node_modules, .venv, dist, .next) are NOT part of the saved project, so a
# fresh sandbox starts without them. This script recreates only what is missing and is safe to re-run.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
LOG_DIR=/tmp
PY=.venv/bin

log() { printf '\n== %s\n' "$1"; }

stop_all() {
  for name in api ai-engine video-processor web; do
    pkill -f "$name" 2>/dev/null
  done
  ps -eo pid,args | awk '$2=="node" && $3 ~ /dist\/workers/ {print $1}' | xargs -r kill 2>/dev/null
  "$PY/pip" --version >/dev/null 2>&1 && true
  pkill -f "uvicorn services" 2>/dev/null
  pkill -f "next start" 2>/dev/null
  echo "stopped application processes (postgres/redis left running)"
}

if [ "${1:-}" = "--stop" ]; then stop_all; exit 0; fi

log "data layer"
if ! pg_isready -q 2>/dev/null; then
  sudo service postgresql start >/dev/null 2>&1 || echo "  postgres not installed — 'sudo apt-get install -y postgresql redis-server ffmpeg'"
fi
pg_isready 2>/dev/null || true
redis-cli ping >/dev/null 2>&1 || sudo redis-server --daemonize yes --port 6379 >/dev/null 2>&1 || true
redis-cli ping 2>/dev/null || echo "  redis not reachable"

log "node dependencies and build"
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund 2>&1 | tail -3
fi
[ -f node_modules/.prisma/client/index.js ] || npm run db:generate 2>&1 | tail -2
if [ ! -f apps/api/dist/main.js ]; then
  npm run build 2>&1 | tail -3
fi

log "python environment"
if [ ! -x "$PY/python" ]; then
  python3 -m venv .venv
  "$PY/pip" install -q --disable-pip-version-check \
    "fastapi==0.115.6" "uvicorn==0.34.0" "pydantic==2.10.4" "httpx==0.28.1" \
    "requests==2.32.3" "numpy==2.2.1" "opencv-python-headless==4.10.0.84" \
    "faster-whisper==1.1.1" "av==13.1.0" 2>&1 | tail -3
fi

log "database migrations"
npm run db:deploy 2>&1 | tail -2

log "services"
AI_PROVIDER="${AI_PROVIDER:-fixture}" TEST_MODE="${TEST_MODE:-1}" \
  nohup bash infrastructure/scripts/run-service.sh ai-engine 8100 > "$LOG_DIR/ai-engine.log" 2>&1 &
nohup bash infrastructure/scripts/run-service.sh video-processor 8200 > "$LOG_DIR/video-processor.log" 2>&1 &
( cd apps/api && set -a && . ../../.env && set +a && nohup node dist/main.js > "$LOG_DIR/api.log" 2>&1 & )
for worker in pipeline render publish scheduler recovery; do
  ( cd apps/api && set -a && . ../../.env && set +a \
    && nohup node "dist/workers/$worker.worker.js" >> "$LOG_DIR/w-$worker.log" 2>&1 & )
done
if [ -f apps/web/.next/BUILD_ID ]; then
  ( cd apps/web && set -a && . ../../.env && set +a && nohup npx next start -p 3000 > "$LOG_DIR/web.log" 2>&1 & )
fi

sleep 8
log "health"
for target in "API           http://127.0.0.1:4000/api/system/health" \
              "AI engine     http://127.0.0.1:8100/health" \
              "Video proc.   http://127.0.0.1:8200/health" \
              "Dashboard     http://127.0.0.1:3000/"; do
  name="${target%% *}"; url="${target##* }"
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$url")"
  printf '  %-14s %s\n' "$name" "$code"
done
printf '  %-14s %s\n' "workers" "$(ps -eo args | grep -c '[d]ist/workers')"
echo
bash scripts/check-api-keys.sh | sed -n '/What the running AI engine says/,+1p'
echo "logs: $LOG_DIR/{api,ai-engine,video-processor,web,w-*}.log"
