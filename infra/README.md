# Cascade local stack

One command brings up every component: chain infra, seeding, chain services, reference agents
with Conductor, and the web app.

```bash
pnpm local:up     # infra, seed, build, services, agents, web; health-checks each and prints a summary (about 2 min)
pnpm local:down   # stops web, agents and services, then the Docker infra, and deletes all volumes
npx tsx scripts/local-stack.ts status   # summary table at any time; exit 1 if anything is unhealthy
```

`pnpm local:up` needs Docker and `CASCADE_TREASURY_MNEMONIC` in the repo-root `.env`.
`CASCADE_SKIP_SEED=1` skips funding, minting and script deployment; `CASCADE_INFRA_ONLY=1` stops after
the Docker infra and seeding. A recorded run is in `infra/local-stack-smoke.txt` (20/20 healthy).

### Application layer (`scripts/local-stack.ts`)

| Component | Port | Health | Started as |
| --- | --- | --- | --- |
| indexer, facilitator, signer, watchtower | 36100, 36200, 36300, 36400 | `GET /health` | W3's service specs (`services/run`), moved to a 36xxx block |
| conductor (console API at `/v1`) | 34001 | `GET /availability` | `agents/conductor` |
| scout, pricer, lookup-api, flaky-lisan, checker-a, checker-b, scribe, checker-c | 34002 to 34008, 34010 | `GET /availability` | `agents/<role>` with `CASCADE_<ROLE>_PORT` |
| web | 3100 | `GET /console` | `next dev`, pointed at the local indexer and Conductor |

- Ports are the preprod ones plus 10000, so the local stack runs next to the preprod services
  (26xxx, `services/run`) and preprod agents (240xx) on the operator machine.
- Services get `CASCADE_NETWORK=local`; agents also get the local indexer, signer, facilitator,
  Postgres and Temporal URLs, and `CASCADE_ALLOW_UNREGISTERED=1`. Bearer tokens for the signer and the
  directory admin API are generated into `infra/.data/local/*.token` (mode 600) and never printed.
- Lisan is not part of the local stack: it is the unmodified Masumi template, and the Masumi Payment
  Service only runs against preprod (see the Masumi section).
- Logs and PIDs: `infra/.data/local/<component>.log` and `.pid` (git-ignored).

## Services and ports

All ports bind to `127.0.0.1`. They sit in a 2xxxx block (Postgres on 55432) so the
stack does not collide with other projects on the same machine. Scripts read them from
`deployments/local.json`; do not hardcode them.

| Service | Host port | URL |
| --- | --- | --- |
| Ogmios v6.14 (bundled with Yaci) | 21337 | `ws://localhost:21337`, HTTP JSON-RPC on the same port |
| Kupo v2.11 (bundled with Yaci) | 21442 | `http://localhost:21442` |
| Yaci Store, Blockfrost-compatible | 28080 | `http://localhost:28080/api/v1` |
| Yaci admin API | 20000 | `http://localhost:20000/local-cluster/api/admin/devnet`, topup at `/local-cluster/api/addresses/topup` |
| cardano-submit-api | 28090 | `http://localhost:28090/api/submit/tx` |
| Node-to-node, node-to-client (socat) | 23001, 23333 | |
| Yaci Viewer | 25173 | `http://localhost:25173` |
| Postgres 16 | 55432 | `postgres://cascade@localhost:55432/cascade` |
| Temporal dev server | 27233, UI 28233 | namespace `cascade` |
| MinIO | 29000, console 29001 | |

Local-only credentials default to `cascade` / `cascade-local` and can be overridden with
`CASCADE_LOCAL_PG_PASSWORD`, `CASCADE_LOCAL_MINIO_USER` and `CASCADE_LOCAL_MINIO_PASSWORD`.

## Devnet facts

- Yaci DevKit v0.12.0-beta5: cardano-node 11.0.1, protocol version 11 (same as preprod), network magic 42.
- Slot length 1 s, block time 1 s, epoch 600 slots, security parameter 100.
- `maxTxExUnitsMem` is raised to 17,500,000 in `yaci/node.properties` to match preprod.
- Lucid network `"Custom"`. Slot config is `{ zeroTime: startTime * 1000, zeroSlot: 0, slotLength: 1000 }`,
  where `startTime` comes from the admin devnet endpoint. It changes on every start, so read it at
  runtime (`localSlotConfig()` in `scripts/lib/network.ts`).
- Evaluation fails with `PastHorizon` when `validTo` is more than 300 s past the tip. Keep windows under 240 s.
- The devnet is recreated from genesis whenever the `yaci` container starts. `pnpm local:down` drops
  every volume for that reason: Postgres or MinIO rows would refer to a chain that no longer exists.
- Kupo does not index genesis UTxOs. Wallets are funded by admin topups, which are real transactions,
  so both Kupmios and the Yaci Store provider see them.

## Scripts (`scripts/`)

Run from the repo root with `pnpm --filter @cascade/scripts <name> -- --network local|preprod`,
or `npx tsx scripts/<file>.ts --network ...`. Any network other than `local` or `preprod` is refused.

| Script | Does |
| --- | --- |
| `derive-wallets.ts` | Derives the 22 role wallets (account index 0 to 22, 21 reserved for the gate-log key) and writes `deployments/wallets.{preprod,local}.json`: role, index, address, payment and stake key hashes. No keys. |
| `fund-wallets.ts --network local` | Tops up every wallet, treasury included, through the Yaci admin API. |
| `fund-wallets.ts --network preprod` | Sends one tx from the treasury to every wallet below 90% of its target and appends it to `deployments/funding.preprod.json`. |
| `mint-test-usdm.ts --network local` | Mints 100,000.000000 tUSDM (6 decimals) to the buyer under a treasury-key native script and records the policy in `deployments/local.runtime.json`. |
| `deploy-scripts.ts --network local\|preprod [--dry-run] [--blueprint f] [--out f]` | Applies parameters in dependency order (config, bond, channel, then logic_core, logic_draw and logic_ext, then node; ADR 1.4), publishes each script as a reference script, registers the three logic stake credentials and writes `deployments/preprod.json`, or `deployments/local.runtime.json` on local. Idempotent. `--dry-run` builds every tx and submits nothing. |
| `check-env.ts [--strict]` | Lists which variables are set (names only) and probes every local and preprod endpoint. |

Targets in ADA: buyer 3000; conductor, scout, pricer 200; lookup-api, lisan, flaky-lisan,
checker-a, checker-b, checker-c, scribe, oracle, facilitator 100; watchtower 150; attacker 50; masumi-purchaser 30; qa-buyer 300; qa-cranker 50; demo-buyer 400; arbiters 20.
The preprod treasury keeps the rest.

Preprod has no tUSDM for Cascade (`PREPROD_TUSDM_AVAILABLE=false`), so preprod trees are funded in
lovelace; see `deployments/preprod.json`.

## Static and runtime deployment files

- `deployments/local.json` (committed) holds only static facts: ports, URLs, network magic, slot length.
- `deployments/local.runtime.json` (git-ignored) holds what changes each time the devnet is recreated:
  `devnetStartTime`, `slotConfig.zeroTime`, `testToken`, and the script deployment (`scripts`,
  `stakeRegistrations`, `referenceScriptHolder`, `blueprintSha256`) in the same shape as
  `deployments/preprod.json`. It is keyed by `devnetStartTime`; data from an older devnet is dropped.
  Readers on local should merge it over `local.json` and check `devnetStartTime` against the admin API.

## Reference script holder

Reference scripts are paid to the native script `all [ sig <treasury key>, any [] ]`.
`any []` is false in the ledger, so nothing can ever spend these outputs. The treasury clause only
makes the address unique to Cascade: the bare `any []` address is used by other projects on preprod,
and listing its UTxOs through Blockfrost stalls. The ADA locked there (about 200 ADA for all seven
scripts) is gone for good, by design. On local, a duplicate stake registration is detected from the
ledger's rejection, because Yaci Store and Ogmios 6.14 do not report script credential registration.

### Lisan-B (A4: Masumi refund)

Lisan-B is a second copy of the unmodified crewai-masumi-quickstart-template at the same pinned
commit as Lisan, configured with an invalid model id
(`openrouter/cascade-test/no-such-model-fails-on-purpose`), so every job errors and no result is ever
submitted. Test agent: fails on purpose to demonstrate Masumi refunds.

| Item | Value |
| --- | --- |
| Payment service | third instance `masumi-lisan-b`, `http://localhost:23102/api/v1` (own selling wallet and database) |
| Agent | `127.0.0.1:24011`, public `https://caenogenetic-varnishy-shaunte.ngrok-free.dev/lisan-b` |
| Run | `scripts/run-lisan-b.sh [start|stop]` (checks the pinned, unmodified checkout in `infra/.data/lisan-b/template`, reuses Lisan's Python environment and V1-to-V2 shim on port 23112) |

**Deadlines cannot be shortened by configuration.** `pip-masumi` 1.2.0 (`masumi/payment.py`), which
the template uses to create the payment request, hard-codes `payByTime = now + 12 h` and
`submitResultTime = now + 24 h`; the template passes no times. The payment service
(`src/routes/api/payments/index.ts`) then defaults `unlockTime = submitResultTime + 6 h` and
`externalDisputeUnlockTime = submitResultTime + 12 h`. Neither has an environment setting. So Lisan-B
runs with payByTime +12 h, submitResultTime +24 h, unlockTime +30 h and externalDisputeUnlockTime
+36 h from the payment request. Shortening them would need a code change (in the agent, its client
library or the shim), which the unmodified-agent rule rules out.

## Troubleshooting

- `docker compose -f infra/docker-compose.local.yml logs -f yaci` shows devnet startup. It is ready
  when the log shows `Yaci Store Started` and the container reports healthy.
- MinIO comes from `cgr.dev/chainguard/minio`, pinned by digest, because `minio/minio` images are no
  longer published on Docker Hub or Quay.

## Preprod processes on this machine

```bash
scripts/preprod-up.sh                    # start everything below in order, detached, then print status
scripts/preprod-status.sh [--local-only] # one row per process and public URL; exit 1 if anything is down
```

| Step | Component | Port | Started by |
| --- | --- | --- | --- |
| 1 | Masumi payment services orchestrator, lisan, lisan-b | 23100, 23101, 23102 | `infra/masumi-up.sh` (Docker, `restart: unless-stopped`) |
| 2 | indexer, facilitator, signer, watchtower | 26100 to 26400 | `services/run` supervisor (detached itself) |
| 2 | Temporal dev server for the Conductor's worker | 27233 | the `temporal` service of `infra/docker-compose.local.yml`, only that service |
| 3 | Conductor, scout, pricer, lookup-api, flaky-lisan, checker-a, checker-b, checker-c, scribe; Lisan and its shim | 24001 to 24010; shim 23111 | `scripts/run-preprod-agents.sh` |
| 4 | Lisan-B and its shim | 24011; shim 23112 | `scripts/run-lisan-b.sh` |
| 5 | agents gateway and ngrok static domain | 24100 | `scripts/agents-gateway.ts` |

- **Survives a closed terminal.** Steps 3 to 5 run in a new session (`POSIX::setsid` through perl,
  since macOS has no `setsid(1)`) under `nohup` with stdin from `/dev/null`; the services supervisor
  detaches itself. Nothing is tied to the terminal that ran the script.
- **Idempotent.** A step whose endpoints already answer 200 is skipped, so a second run restarts
  nothing. When only part of the agent group answers, the script stops and names the count;
  `--restart-agents` restarts the group (only with the lead's go-ahead and no live demo or
  acceptance tree).
- **After a reboot.** Docker brings the Masumi containers back by itself. Run `scripts/preprod-up.sh`
  for the rest. Pid files left from before the reboot are dropped unless their process command line
  names this repo, so a reused pid is never killed.
- **Shared Temporal.** The preprod Conductor uses the default task queue on the local compose's
  Temporal server; the local stack's Conductor uses `cascade-orchestrator-local`, so neither runs the
  other's trees. `pnpm local:down` deletes the Temporal volume, which also drops preprod workflow
  history: do not run it while a preprod tree is in flight.
- **Public URLs.** `https://<NGROK_DOMAIN>/<agent>/availability` (send `ngrok-skip-browser-warning: 1`).
  The console API has no health route; status treats `404 plan_not_found` on
  `/conductor/v1/plans/<unknown id>` as healthy.
- Logs: `infra/.data/agents/` (agents, gateway, `run-preprod-agents.out`), `infra/.data/lisan-b/`,
  `services/run/logs/`. All git-ignored.

## Masumi Payment Service (preprod)

Two instances, one per operator (PRD 15.5), each with its own database in one Postgres 16 container.

```bash
pnpm masumi:up     # generate missing secrets into .env, build, start, wait for health
pnpm masumi:down   # stop; volumes are kept (they hold the encrypted hot-wallet keys)
```

| Instance | Operator | API | Admin key variable |
| --- | --- | --- | --- |
| `masumi-orchestrator` | Cascade orchestrator, buys from Masumi leaves | `http://localhost:23100/api/v1` | `MASUMI_ORCH_ADMIN_KEY` |
| `masumi-lisan` | Lisan agent operator, sells as a Masumi agent | `http://localhost:23101/api/v1` | `MASUMI_LISAN_ADMIN_KEY` |

Health is `GET /api/v1/health`, Swagger is at `/docs`, the admin UI at `/admin/`. Public data (URLs,
V2 hot wallet addresses) is in `deployments/masumi.preprod.json`.

- Image: built from upstream commit `69297f30` (main, 2026-09-26), newer than release 0.28.0.
  `infra/masumi/Dockerfile` explains why the published 0.28.0 image cannot seed a V2 payment source.
  The seed registers a `Web3CardanoV2` source at the live preprod escrow
  `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g` (2-of-3 Masumi admin multisig).
- Secrets: `scripts/masumi-secrets.ts` appends missing values to `.env` and never prints them:
  `MASUMI_PG_PASSWORD`, and per instance (`MASUMI_ORCH_*`, `MASUMI_LISAN_*`) `ADMIN_KEY`,
  `ENCRYPTION_KEY`, `PURCHASE_WALLET_V2_PREPROD_MNEMONIC`, `SELLING_WALLET_V2_PREPROD_MNEMONIC`.
  The Blockfrost key comes from `BLOCKFROST_PROJECT_ID_PREPROD`.
- Hot wallets are fresh mnemonics, not derived from `CASCADE_TREASURY_MNEMONIC`. The service needs
  24-word mnemonics it can store encrypted, and keeping them separate means a compromised payment
  service cannot reach the treasury or any Cascade role key. Fund them from the treasury as needed.

### Can it run against Yaci locally?

No, not without forking the service. It hardcodes preprod and mainnet:

- `getBlockfrostInstance` builds `new BlockFrostAPI({ projectId, network: "preprod" | "mainnet" })`
  and Mesh's `BlockfrostProvider(apiKey)` derives the host from the key prefix. There is no base URL
  setting, so it cannot be pointed at Yaci Store's Blockfrost-compatible API on :28080.
- The `Network` enum is `Preprod | Mainnet`; there is no custom network magic or slot config.
- The seed refuses to start unless the derived escrow address equals the hardcoded preprod address.
- Dispute settlement needs signatures from Masumi's own admin keys.

So Masumi leaves are tested against these preprod instances. For Yaci, the option is to drive the `vested_pay`
V2 validator directly with Lucid, applied with Cascade-held test admin keys.

### Masumi Registry Service: not needed

The Directory reads the V2 registry policy `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b`
straight from chain: Blockfrost `GET /assets/policy/{policy}` then `GET /assets/{unit}`
(`onchain_metadata`, CIP-25 label 721), with Koios `policy_asset_info` as fallback. The registry
service does the same Blockfrost reads and caches them in its own Postgres, so it adds a service and
a database without adding trust: the policy is permissionless, and the Directory must apply its own
allowlist either way (docs/research/masumi-registry.md). Agent registration goes through the
payment service's `POST /registry`, which does not depend on the registry service.
