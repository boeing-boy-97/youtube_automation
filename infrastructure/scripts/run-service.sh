#!/usr/bin/env bash
# Tiny launcher: loads .env (KEY=VALUE, '#' comments) then starts a uvicorn app.
set -euo pipefail
cd /home/user/clipforge-ai
target="$1"; port="$2"
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue;; esac
  key="${line%%=*}"; value="${line#*=}"
  case "$key" in *[!A-Z0-9_]*) continue;; esac
  # Values already present in the environment win, so a test run can override, e.g.
  # AI_PROVIDER=fixture TEST_MODE=1 for the automated end-to-end suite.
  if [ -z "${!key:-}" ]; then export "$key=$value"; fi
done < .env
if [ "$target" = "ai-engine" ]; then
  exec .venv/bin/uvicorn services.ai-engine.app.main:app --host 0.0.0.0 --port "$port"
else
  exec .venv/bin/uvicorn services.video-processor.app.main:app --host 0.0.0.0 --port "$port"
fi
