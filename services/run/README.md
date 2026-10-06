# Cascade chain services runner

Runs the indexer, x402 facilitator, signer and watchtower on this machine under one supervisor.

```bash
pnpm turbo run build --filter="./services/*"            # build once after changes
pnpm --filter @cascade/services-run services start       # preprod (default); `start local` for Yaci
pnpm --filter @cascade/services-run services status      # pid, restarts and /health per service
pnpm --filter @cascade/services-run services logs indexer
pnpm --filter @cascade/services-run services stop
```

| Service | Port (127.0.0.1) | Health |
| --- | --- | --- |
| indexer and directory API, WebSocket at /v1/ws | 26100 | `GET /health` |
| x402 facilitator (`/verify`, `/settle`, `/supported`) | 26200 | `GET /health` |
| signer (`POST /v1/sign`, `GET /v1/gate-logs`) | 26300 | `GET /health` |
| watchtower | 26400 | `GET /health` |

- The supervisor restarts a service that exits, with backoff from 1 s to 30 s, reset after 60 s up.
- Logs go to `services/run/logs/<service>.log`, rotated at 50 MB. State goes to `services/run/state/`. Both folders are git-ignored.
- `state/signer.token` and `state/directory-admin.token` are generated on first start (mode 600). The orchestrator reads `signer.token` as the bearer token for `/v1/sign`. Never print them.
- Secrets come from the repo-root `.env`, which each service loads itself: `CASCADE_TREASURY_MNEMONIC`, `BLOCKFROST_PROJECT_ID_PREPROD` and `DATABASE_URL_PREPROD` (Neon).
- On preprod without its own node, the services query Blockfrost and use Koios `/ogmios` for evaluate and submit. The indexer polls the Cascade script addresses 6 blocks deep. Set `OGMIOS_URL` to use an own node with chain-sync instead.
- The signer holds the conductor, specialist (scout, pricer, lookup-api, scribe, flaky-lisan), checker-a, checker-b, checker-c and arbiter-1 to arbiter-3 keys. It never holds treasury, buyer, oracle, facilitator or watchtower keys.

## Restart safety

Every service can be killed at any point and restarted:

- **Indexer:** each block is written in one Postgres transaction. A restart resumes from the stored chain points (chain-sync) or the poll cursor (Blockfrost), and skips transactions it already applied.
- **Facilitator:** claims live in `x402_claims`. A retry after a crash finds the claim and only observes the chain; it never broadcasts again.
- **Watchtower:** cranks are keyed by the UTxO they spend. A crank left `building` by a killed process is taken over after 5 minutes. If the first attempt landed, the UTxO is spent and the crank is never selected again.
- **Signer:** keeps no state between requests. Velocity limits are read from `gate_logs`.
- **Migrations:** run in one transaction under a transaction-scoped advisory lock. A session lock leaks through Neon's pooling endpoint when a process is killed, and blocks every later start.
- **Reputation anchor:** skips the transaction when the CIP-68 datum on chain already carries the root.
