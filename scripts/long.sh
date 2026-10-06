#!/usr/bin/env bash
# Runs one long, mostly idle job at a time (preprod suites that poll chain deadlines,
# pnpm verify:all) at lowered priority, without taking a scripts/heavy.sh CPU slot.
# Usage: scripts/long.sh pnpm verify:all
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
lock="$root/.long-run.lock"
for _ in $(seq 1 43200); do
  if mkdir "$lock" 2>/dev/null; then
    trap 'rmdir "$lock"' EXIT
    nice -n 10 "$@"
    exit $?
  fi
  sleep 1
done
echo "long.sh: timed out waiting for $lock" >&2
exit 1
