#!/usr/bin/env bash
# One command to ship apps/web to Vercel with the API origin baked in correctly.
#
#   ./scripts/deploy-vercel.sh https://clipforge-api.onrender.com            # preflight + print the exact steps
#   ./scripts/deploy-vercel.sh https://clipforge-api.onrender.com --deploy   # actually deploy (needs `vercel login`)
#
# The dashboard has no runtime configuration to forget: /api and /media are rewrites to
# API_INTERNAL_URL, evaluated when `next build` runs. Get that one variable wrong and the site
# loads while every request fails — which is exactly what this script prevents.
set -euo pipefail

API_ORIGIN="${1:-${API_INTERNAL_URL:-}}"
MODE="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$ROOT/apps/web"

die() { printf '\n  ✗ %s\n\n' "$*" >&2; exit 1; }
step() { printf '\n  ▸ %s\n' "$*"; }
ok() { printf '    ✓ %s\n' "$*"; }

[ -n "$API_ORIGIN" ] || die "Usage: $0 <api-origin> [--deploy]
    The API origin is the public URL of the NestJS API, e.g. https://clipforge-api.onrender.com"

API_ORIGIN="${API_ORIGIN%/}"
API_ORIGIN="${API_ORIGIN%/api}"

# ALLOW_LOCAL_API=1 is a rehearsal escape hatch: it lets you run this script against a local API to
# prove the preflight/build chain. It can never deploy — Vercel refuses to build a localhost target.
if [ "${ALLOW_LOCAL_API:-0}" = "1" ] && [ "$MODE" != "--deploy" ]; then
  printf '    ! ALLOW_LOCAL_API=1 — rehearsal only, nothing will be deployed\n'
else
  case "$API_ORIGIN" in
    https://*) : ;;
    http://localhost*|http://127.0.0.1*|http://0.0.0.0*) die "API_INTERNAL_URL must be the public API origin; '$API_ORIGIN' is a local address and the hosted build rejects it." ;;
    *) die "API_INTERNAL_URL must start with https:// (got '$API_ORIGIN')." ;;
  esac
fi

step "1/5  API origin: $API_ORIGIN"

step "2/5  Preflight: is the API actually answering there?"
HEALTH="$(curl -fsS -m 10 "$API_ORIGIN/api/system/health" 2>/dev/null || true)"
if [ -z "$HEALTH" ]; then
  die "GET $API_ORIGIN/api/system/health did not answer.
    Deploy/start the API first (see docs/DEPLOY-VERCEL.md §2) — a frontend pointed at a dead API
    loads fine and then fails every request."
fi
ok "health: $(printf '%s' "$HEALTH" | head -c 160)"

step "3/5  Local production build with that origin (catches the failure here, not after deploy)"
( cd "$WEB" && API_INTERNAL_URL="$API_ORIGIN" ../../node_modules/.bin/next build >/tmp/vercel-build.log 2>&1 ) \
  && ok "build passed — /healthz and every route compiled" \
  || { tail -25 /tmp/vercel-build.log >&2; die "build failed (log: /tmp/vercel-build.log)"; }

step "4/5  Vercel CLI"
if ! command -v vercel >/dev/null 2>&1; then
  printf '    ! vercel CLI not installed. Either:\n'
  printf '        npm i -g vercel && vercel login\n'
  printf '      or use the dashboard (no CLI needed) — the exact clicks are in docs/DEPLOY-VERCEL.md §3.\n'
  printf '      In both cases the only project setting that matters is:\n\n'
  printf '        Root Directory : apps/web\n        Framework      : Next.js\n        Env (Production): API_INTERNAL_URL=%s\n\n' "$API_ORIGIN"
  exit 0
fi
vercel whoami >/dev/null 2>&1 || die "Not logged in. Run: vercel login"
ok "logged in as $(vercel whoami 2>/dev/null)"

if [ "$MODE" != "--deploy" ]; then
  step "5/5  Not deploying (dry run). Re-run with --deploy to execute:"
  printf '        vercel env add API_INTERNAL_URL production   # value: %s\n' "$API_ORIGIN"
  printf '        cd apps/web && vercel --prod\n\n'
  exit 0
fi

step "5/5  Deploying apps/web to production"
( cd "$WEB" \
  && printf '%s\n' "$API_ORIGIN" | vercel env add API_INTERNAL_URL production --force >/dev/null 2>&1 || true \
  && vercel --prod --yes )

cat <<'CHECKLIST'

  ── After the deploy ────────────────────────────────────────────────
  1. Open  https://<your-app>.vercel.app/healthz
       ok:true  + upstream.status 200 → the frontend can reach the API.
       ok:false                     → API_INTERNAL_URL is wrong or the API is asleep.
  2. On the API host, set and restart:
       APP_URL=https://<your-app>.vercel.app
       ALLOWED_ORIGINS=https://<your-app>.vercel.app
     Missing ALLOWED_ORIGINS ⇒ sign-in "works" but every write fails 403 CSRF_FAILED.
  3. Sign in, open /admin — the "Dashboard → API link" card repeats this probe in-app.
  ────────────────────────────────────────────────────────────────────
CHECKLIST
