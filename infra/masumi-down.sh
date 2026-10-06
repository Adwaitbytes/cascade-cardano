#!/usr/bin/env bash
# Stops the Masumi instances. Volumes are kept: the database holds the encrypted
# hot-wallet keys and payment state. Delete them only with `docker volume rm`.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
docker compose --env-file "$root/.env" -f "$root/infra/docker-compose.masumi.yml" down
