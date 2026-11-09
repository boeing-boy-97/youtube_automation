#!/usr/bin/env bash
# Operator smoke test: verifies every process and dependency the platform needs.
# Exit code 0 only when everything that must be up is up. Requires curl and jq.
set -uo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:4000}"
AI_BASE="${AI_BASE:-http://127.0.0.1:8100}"
VP_BASE="${VP_BASE:-http://127.0.0.1:8200}"
failures=0

check() {
  local name="$1" url="$2" expected="${3:-200}"
  local code
  code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$url" || echo 000)"
  if [ "$code" = "$expected" ]; then
    printf '  ok    %-22s %s\n' "$name" "$code"
  else
    printf '  FAIL  %-22s %s (expected %s)\n' "$name" "$code" "$expected"
    failures=$((failures + 1))
  fi
}

echo "ClipForge health"
check "api" "$API_BASE/api/system/health"
check "ai-engine" "$AI_BASE/health"
check "video-processor" "$VP_BASE/health"

if command -v jq >/dev/null 2>&1; then
  body="$(curl -s -m 10 "$API_BASE/api/system/health")"
  echo "$body" | jq -r '.checks[] | "  \(.status|asii)"' >/dev/null 2>&1 || true
  echo "$body" | jq -r '.checks[] | "  \(.component): \(.status) — \(.message)"' 2>/dev/null || true
  unhealthy="$(echo "$body" | jq -r '[.checks[] | select(.status != "healthy")] | length' 2>/dev/null || echo 0)"
  if [ "${unhealthy:-0}" != "0" ]; then
    echo "  WARN  $unhealthy dependency/dependencies not healthy"
    failures=$((failures + 1))
  fi
else
  echo "  (install jq for per-dependency detail)"
fi

exit $((failures > 0 ? 1 : 0))
