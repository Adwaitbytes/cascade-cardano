#!/usr/bin/env bash
# Runs the Cascade Coworker (agents/cascade-coworker): the single executor for the Sokosumi Coworker
# in SOKOSUMI_COWORKER_ID. It polls its Sokosumi Tasks, runs each as a Cascade tree on preprod through
# the running Conductor, and is paid through Masumi escrow (orchestrator payment service, :23100).
# Detached in its own session, so closing the terminal stops nothing. Its journals live in
# infra/.data/coworker/ and survive restarts; a restart resumes every open Task where it stopped.
# Secrets stay in .env, which the worker reads itself.
#
# Usage: scripts/run-coworker.sh [start|stop]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
data="$root/infra/.data/agents"
pidfile="$data/agent-cascade-coworker.pid"
log="$data/agent-cascade-coworker.log"
mkdir -p "$data"

stop() {
  [[ -f "$pidfile" ]] || return 0
  local pid
  pid="$(cat "$pidfile")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && ps -o command= -p "$pid" 2>/dev/null | grep -qF "$root"; then
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  fi
  rm -f "$pidfile"
}

if [[ "${1:-start}" == "stop" ]]; then stop; echo "Stopped the Cascade Coworker."; exit 0; fi
stop

cd "$root/agents/cascade-coworker"
CASCADE_NETWORK=preprod nohup perl -MPOSIX -e 'POSIX::setsid() or die "setsid: $!"; exec @ARGV or die "exec: $!"' -- \
  "$root/node_modules/.bin/tsx" src/main.ts </dev/null >>"$log" 2>&1 &
echo $! >"$pidfile"
echo "started the Cascade Coworker (pid $!) on 127.0.0.1:24012; log infra/.data/agents/agent-cascade-coworker.log"
