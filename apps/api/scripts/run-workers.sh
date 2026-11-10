#!/usr/bin/env bash
# Starts every queue worker role in one process group — the shape a container host wants
# (Render/Railway/Fly run one command per service; the API itself is a separate service).
#
# Each role is its own node process. A crashed role is restarted on its own with exponential
# backoff, so one bad job cannot stop processing for the other four queues. Only a role that keeps
# dying (default: 6 failures inside 5 minutes) escalates: the script then exits non-zero and the
# host is expected to restart the whole service — a half-alive worker set is worse than a restart.
#
#   bash apps/api/scripts/run-workers.sh                       # all roles
#   WORKER_ROLES="render publish" bash apps/api/scripts/run-workers.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

ROLES="${WORKER_ROLES:-pipeline render publish scheduler recovery}"
MAX_FAILURES="${WORKER_MAX_FAILURES:-6}"
FAILURE_WINDOW="${WORKER_FAILURE_WINDOW_SECONDS:-300}"
declare -A pid_of role_of failures started_at

shutdown() {
  echo "signal received — stopping workers"
  for pid in "${!pid_of[@]}"; do kill "${pid_of[$pid]}" 2>/dev/null; done
  # shellcheck disable=SC2046
  wait $(printf '%s ' "${!pid_of[@]}") 2>/dev/null
  exit 0
}
trap shutdown TERM INT

for role in $ROLES; do
  node "dist/workers/$role.worker.js" &
  pid_of[$role]=$!
  echo "started $role worker (pid $!)"
done

while :; do
  # `wait -n` returns as soon as any child exits; then we work out which one.
  wait -n
  for role in $ROLES; do
    pid="${pid_of[$role]:-}"
    [ -n "$pid" ] || continue
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null
      code=$?
      now=$(date +%s)
      since="${started_at[$role]:-0}"

      # A role that ran for the failure window is healthy: reset its counter.
      if [ "$since" -gt 0 ] && [ $((now - since)) -ge "$FAILURE_WINDOW" ]; then
        failures[$role]=0
      fi
      failures[$role]=$(( ${failures[$role]:-0} + 1 ))
      count="${failures[$role]}"

      echo "$role worker (pid $pid) exited with code $code — failure $count/$MAX_FAILURES"
      if [ "$count" -ge "$MAX_FAILURES" ]; then
        echo "$role crashed $count times within ${FAILURE_WINDOW}s — escalating so the host restarts the service"
        shutdown
      fi

      # 2s, 4s, 8s, 16s, capped at 30s.
      delay=$(( 2 ** (count > 4 ? 4 : count) ))
      [ "$delay" -gt 30 ] && delay=30
      echo "restarting $role in ${delay}s"
      sleep "$delay"
      node "dist/workers/$role.worker.js" &
      pid_of[$role]=$!
      started_at[$role]=$(date +%s)
      echo "restarted $role worker (pid $!)"
    fi
  done
done
