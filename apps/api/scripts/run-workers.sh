#!/usr/bin/env bash
# Starts every queue worker role in one process group — the shape a container host wants
# (Render/Railway/Fly run one command per service; the API itself is a separate service).
# Each role is a separate node process so a crashed worker cannot take the others down.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

ROLES="${WORKER_ROLES:-pipeline render publish scheduler recovery}"
pids=()

shutdown() {
  echo "signal received — stopping workers"
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null; done
  wait
  exit 0
}
trap shutdown TERM INT

for role in $ROLES; do
  node "dist/workers/$role.worker.js" &
  pids+=("$!")
  echo "started $role worker (pid $!)"
done

# If any role exits, stop the whole group: a half-alive worker set is worse than a restart.
wait -n
echo "a worker exited — shutting the group down so the host restarts it"
shutdown
