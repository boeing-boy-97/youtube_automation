#!/usr/bin/env bash
# Runs the account-security E2E suite against the local stack with a real SMTP listener.
#
# The API must be *restarted* with SMTP pointing at the sink: the email channel reports itself
# unavailable (and OTP-by-email is refused) when SMTP_HOST/SMTP_FROM are missing, which is the
# correct behaviour but would make this suite test nothing. Set SKIP_API_START=1 if you already have
# an API on :4000 configured that way.
set -euo pipefail
cd "$(dirname "$0")/../.."

SMTP_PORT="${SMTP_PORT:-1025}"
LOG="${LOG:-/tmp/api-auth-security.log}"

if [[ "${SKIP_API_START:-0}" != "1" ]]; then
  echo "[runner] restarting API with SMTP on 127.0.0.1:${SMTP_PORT}"
  pkill -f "apps/api/dist/main.js" 2>/dev/null || true
  sleep 1
  nohup setsid bash -lc "set -a && . ./.env && set +a && export \
    SMTP_HOST=127.0.0.1 SMTP_PORT=${SMTP_PORT} SMTP_SECURE=false \
    SMTP_FROM='ClipForge <no-reply@clipforge.local>' && exec node apps/api/dist/main.js" \
    > "$LOG" 2>&1 < /dev/null &
  disown || true
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null http://127.0.0.1:4000/api/auth/providers 2>/dev/null; then break; fi
    sleep 1
  done
fi

.venv/bin/python tests/e2e/auth_security.py
