#!/usr/bin/env bash
# An extra Conductor for acceptance tests that must stop or crash the orchestrator (A14, A15) while
# the preprod Conductor keeps running. It uses the same preprod services, database and agents, but
# its own port, Temporal task queue and state tables, so neither instance takes the other's trees.
# See README.md. Needs `pnpm --filter @cascade/agent-conductor build` and the preprod services.
#
# Usage:
#   test-instance.sh start <name> [port]   start (CASCADE_TEST_CRASH_AFTER_SIGN passes through), print base URL
#   test-instance.sh stop <name>           kill it (as an operator outage would)
#   test-instance.sh status <name>         print running, or exited:<code> (86 = crash point reached)
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
cmd="${1:-}"
name="${2:-}"
[[ "$name" =~ ^[a-z0-9_]{1,32}$ ]] || { echo "usage: $0 start|stop|status <name: [a-z0-9_]{1,32}> [port]" >&2; exit 2; }
data="$root/infra/.data/agents"
mkdir -p "$data"
pidfile="$data/test-conductor-$name.pid"
exitfile="$data/test-conductor-$name.exit"
logfile="$data/test-conductor-$name.log"

case "$cmd" in
  start)
    port="${3:-24100}"
    if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then echo "test conductor $name is already running" >&2; exit 1; fi
    state="$root/services/run/state"
    [[ -f "$state/signer.token" ]] || { echo "missing services/run/state/signer.token; start the preprod services first" >&2; exit 1; }
    [[ -f "$root/agents/conductor/dist/main.js" ]] || { echo "build first: pnpm --filter @cascade/agent-conductor build" >&2; exit 1; }
    rm -f "$exitfile"
    (
      export CASCADE_NETWORK=preprod
      export CASCADE_INDEXER_URL=http://127.0.0.1:26100
      export CASCADE_FACILITATOR_URL=http://127.0.0.1:26200
      export CASCADE_SIGNER_URL=http://127.0.0.1:26300
      CASCADE_SIGNER_TOKEN="$(cat "$state/signer.token")"
      CASCADE_INDEXER_ADMIN_TOKEN="$(cat "$state/directory-admin.token")"
      export CASCADE_SIGNER_TOKEN CASCADE_INDEXER_ADMIN_TOKEN
      export CASCADE_WEB_ORIGINS="${CASCADE_WEB_ORIGINS:-http://localhost:3000}"
      export CASCADE_CONDUCTOR_PORT="$port"
      export CASCADE_CONDUCTOR_BASE_URL="http://127.0.0.1:$port"
      export CASCADE_TASK_QUEUE="cascade-test-$name"
      export CASCADE_ORCHESTRATOR_STATE_PREFIX="test_$name"
      cd "$root/agents/conductor"
      node dist/main.js &
      echo $! >"$pidfile"
      code=0
      wait $! || code=$?
      echo "$code" >"$exitfile"
    ) >"$logfile" 2>&1 &
    for _ in $(seq 1 120); do
      if curl -fsS "http://127.0.0.1:$port/availability" >/dev/null 2>&1; then echo "http://127.0.0.1:$port"; exit 0; fi
      if [[ -f "$exitfile" ]]; then echo "test conductor $name exited with $(cat "$exitfile"); see $logfile" >&2; exit 1; fi
      sleep 1
    done
    echo "test conductor $name did not answer on port $port; see $logfile" >&2
    exit 1
    ;;
  stop)
    [[ -f "$pidfile" ]] && kill "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
    echo "stopped test conductor $name"
    ;;
  status)
    if [[ -f "$exitfile" ]]; then echo "exited:$(cat "$exitfile")"
    elif [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then echo running
    else echo "not started"; fi
    ;;
  *)
    echo "usage: $0 start|stop|status <name> [port]" >&2
    exit 2
    ;;
esac
