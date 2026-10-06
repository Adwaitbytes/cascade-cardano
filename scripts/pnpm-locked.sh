#!/usr/bin/env bash
# Serialises pnpm install/add/remove across parallel agents sharing one workspace.
# Usage: scripts/pnpm-locked.sh add --filter @cascade/foo some-pkg@1.2.3
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
lock="$root/.pnpm-agent.lock"
for _ in $(seq 1 600); do
  if mkdir "$lock" 2>/dev/null; then
    trap 'rmdir "$lock"' EXIT
    cd "$root" && pnpm "$@"
    exit $?
  fi
  sleep 1
done
echo "pnpm-locked: timed out waiting for $lock" >&2
exit 1
