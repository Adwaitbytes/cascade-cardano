#!/usr/bin/env bash
# Moves the preprod stack from the old folder (default ~/Desktop/cardano) to this checkout, for the
# hackathon redeploy (docs/hackathon-redeploy.md, steps 3 to 5). Run it only with the lead's go-ahead
# and only when no demo, acceptance tree or paid Sokosumi Task is live on the old stack.
#
#   1. preflight: this checkout is built, its .env points at a different database than the old one,
#      sets INDEXER_START_HEIGHT and its own Temporal namespace, and the Temporal namespace exists
#   2. stops the old stack's processes (agents, Lisan, Lisan-B, Coworker, gateway and ngrok, chain
#      services) by their pid files, killing only processes that belong to the old folder
#   3. starts chain services, agents, Lisan-B, the Coworker and the gateway from this checkout on the
#      same ports and the same ngrok domain (scripts/preprod-up.sh)
#   4. re-registers the agents in the new indexer's directory (scripts/reseed-directory.ts)
#   5. waits for health and prints scripts/preprod-status.sh
#
# Safe to rerun: a stopped old stack is skipped and preprod-up.sh never restarts a live process.
# Deletes nothing: the old folder's database, Temporal namespace (cascade), journals, logs and files
# stay as they are. Masumi payment services and the Temporal server are shared and stay up.
# Without --yes it runs the preflight and prints the plan only.
#
# Usage: scripts/switch-over.sh [--yes] [--old <dir>]
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib/preprod-common.sh
source "$(cd "$(dirname "$0")" && pwd)/lib/preprod-common.sh"
new="$root"
old="$HOME/Desktop/cardano"
apply=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) apply=1 ;;
    --old) old="$(cd "$2" && pwd)"; shift ;;
    *) echo "unknown argument $1 (usage: scripts/switch-over.sh [--yes] [--old <dir>])" >&2; exit 2 ;;
  esac
  shift
done
[[ "$old" != "$new" ]] || { echo "the old folder is this checkout" >&2; exit 2; }

temporal_container=cascade-local-temporal-1
expected_node_hash=1eea6bd1b08cf9a466eed7ca7a8d9ab53aa8ed1526ed3281b785ba07
# Ports the preprod processes listen on; Masumi (23100-23102) and Temporal (27233) are shared and stay.
stack_ports=(23111 23112 24001 24002 24003 24004 24005 24006 24007 24008 24009 24010 24011 24012 24100 26100 26200 26300 26400)

fail() { echo "switch-over: $*" >&2; exit 1; }

# env_value <file> <name>: prints one variable from a dotenv file for comparisons inside this script.
# Callers only compare or test it; it is never echoed.
env_value() {
  python3 - "$1" "$2" <<'PY'
import re, sys
path, name = sys.argv[1], sys.argv[2]
for line in open(path):
    m = re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$', line.rstrip('\n'))
    if m and m.group(1) == name:
        print(m.group(2).strip().strip('"\''))
        break
PY
}

# owner <pid>: "old", "new" or "other", from the process's command line, then its working directory.
owner() {
  local cmd cwd
  cmd="$(ps -o command= -p "$1" 2>/dev/null || true)"
  cwd="$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  if [[ "$cmd" == *"$old/"* || "$cwd" == "$old" || "$cwd" == "$old/"* ]]; then echo old
  elif [[ "$cmd" == *"$new/"* || "$cwd" == "$new" || "$cwd" == "$new/"* ]]; then echo new
  else echo other; fi
}

# The process group of a pid file, killed only when one of its processes belongs to the old folder.
stop_old_group() {
  local pidfile="$1" pid member
  [[ -f "$pidfile" ]] || return 0
  pid="$(cat "$pidfile")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  for member in $(ps -A -o pid=,pgid= | awk -v g="$pid" '$2 == g { print $1 }'); do
    if [[ "$(owner "$member")" == old ]]; then
      kill -- "-$pid" 2>/dev/null || true
      echo "  stopped $(basename "$pidfile" .pid) (process group $pid)"
      return 0
    fi
  done
}

listeners() { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }

echo "1/5 preflight"
[[ -f "$new/.env" ]] || fail "no .env in $new (copy it from the old folder first)"
[[ -f "$new/services/run/dist/cli.js" && -f "$new/services/indexer/dist/directory.js" ]] || fail "build this checkout first: scripts/heavy.sh pnpm build"
[[ -x "$new/agents/lisan-masumi/.venv/bin/python" ]] || fail "no Lisan Python environment; run agents/lisan-masumi/run.sh once"
node_hash="$(jq -r '.scripts.cascade_node.hash' "$new/deployments/preprod.json")"
[[ "$node_hash" == "$expected_node_hash" ]] || fail "deployments/preprod.json names cascade_node $node_hash, expected $expected_node_hash"
[[ -z "$(env_value "$new/.env" CASCADE_NODE_HASH)" ]] || fail "CASCADE_NODE_HASH in .env would override the new node hash"
[[ -n "$(env_value "$new/.env" INDEXER_START_HEIGHT)" ]] || fail "INDEXER_START_HEIGHT is not set in .env"
namespace="$(env_value "$new/.env" CASCADE_TEMPORAL_NAMESPACE)"
[[ -n "$namespace" && "$namespace" != cascade ]] || fail "set CASCADE_TEMPORAL_NAMESPACE in .env to a namespace other than the old stack's (cascade)"
new_db="$(env_value "$new/.env" DATABASE_URL_PREPROD)"
[[ -n "$new_db" ]] || fail "DATABASE_URL_PREPROD is not set in .env"
if [[ -f "$old/.env" && "$new_db" == "$(env_value "$old/.env" DATABASE_URL_PREPROD)" ]]; then
  fail "DATABASE_URL_PREPROD is the old stack's database; each indexer would truncate the other's tables"
fi
unset new_db
if [[ ! -f "$runtime_file" && -f "$old/deployments/agents.preprod.runtime.json" ]]; then
  cp "$old/deployments/agents.preprod.runtime.json" "$runtime_file"
  echo "  copied agents.preprod.runtime.json from the old folder"
fi
[[ -f "$runtime_file" ]] || fail "no deployments/agents.preprod.runtime.json"
if ! nc -z 127.0.0.1 27233 2>/dev/null; then
  [[ "$apply" -eq 1 ]] || fail "Temporal is not running on 127.0.0.1:27233"
  docker compose -f "$new/infra/docker-compose.local.yml" up -d --wait --wait-timeout 300 temporal
fi
if ! docker exec "$temporal_container" temporal operator namespace describe --namespace "$namespace" --address localhost:7233 >/dev/null 2>&1; then
  [[ "$apply" -eq 1 ]] || fail "Temporal namespace $namespace does not exist yet (rerun with --yes to create it)"
  docker exec "$temporal_container" temporal operator namespace create --namespace "$namespace" --retention 720h --address localhost:7233 >/dev/null
fi
echo "  checkout $new, cascade_node $node_hash, Temporal namespace $namespace, own database: ok"

old_live=0
for port in "${stack_ports[@]}"; do
  for pid in $(listeners "$port"); do
    case "$(owner "$pid")" in
      old) old_live=$((old_live + 1)) ;;
      other) fail "port $port is held by pid $pid, which belongs to neither checkout; not touching it" ;;
    esac
  done
done
echo "  old stack listeners: $old_live"

if [[ "$apply" -eq 0 ]]; then
  echo
  echo "Plan: stop $old_live old listeners from $old, start this checkout with scripts/preprod-up.sh,"
  echo "re-register the directory, print status. Nothing was changed. Rerun with --yes to switch over."
  exit 0
fi

echo "2/5 stop the old stack ($old)"
if [[ "$old_live" -eq 0 ]]; then
  echo "  already stopped"
else
  for f in "$old"/infra/.data/agents/*.pid "$old"/infra/.data/lisan-b/*.pid; do stop_old_group "$f"; done
  if [[ -f "$old/services/run/dist/cli.js" ]]; then node "$old/services/run/dist/cli.js" stop | sed 's/^/  /'; fi
  # ngrok and stray children whose group leader is gone: free the ports by listener, old folder only.
  for _ in $(seq 1 30); do
    busy=0
    for port in "${stack_ports[@]}"; do
      for pid in $(listeners "$port"); do
        [[ "$(owner "$pid")" == old ]] && { busy=1; kill "$pid" 2>/dev/null || true; }
      done
    done
    [[ "$busy" -eq 0 ]] && break
    sleep 2
  done
  [[ "$busy" -eq 0 ]] || fail "old stack still holds a port after 60 s"
  for pid in $(pgrep -x ngrok 2>/dev/null || true); do
    [[ "$(owner "$pid")" == old ]] && kill "$pid" 2>/dev/null || true
  done
  # The static ngrok domain allows one session; give the old one time to close on ngrok's side.
  sleep 10
  echo "  old stack stopped"
fi

echo "3/5 start this checkout"
"$new/scripts/preprod-up.sh"

echo "4/5 directory"
(cd "$new/scripts" && "$new/node_modules/.bin/tsx" reseed-directory.ts) | sed 's/^/  /'

echo "5/5 health"
listed="$(curl -s -m 10 http://127.0.0.1:26100/v1/agents | jq '.agents | length' 2>/dev/null || echo 0)"
echo "  directory lists $listed agents"
curl -s -m 10 http://127.0.0.1:26100/health | sed 's/^/  indexer /'
echo
status=0
"$new/scripts/preprod-status.sh" || status=$?
echo
echo "Web (not applied here): Vercel production needs only DATABASE_URL changed to this .env's"
echo "DATABASE_URL_PREPROD (pnpm -C scripts exec tsx vercel-env.ts), then pnpm -C scripts exec tsx web-deploy.ts."
exit "$status"
