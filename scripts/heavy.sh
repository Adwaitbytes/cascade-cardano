#!/usr/bin/env bash
# Runs heavy jobs (test suites, builds, aiken check, Playwright) with at most three at a time
# across all parallel agents, at lowered priority, so the operator's laptop is not saturated.
# Usage: scripts/heavy.sh pnpm --filter @cascade/sdk test
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
slots=("$root/.heavy-job.lock" "$root/.heavy-job-2.lock" "$root/.heavy-job-3.lock")
for _ in $(seq 1 7200); do
  for lock in "${slots[@]}"; do
    if mkdir "$lock" 2>/dev/null; then
      trap 'rmdir "$lock"' EXIT
      nice -n 10 "$@"
      exit $?
    fi
  done
  sleep 1
done
echo "heavy.sh: timed out waiting for a slot" >&2
exit 1
