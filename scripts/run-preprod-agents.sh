#!/usr/bin/env bash
# Starts the preprod agents in the background with their public (tunnel) base URLs from
# deployments/agents.preprod.json. Registry ids come from CASCADE_AGENT_ID_* in .env, which
# scripts/register-agents.ts writes. Logs and PIDs go to infra/.data/agents/ (git-ignored).
#
# Usage: scripts/run-preprod-agents.sh [start|stop]
set -euo pipefail
# Job control gives each background agent its own process group, so stop can kill its children.
set -m
root="$(cd "$(dirname "$0")/.." && pwd)"
data="$root/infra/.data/agents"
mkdir -p "$data"
agents_file="$root/deployments/agents.preprod.runtime.json"
ts_agents=(conductor scout pricer lookup-api flaky-lisan checker-a checker-b checker-c scribe)

stop_all() {
  for pidfile in "$data"/agent-*.pid; do
    [[ -f "$pidfile" ]] || continue
    pid="$(cat "$pidfile")"
    # Lisan's run.sh spawns uvicorn and python children; kill the whole process group.
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    rm -f "$pidfile"
  done
}

url_of() {
  jq -r --arg a "$1" '.agents[] | select(.agent == $a) | .publicUrl' "$agents_file"
}

if [[ "${1:-start}" == "stop" ]]; then
  stop_all
  echo "Stopped preprod agents."
  exit 0
fi

stop_all

# Preprod chain services from W3's runner (services/run), on this machine. Tokens are read from its
# state folder into the agents' environment and never printed.
state="$root/services/run/state"
for f in signer.token directory-admin.token; do
  [[ -f "$state/$f" ]] || { echo "missing services/run/state/$f; start the services first (pnpm --filter @cascade/services-run services start)" >&2; exit 1; }
done
export CASCADE_NETWORK=preprod
export CASCADE_INDEXER_URL=http://127.0.0.1:26100
export CASCADE_FACILITATOR_URL=http://127.0.0.1:26200
export CASCADE_SIGNER_URL=http://127.0.0.1:26300
CASCADE_SIGNER_TOKEN="$(cat "$state/signer.token")"
CASCADE_INDEXER_ADMIN_TOKEN="$(cat "$state/directory-admin.token")"
export CASCADE_SIGNER_TOKEN CASCADE_INDEXER_ADMIN_TOKEN
export CASCADE_WEB_ORIGINS="https://cascade-alpha-amber.vercel.app,http://localhost:3000"
# Conductor keeps plans in the preprod Neon database (DATABASE_URL_PREPROD in .env).
set +x
set -a
# shellcheck disable=SC1091
source "$root/.env"
set +a
export CASCADE_ORCHESTRATOR_DATABASE_URL="$DATABASE_URL_PREPROD"

for agent in "${ts_agents[@]}"; do
  key="$(echo "$agent" | tr 'a-z-' 'A-Z_')"
  url="$(url_of "$agent")"
  if [[ -z "$url" ]]; then
    # Not exposed publicly yet (e.g. checker-c before the gateway domain): reachable on this machine only.
    echo "warning: no public URL for $agent; it serves on its local port only" >&2
  fi
  (
    cd "$root/agents/$agent"
    [[ -z "$url" ]] || export "CASCADE_${key}_BASE_URL=$url"
    exec "$root/node_modules/.bin/tsx" src/main.ts
  ) >"$data/agent-$agent.log" 2>&1 &
  echo $! >"$data/agent-$agent.pid"
  echo "started $agent (pid $!) at $url"
done

# CrewAI keeps kickoff logs in a per-project store (default: named after the working directory, which
# Lisan and Lisan-B share); a store written by another CrewAI version breaks kickoff, so Lisan gets its own.
(export CREWAI_STORAGE_DIR=cascade-lisan; exec "$root/agents/lisan-masumi/run.sh") >"$data/agent-lisan.log" 2>&1 &
echo $! >"$data/agent-lisan.pid"
echo "started lisan (pid $!) at $(url_of lisan)"

# The Sokosumi Coworker worker: its own detached session and journal, so it resumes open Tasks.
"$root/scripts/run-coworker.sh" start
