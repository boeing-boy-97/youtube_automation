#!/usr/bin/env bash
# Reports which external API keys are configured — never prints a key, only whether one exists.
# Usage: bash scripts/check-api-keys.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "no .env at $ENV_FILE — copy .env.example to .env first" >&2
  exit 1
fi

value_of() { # key -> value (empty when unset or blank)
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | tr -d '\r'
}

report() { # key, human label, consequence when empty
  local key="$1" label="$2" impact="$3" value
  value="$(value_of "$key")"
  if [ -n "$value" ]; then
    printf '  %-26s SET    %s\n' "$key" "$label"
  else
    printf '  %-26s EMPTY  %s — %s\n' "$key" "$label" "$impact"
  fi
}

echo "External API keys (values are never printed)"
echo
echo "AI analysis — the only key that changes the product:"
report GEMINI_API_KEY "Gemini API key" "candidates come from the fixture provider, prefixed [fixture provider — no model was called]"
report GEMINI_TEXT_MODEL "text model name" "analysis and metadata copy cannot run in Gemini mode"
report GEMINI_VISION_MODEL "vision model name" "no frames are inspected"
printf '  %-26s %s\n' "AI_PROVIDER" "$(value_of AI_PROVIDER)"
echo
echo "Publishing — optional, clips still render and download without these:"
report YOUTUBE_CLIENT_ID "YouTube OAuth client id" "YouTube uploads answer 400 PUBLISH_ELIGIBILITY_FAILED"
report YOUTUBE_CLIENT_SECRET "YouTube OAuth secret" "same"
report META_APP_ID "Meta app id" "Instagram publishing answers 400 PUBLISH_ELIGIBILITY_FAILED"
report META_APP_SECRET "Meta app secret" "same"
echo
echo "Storage — optional, local disk is used by default:"
printf '  %-26s %s\n' "STORAGE_DRIVER" "$(value_of STORAGE_DRIVER)"
report S3_BUCKET "S3 / R2 bucket" "only relevant when STORAGE_DRIVER=s3"

echo
echo "What the running AI engine says:"
AI_URL="$(value_of AI_ENGINE_URL)"; AI_URL="${AI_URL:-http://127.0.0.1:8100}"
health="$(curl -s -m 3 "$AI_URL/health" 2>/dev/null || true)"
if [ -z "$health" ]; then
  echo "  ai-engine not reachable at $AI_URL (start it with scripts/dev-up.sh)"
else
  echo "  $health"
fi

echo
echo "Where to get them: docs/ADD-API-KEYS.md"
