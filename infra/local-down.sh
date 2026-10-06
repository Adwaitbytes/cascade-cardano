#!/usr/bin/env bash
# Stops the Cascade local stack (web, agents, services, then Docker infra) and deletes its volumes. The devnet is recreated
# from genesis on every start, so keeping Postgres or MinIO data would only leave
# rows that point at a chain that no longer exists.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$root/services/run/dist/services.js" ]]; then
  "$root/node_modules/.bin/tsx" "$root/scripts/local-stack.ts" down
fi
docker compose -f "$root/infra/docker-compose.local.yml" down --volumes --remove-orphans
