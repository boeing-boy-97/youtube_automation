#!/usr/bin/env bash
# Tells you exactly where a Firebase project stands, without opening the console.
#
#   ./scripts/check-firebase.sh                      # uses FIREBASE_* from .env
#   ./scripts/check-firebase.sh <web-api-key> <project-id>
#
# It answers the three questions that decide whether "Continue with Google" can work:
#   1. Is Firebase Authentication initialised for the project at all?
#   2. Is the Google provider enabled?
#   3. Can this API verify the tokens that Google issues (service account present)?
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$ROOT/.env"; set +a
fi

KEY="${1:-${FIREBASE_WEB_API_KEY:-}}"
BAD=0
PROJECT="${2:-${FIREBASE_PROJECT_ID:-}}"
API="${CLIPFORGE_API:-http://127.0.0.1:4000}"

if [ -z "$KEY" ]; then
  echo "✗ No FIREBASE_WEB_API_KEY. Pass it as \$1 or set it in .env (Firebase console → Project settings → General → Your apps)." >&2
  exit 1
fi

probe() {
  local url="$1" body="$2"
  curl -s -m 15 -X POST "$url" -H 'content-type: application/json' -d "$body"
}

echo "project: ${PROJECT:-<unknown>}"
echo

echo "1) Is Firebase Authentication initialised?"
resp="$(probe "https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=$KEY" \
  "{\"identifier\":\"probe@example.com\",\"providerId\":\"google.com\",\"continueUri\":\"http://localhost:3000\"}")"
case "$resp" in
  *'"sessionId"'*|*'"authUri"'*|*'"registered"'*)
    echo "   ✓ initialised, and the google.com provider answered" ;;
  *API_KEY_INVALID*|*"API key not valid"*)
    echo "   ✗ the web API key is wrong — re-copy it from Project settings → General → Your apps"
    BAD=1 ;;
  *CONFIGURATION_NOT_FOUND*)
    echo "   ✗ Firebase Authentication has never been set up in this project."
    echo "     Fix: Firebase console → your project → Build → Authentication → Get started"
    echo "          then Sign-in method → Google → Enable → pick a support email → Save"
    BAD=1 ;;
  *OPERATION_NOT_ALLOWED*)
    echo "   ✗ authentication is initialised, but the Google provider is disabled."
    echo "     Fix: Authentication → Sign-in method → Google → Enable → Save"
    BAD=1 ;;
  *)
    echo "   ? unexpected answer: $(printf '%s' "$resp" | head -c 300)"; BAD=1 ;;
esac
echo

echo "2) Can the API verify what Google issues? (needs a service account)"
providers="$(curl -s -m 10 "$API/api/auth/providers" 2>/dev/null || true)"
if [ -z "$providers" ]; then
  echo "   ? API not reachable at $API — start it first (npm run dev:api or your container)."
else
  verify="$(printf '%s' "$providers" | grep -o '"verifyConfigured":[a-z]*' | cut -d: -f2)"
  web="$(printf '%s' "$providers" | grep -o '"webConfigured":[a-z]*' | cut -d: -f2)"
  enabled="$(printf '%s' "$providers" | grep -o '"enabled":[a-z]*' | head -1 | cut -d: -f2)"
  echo "   webConfigured=$web  verifyConfigured=$verify  enabled=$enabled"
  if [ "$verify" = "true" ] && [ "$web" = "true" ]; then
    echo "   ✓ Google sign-in is fully configured — open /login and use the button."
  elif [ "$web" = "true" ]; then
    echo "   ✗ the browser is configured, the API cannot verify tokens yet."
    echo "     Fix: Project settings → Service accounts → Generate new private key, then set"
    echo "          FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY and restart the API."
  else
    echo "   ✗ the API has no Firebase values — see docs/FIREBASE-AUTH.md step 6."
  fi
fi
echo

echo "3) Does the dashboard's own origin work for the popup?"
echo "   The domain must be listed under Authentication → Settings → Authorized domains."
echo "   localhost is there by default; add your Vercel domain before deploying."
echo
if [ "$BAD" -ne 0 ]; then
  echo "Remaining work is listed above; docs/FIREBASE-AUTH.md has the exact clicks."
  exit 1
fi
