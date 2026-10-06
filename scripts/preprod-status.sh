#!/usr/bin/env bash
# One table for everything Cascade runs on this machine for preprod: Masumi payment services, chain
# services, agents and Lisan shims, the agents gateway and the public agent URLs. Exit 1 if anything
# is down. Reads no secrets.
#
# Usage: scripts/preprod-status.sh [--local-only]   (--local-only skips the public URL probes)
set -uo pipefail
# shellcheck source=lib/preprod-common.sh
source "$(cd "$(dirname "$0")" && pwd)/lib/preprod-common.sh"

down=0
row() {
  # row <group> <name> <url> <code>
  local mark=ok
  [[ "$4" == "200" ]] || { mark=DOWN; down=$((down + 1)); }
  printf '%-9s %-13s %-4s %s %s\n' "$1" "$2" "$mark" "$4" "$3"
}

for i in "${!masumi_ports[@]}"; do
  url="http://localhost:${masumi_ports[$i]}/api/v1/health"
  row masumi "${masumi_names[$i]}" "$url" "$(http_code "$url")"
done
for svc in indexer:26100 facilitator:26200 signer:26300 watchtower:26400; do
  url="http://127.0.0.1:${svc#*:}/health"
  row service "${svc%%:*}" "$url" "$(http_code "$url")"
done
for i in "${!agent_names[@]}"; do
  url="http://127.0.0.1:${agent_ports[$i]}/availability"
  row agent "${agent_names[$i]}" "$url" "$(http_code "$url" 10)"
done
url="http://127.0.0.1:$coworker_port/availability"
row agent cascade-coworker "$url" "$(http_code "$url" 10)"
for shim in lisan:23111 lisan-b:23112; do
  url="http://127.0.0.1:${shim#*:}/api/v1/health"
  row shim "${shim%%:*}" "$url" "$(http_code "$url")"
done
url="http://127.0.0.1:$gateway_port/conductor/availability"
row gateway local "$url" "$(http_code "$url" 10)"

if [[ "${1:-}" != "--local-only" ]]; then
  base="$(public_base)"
  if [[ -z "$base" ]]; then
    row public base "(no $runtime_file)" 000
  else
    for name in "${agent_names[@]}"; do
      url="$base/$name/availability"
      row public "$name" "$url" "$(http_code "$url" 20)"
    done
    # The console API has no health route; an unknown plan id answering 404 shows /v1 is served.
    url="$base/conductor/v1/plans/00000000-0000-0000-0000-000000000000"
    code="$(http_code "$url" 20)"
    [[ "$code" == "404" ]] && code=200
    row public "conductor/v1" "$url" "$code"
  fi
fi

if [[ "$down" -eq 0 ]]; then echo "all healthy"; else echo "$down down"; fi
[[ "$down" -eq 0 ]]
