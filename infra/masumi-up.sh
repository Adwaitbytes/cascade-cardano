#!/usr/bin/env bash
# Starts the preprod Masumi Payment Service instances (orchestrator, lisan, lisan-b). Generates any missing
# secrets into .env first (values are never printed).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/node_modules/.bin/tsx" "$root/scripts/masumi-secrets.ts"
docker compose --env-file "$root/.env" -f "$root/infra/docker-compose.masumi.yml" up -d --build --wait --wait-timeout 900
echo "Masumi Payment Service up: orchestrator http://localhost:23100/api/v1, lisan http://localhost:23101/api/v1, lisan-b http://localhost:23102/api/v1"
