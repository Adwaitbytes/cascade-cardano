#!/usr/bin/env bash
# Brings up everything Cascade runs on this machine for preprod, in dependency order, each step
# detached from the terminal (new session, SIGHUP ignored) so closing the terminal stops nothing:
#
#   1. Masumi payment services (Docker, restart: unless-stopped)    :23100 :23101 :23102
#   2. chain services under the services/run supervisor             :26100 :26200 :26300 :26400
#      and the Temporal dev server the Conductor's worker needs       :27233 (local compose, shared)
#   3. Conductor, TS agents and Lisan (with its shim on :23111)     scripts/run-preprod-agents.sh
#   4. Lisan-B and its shim on :23112                               scripts/run-lisan-b.sh
#      and the Sokosumi Coworker worker on :24012                    scripts/run-coworker.sh
#   5. agents gateway and the ngrok static domain                   scripts/agents-gateway.ts
#
# Idempotent: a step whose processes already answer is skipped, so running it again never restarts a
# live process (shared preprod processes restart only with the lead's go-ahead). If some agents of a
# group are up and others down, it stops and says so; `--restart-agents` then restarts that group.
# Ends with scripts/preprod-status.sh. Secrets stay in .env, which the started scripts load.
#
# Usage: scripts/preprod-up.sh [--restart-agents]
set -euo pipefail
# shellcheck source=lib/preprod-common.sh
source "$(cd "$(dirname "$0")" && pwd)/lib/preprod-common.sh"
restart_agents=0
[[ "${1:-}" == "--restart-agents" ]] && restart_agents=1
mkdir -p "$agents_data" "$lisan_b_data"

# wait_for <what> <seconds> <command...>: polls every 5 s until the command succeeds.
wait_for() {
  local what="$1" secs="$2"
  shift 2
  for _ in $(seq 1 $((secs / 5))); do
    "$@" && { echo "  $what: ready"; return 0; }
    sleep 5
  done
  echo "  $what: not ready after ${secs}s" >&2
  return 1
}

all_200() {
  local url
  for url in "$@"; do [[ "$(http_code "$url" 10)" == "200" ]] || return 1; done
}

echo "1/5 Masumi payment services"
masumi_urls=()
for p in "${masumi_ports[@]}"; do masumi_urls+=("http://localhost:$p/api/v1/health"); done
if all_200 "${masumi_urls[@]}"; then
  echo "  already up"
else
  bash "$root/infra/masumi-up.sh"
  wait_for masumi 120 all_200 "${masumi_urls[@]}"
fi

echo "2/5 chain services"
services_cli=("node" "$root/services/run/dist/cli.js")
if ! "${services_cli[@]}" status >/dev/null 2>&1; then
  [[ -f "$root/services/run/dist/cli.js" ]] || "$root/scripts/heavy.sh" pnpm -C "$root" turbo run build --filter="./services/*"
  # The supervisor spawns itself detached (setsid) and is a no-op when already running.
  "${services_cli[@]}" start preprod
  wait_for "services (4/4 healthy)" 180 "${services_cli[@]}" status >/dev/null
fi
"${services_cli[@]}" status | sed 's/^/  /'

# The Conductor and the TS agents run Temporal workers on the local compose's dev server (default
# queue; the local stack uses its own queue). Only that container is started here: starting the rest
# of the local compose would recreate the devnet.
if ! nc -z 127.0.0.1 27233 2>/dev/null; then
  docker compose -f "$root/infra/docker-compose.local.yml" up -d --wait --wait-timeout 300 temporal
fi
echo "  temporal: 127.0.0.1:27233 open"

echo "3/5 Conductor, TS agents and Lisan"
group_urls=()
for i in "${!agent_names[@]}"; do
  [[ "${agent_names[$i]}" == "lisan-b" ]] || group_urls+=("http://127.0.0.1:${agent_ports[$i]}/availability")
done
group_urls+=("http://127.0.0.1:23111/api/v1/health")
up=0
for url in "${group_urls[@]}"; do [[ "$(http_code "$url" 10)" == "200" ]] && up=$((up + 1)); done
if [[ "$up" -eq "${#group_urls[@]}" && "$restart_agents" -eq 0 ]]; then
  echo "  already up"
else
  if [[ "$up" -gt 0 && "$restart_agents" -eq 0 ]]; then
    echo "  $up of ${#group_urls[@]} agent endpoints answer; restarting the group stops the live ones too." >&2
    echo "  Rerun with --restart-agents once the lead agrees (no demo or acceptance tree live)." >&2
    exit 1
  fi
  if [[ "$restart_agents" -eq 1 ]]; then
    # The run script only starts; without this, live agents keep their ports and the new ones die on
    # EADDRINUSE while the health check passes against the old code. Pidfiles can be stale, so free the
    # group's ports by listener rather than trusting them.
    "$root/scripts/run-preprod-agents.sh" stop || true
    group_ports=(23111)
    for i in "${!agent_names[@]}"; do
      [[ "${agent_names[$i]}" == "lisan-b" ]] || group_ports+=("${agent_ports[$i]}")
    done
    for port in "${group_ports[@]}"; do
      for pid in $(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
    done
    for _ in $(seq 1 30); do
      busy=0
      for port in "${group_ports[@]}"; do lsof -nP -t -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && busy=1; done
      [[ "$busy" -eq 0 ]] && break
      sleep 1
    done
    if [[ "$busy" -ne 0 ]]; then echo "  agent ports still held after stop; not starting" >&2; exit 1; fi
  fi
  drop_stale_pidfiles "$agents_data"/*.pid
  # The run script backgrounds each agent and exits; in the new session they outlive the terminal.
  pid="$(detach "$agents_data/run-preprod-agents.out" "$root/scripts/run-preprod-agents.sh" start)"
  echo "  launched scripts/run-preprod-agents.sh (pid $pid)"
  wait_for "agents and Lisan shim" 300 all_200 "${group_urls[@]}"
fi

echo "4/5 Lisan-B"
lisan_b_urls=("http://127.0.0.1:24011/availability" "http://127.0.0.1:23112/api/v1/health")
if all_200 "${lisan_b_urls[@]}"; then
  echo "  already up"
else
  drop_stale_pidfiles "$lisan_b_data"/*.pid
  pid="$(detach "$lisan_b_data/run-lisan-b.out" "$root/scripts/run-lisan-b.sh" start)"
  echo "  launched scripts/run-lisan-b.sh (pid $pid)"
  wait_for "Lisan-B and its shim" 300 all_200 "${lisan_b_urls[@]}"
fi

echo "4/5 Sokosumi Coworker"
coworker_url="http://127.0.0.1:$coworker_port/availability"
if all_200 "$coworker_url"; then
  echo "  already up"
else
  drop_stale_pidfiles "$agents_data/agent-cascade-coworker.pid"
  "$root/scripts/run-coworker.sh" start | sed 's/^/  /'
  wait_for "Cascade Coworker" 120 all_200 "$coworker_url"
fi

echo "5/5 agents gateway and tunnel"
drop_stale_pidfiles "$agents_data/gateway.pid"
if [[ -f "$agents_data/gateway.pid" ]] && [[ "$(http_code "http://127.0.0.1:$gateway_port/conductor/availability" 10)" == "200" ]]; then
  echo "  already up (pid $(cat "$agents_data/gateway.pid"))"
else
  # The gateway loads NGROK_AUTHTOKEN and NGROK_DOMAIN from .env itself and hands the token to ngrok
  # through its environment; ngrok runs as its child in the same detached session.
  pid="$(detach "$agents_data/gateway.log" "$root/node_modules/.bin/tsx" "$root/scripts/agents-gateway.ts")"
  echo "$pid" >"$agents_data/gateway.pid"
  echo "  launched scripts/agents-gateway.ts (pid $pid)"
fi
base="$(public_base)"
[[ -n "$base" ]] || { echo "  no public base in $runtime_file" >&2; exit 1; }
wait_for "public $base/conductor/availability" 120 all_200 "$base/conductor/availability"

echo
"$root/scripts/preprod-status.sh"
