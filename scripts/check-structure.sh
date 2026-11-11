#!/usr/bin/env bash
# Structural check for the ClipForge repository.
#
# The layout is only real if something fails when it drifts. Every rule below encodes a decision
# recorded in docs/FOLDER-STRUCTURE.md — delete a rule when you change the decision, never silently.
#
#   bash scripts/check-structure.sh          # human-readable report
#   bash scripts/check-structure.sh --quiet  # only violations and the summary line
#
# Exit code 0 = the tree matches the declared structure. 1 = it does not.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

pass=0
fail=0
section() { [ "$QUIET" = 1 ] || printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { pass=$((pass + 1)); [ "$QUIET" = 1 ] || printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

# --------------------------------------------------------------------------- 1. required areas
section "1. required areas"
REQUIRED_DIRS=(
  apps/api/src apps/api/src/auth apps/api/src/common apps/web/app apps/web/components apps/web/lib
  packages/database/prisma packages/shared-types/src packages/validation/src
  packages/platform-connectors/src
  services/ai-engine/app services/video-processor/app
  tests/unit tests/integration tests/e2e tests/python tests/fixtures
  infrastructure/docker infrastructure/scripts docs scripts artifacts/ui
)
for d in "${REQUIRED_DIRS[@]}"; do
  if [ -d "$d" ]; then ok "exists  $d"; else bad "missing directory: $d"; fi
done

# --------------------------------------------------------------------------- 2. area READMEs
section "2. every area explains itself"
for d in apps/api apps/web packages packages/database packages/shared-types packages/validation \
         packages/platform-connectors services/ai-engine services/video-processor \
         infrastructure tests docs scripts; do
  if [ -f "$d/README.md" ]; then ok "README  $d"; else bad "no README.md in $d"; fi
done

# --------------------------------------------------------------------------- 3. root stays tidy
section "3. repository root holds only entry points"
ALLOWED_ROOT="README.md package.json package-lock.json tsconfig.base.json tsconfig.json
docker-compose.dev.yml docker-compose.prod.yml render.yaml render.pipeline.yaml
.env.example .gitignore .dockerignore .bootstrap-token.local
apps packages services tests infrastructure scripts docs artifacts node_modules
.next local-storage .git .env .venv .ruff_cache .pytest_cache"
unexpected=0
for entry in $(ls -A); do
  case " $(echo $ALLOWED_ROOT) " in
    *" $entry "*) ;;
    *) bad "unexpected root entry: $entry (belongs in apps/, packages/, scripts/ or infrastructure/)"
       unexpected=$((unexpected + 1)) ;;
  esac
done
[ "$unexpected" = 0 ] && ok "no stray files at the root"

# --------------------------------------------------------------------------- 4. workspace packages
section "4. every workspace package is a real package"
for pkg in packages/*/; do
  name=$(basename "$pkg")
  meta="$pkg/package.json"
  if [ ! -f "$meta" ]; then bad "$name has no package.json"; continue; fi
  hpkg=$(python3 -c "import json;d=json.load(open('$meta'));print(d.get('name',''))" 2>/dev/null)
  case "$hpkg" in
    @clipforge/*) ok "$name -> $hpkg" ;;
    *) bad "$name: package name '$hpkg' must be @clipforge/*" ;;
  esac
  for s in build typecheck; do
    python3 -c "import json,sys;sys.exit(0 if '$s' in json.load(open('$meta')).get('scripts',{}) else 1)" \
      || bad "$name: missing '$s' script"
  done
done

# --------------------------------------------------------------------------- 5. API shape
section "5. every API controller is wired into a module"
orphans=0
for ctrl in apps/api/src/*/*.controller.ts; do
  [ -e "$ctrl" ] || continue
  class=$(grep -oE 'export class [A-Za-z]+' "$ctrl" | head -1 | awk '{print $3}')
  [ -z "$class" ] && { bad "$ctrl declares no controller class"; orphans=$((orphans + 1)); continue; }
  if grep -rqE "controllers:[^]]*\b$class\b|\b$class\b" apps/api/src --include=*.module.ts \
       --include=app.module.ts; then
    ok "$class is registered"
  else
    bad "$class ($ctrl) is not registered in any module — dead route"
    orphans=$((orphans + 1))
  fi
done
[ "$orphans" = 0 ] && ok "no orphan controllers"

for mod in apps/api/src/*/*.module.ts; do
  [ -e "$mod" ] || continue
  class=$(grep -oE 'export class [A-Za-z]+' "$mod" | head -1 | awk '{print $3}')
  grep -rq "\b$class\b" apps/api/src --include=*.module.ts || bad "$class is defined but never imported"
done
ok "module graph is closed"

# --------------------------------------------------------------------------- 6. one home for tests
section "6. tests live in tests/"
stray=$(find apps packages services -name '*.test.ts' -o -name '*.spec.ts' -o -name 'test_*.py' 2>/dev/null | head -5)
if [ -z "$stray" ]; then ok "no test files outside tests/"; else
  echo "$stray" | while read -r f; do bad "stray test file: $f"; done
  fail=$((fail + 1))
fi

# --------------------------------------------------------------------------- 7. import boundaries
section "7. dependency direction (apps -> packages, never sideways)"
violations=$(grep -rn --include=*.ts --include=*.tsx -E "from '(\\.\\./)*(\\.\\./)+apps/(api|web)/|@clipforge/(api|web)" \
  apps packages services 2>/dev/null | grep -v node_modules | head -5)
if [ -z "$violations" ]; then ok "no app imports an app"; else
  echo "$violations" | while read -r v; do bad "sideways import: $v"; done
  fail=$((fail + 1))
fi
if grep -rqE --include=*.ts --include=*.tsx "from '(services/|(\.\./){2,}services/)" apps packages 2>/dev/null; then
  bad "TypeScript code reaches into services/ (Python) — talk over HTTP instead"
else ok "TypeScript never imports the Python services directly"; fi

# --------------------------------------------------------------------------- 8. python services
section "8. python services are complete"
for svc in services/ai-engine services/video-processor; do
  [ -f "$svc/app/main.py" ]     && ok "$svc/app/main.py"          || bad "$svc has no app/main.py"
  [ -f "$svc/requirements.txt" ] && ok "$svc/requirements.txt"    || bad "$svc has no requirements.txt"
  [ -f "$svc/README.md" ]        && ok "$svc/README.md"           || bad "$svc has no README.md"
  grep -q '@app.get("/health")' "$svc/app/main.py" 2>/dev/null \
    && ok "$svc exposes /health" || bad "$svc exposes no /health endpoint"
  # every module inside app/ must be importable, i.e. no hyphenated filenames
  for py in "$svc"/app/*.py; do
    base=$(basename "$py")
    case "$base" in *-*) bad "$py uses a hyphen; python modules must be snake_case" ;; esac
  done
done

# --------------------------------------------------------------------------- 9. deployment files
section "9. deployment files point at files that exist"
for f in docker-compose.dev.yml docker-compose.prod.yml render.yaml render.pipeline.yaml; do
  [ -f "$f" ] || { bad "missing $f"; continue; }
  ok "$f"
done
for df in $(grep -hoE 'dockerfile(Path)?: *\.?/?[A-Za-z0-9._/-]+' docker-compose*.yml render*.yaml \
            | awk '{print $2}' | sed 's|^\./||' | sort -u); do
  if [ -f "$df" ]; then ok "referenced Dockerfile exists: $df"; else bad "missing Dockerfile: $df"; fi
done

# --------------------------------------------------------------------------- 10. naming
section "10. file naming"
badnames=$(find apps packages tests scripts -type f \( -name '*.ts' -o -name '*.tsx' \) \
  | grep -vE '/(node_modules|\.next)/' \
  | grep -vE '/(page|layout|loading|error|not-found|route|middleware|template|global-error)\.tsx?$' \
  | grep -vE '(next|tailwind|postcss|eslint|vitest|playwright)\.config\.ts$' \
  | grep -vE '/(index|main|types)\.ts$' \
  | grep -E '/[A-Za-z0-9]*[A-Z][A-Za-z0-9-]*\.tsx?$' | head -5)
if [ -z "$badnames" ]; then ok "TypeScript files are kebab-case"; else
  echo "$badnames" | while read -r f; do bad "not kebab-case: $f"; done
  fail=$((fail + 1))
fi

# --------------------------------------------------------------------------- 11. docs are real
section "11. documentation links resolve"
missing_doc=0
for doc in docs/*.md; do
  base=$(basename "$doc")
  [ "$base" = "DOCUMENT-INDEX.md" ] && continue
  grep -q "($base)" docs/DOCUMENT-INDEX.md || {
    bad "$base is not listed in docs/DOCUMENT-INDEX.md"; missing_doc=$((missing_doc + 1)); }
done
[ "$missing_doc" = 0 ] && ok "every document in docs/ is indexed"

dangling=0
# any backticked docs/….md mention anywhere in the repository must exist
for ref in $(grep -rhoE 'docs/[A-Za-z0-9._-]+\.md' --include=*.md \
             --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git --exclude-dir=dist . \
             | sort -u); do
  [ -f "$ref" ] || { bad "dangling document reference: $ref"; dangling=$((dangling + 1)); }
done
[ "$dangling" = 0 ] && ok "no dangling docs/ references"

# markdown links inside docs/ and README must resolve
broken=0
for md in docs/*.md README.md; do
  dir=$(dirname "$md")
  for target in $(grep -ohE '\]\([A-Za-z0-9._/-]+\.md\)' "$md" | sed 's/^](//;s/)$//'); do
    [ -f "$dir/$target" ] || [ -f "$target" ] || {
      bad "$md links to missing $target"; broken=$((broken + 1)); }
  done
done
[ "$broken" = 0 ] && ok "every markdown link resolves"

# --------------------------------------------------------------------------- summary
printf '\n\033[1m%d checks passed, %d failed\033[0m\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
  printf '\033[31mSTRUCTURE: FAIL\033[0m — fix the lines above, or update docs/FOLDER-STRUCTURE.md if the rule is wrong.\n'
  exit 1
fi
printf '\033[32mSTRUCTURE: OK\033[0m\n'
