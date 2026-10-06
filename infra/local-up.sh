#!/usr/bin/env bash
# Brings up the full Cascade local stack with one command:
#   1. Docker infra (Yaci DevKit with Ogmios, Kupo and Yaci Store; Postgres; Temporal; MinIO)
#   2. seeding: role wallets funded, local tUSDM minted, Cascade scripts deployed
#   3. build, then chain services, reference agents with Conductor, and the web app
#      (scripts/local-stack.ts), each health-checked, ending with a summary table. After a
#      devnet reset it first empties the local Postgres tables (never Temporal or preprod).
# Set CASCADE_SKIP_SEED=1 to skip step 2, CASCADE_INFRA_ONLY=1 to stop after it.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
compose=(docker compose -f "$root/infra/docker-compose.local.yml")
tsx="$root/node_modules/.bin/tsx"

"${compose[@]}" up -d --wait --wait-timeout 600
"$tsx" "$root/scripts/record-local-runtime.ts"

if [[ "${CASCADE_SKIP_SEED:-0}" != "1" ]]; then
  "$tsx" "$root/scripts/fund-wallets.ts" --network local
  "$tsx" "$root/scripts/mint-test-usdm.ts" --network local
  if [[ -f "$root/contracts/plutus.json" ]]; then
    "$tsx" "$root/scripts/deploy-scripts.ts" --network local
  else
    echo "contracts/plutus.json not built; skipping script deployment (run aiken build in contracts/)."
  fi
fi

if [[ "${CASCADE_INFRA_ONLY:-0}" != "1" ]]; then
  echo "Building services, agents and the web app's dependencies..."
  (cd "$root" && "$root/scripts/heavy.sh" pnpm exec turbo run build --filter="./services/*" --filter="./agents/*" --filter="@cascade/web^...")
  "$tsx" "$root/scripts/local-stack.ts" up
  exit $?
fi

cat <<'MSG'

Cascade local stack is up. Endpoints are in deployments/local.json:
  Ogmios     ws://localhost:21337      Kupo      http://localhost:21442
  Yaci Store http://localhost:28080/api/v1 (Blockfrost-compatible)
  Yaci admin http://localhost:20000    Viewer    http://localhost:25173
  Postgres   localhost:55432/cascade   Temporal  localhost:27233 (UI :28233)
  MinIO      http://localhost:29000 (console :29001)
MSG
