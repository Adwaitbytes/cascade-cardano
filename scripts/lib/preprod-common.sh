#!/usr/bin/env bash
# Shared by scripts/preprod-up.sh and scripts/preprod-status.sh: the preprod process inventory and
# its health probes. Sourced, never run. Reads no secrets.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
agents_data="$root/infra/.data/agents"
lisan_b_data="$root/infra/.data/lisan-b"
runtime_file="$root/deployments/agents.preprod.runtime.json"

masumi_ports=(23100 23101 23102)
masumi_names=(orchestrator lisan lisan-b)
# Agent name and local port, pairwise; TS ports from agents/kit/src/roles.ts, Lisan ports from scripts/lib/agents.ts.
agent_names=(conductor scout pricer lookup-api flaky-lisan checker-a checker-b checker-c scribe lisan lisan-b)
agent_ports=(24001 24002 24003 24004 24005 24006 24007 24010 24008 24009 24011)
gateway_port=24100
# The Sokosumi Coworker worker (agents/cascade-coworker), started by scripts/run-coworker.sh.
coworker_port=24012

# Prints the HTTP status of a GET, or 000 when nothing answers.
http_code() {
  curl -s -o /dev/null -m "${2:-5}" -H 'ngrok-skip-browser-warning: 1' -w '%{http_code}' "$1" 2>/dev/null || true
}

# The public base of the gateway, from the runtime file the gateway writes.
public_base() {
  [[ -f "$runtime_file" ]] || return 0
  jq -r '.agents[] | select(.agent == "conductor") | .publicUrl // empty' "$runtime_file" | sed 's#/conductor$##'
}

# A pid file left over from before a reboot can name a pid the OS has since given to an unrelated
# process; the run scripts kill whole process groups by pid file, so drop any pid file whose process
# is not one of ours (its command line names this repo).
drop_stale_pidfiles() {
  local f pid
  for f in "$@"; do
    [[ -f "$f" ]] || continue
    pid="$(cat "$f")"
    if ! [[ "$pid" =~ ^[0-9]+$ ]] || ! ps -o command= -p "$pid" 2>/dev/null | grep -qF "$root"; then
      rm -f "$f"
    fi
  done
}

# Runs a command in a new session (no controlling terminal), immune to SIGHUP, stdin from /dev/null,
# so it survives the terminal that started it. macOS has no setsid(1); perl's POSIX::setsid does it.
detach() {
  local log="$1"
  shift
  nohup perl -MPOSIX -e 'POSIX::setsid() or die "setsid: $!"; exec @ARGV or die "exec: $!"' -- "$@" </dev/null >>"$log" 2>&1 &
  echo $!
}
