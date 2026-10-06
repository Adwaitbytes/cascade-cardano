# Yaci DevKit: digest (verified by running it)

## Pins

| Item | Pin |
|---|---|
| Release used | **`v0.12.0-beta5`** (tag commit `29e000052f5cec7e1fdf3605ef9605c855a70963`, 2026-06-15). Docker zip `yaci-devkit-0.12.0-beta5.zip`. Images `bloxbean/yaci-cli:0.12.0-beta5`, `bloxbean/yaci-viewer:0.12.0-beta5`. |
| Why beta5 | The README compatibility table lists three lines. **Preprod is already on PV11** (Koios `epoch_params` epoch 316: `protocol_major 11`), so the PV11 line is the one that matches preprod. |
| | `v0.10.6`, stable, node 10.1.4 |
| | `v0.11.0-beta1`, node 10.5.0, PV10 |
| | `v0.12.0-beta5`, **node 11.0.1 / PV11** |
| npm | `@bloxbean/yaci-devkit` dist-tags: `latest 0.10.6`, `beta 0.12.0-beta5`, `preview 0.12.0-preview1` |
| `main` HEAD | `2b0db4a5…` (2026-09-30) is `0.12.0-beta6-SNAPSHOT`. Its README claims Ogmios v7.0.0 / Kupo v2.12.0, but **that is not what beta5 ships.** |
| Components in beta5 (measured) | `cardano-node 11.0.1`, **Ogmios `v6.14.0.2`** (`/health`), **Kupo `v2.11.0.1`**, Yaci Store, Yano (bootstrap node), MCP server |

## Run it (Docker distribution, exact commands that worked)

```bash
curl -sL -o yd.zip https://github.com/bloxbean/yaci-devkit/releases/download/v0.12.0-beta5/yaci-devkit-0.12.0-beta5.zip
unzip yd.zip && cd yaci-devkit-0.12.0-beta5
# beta5 ships ogmios_enabled=false, kupo_enabled=false; turn both on:
sed -i '' 's/^ogmios_enabled=false/ogmios_enabled=true/; s/^kupo_enabled=false/kupo_enabled=true/' config/env
bash scripts/start.sh                     # = ./bin/devkit.sh start minus the interactive CLI; brings up containers node1-yaci-cli-1, node1-yaci-viewer-1
# Create + start the devnet NON-interactively (CLI reads stdin; keep stdin open or the shell exits and stops the node):
(printf 'create-node -o --start\n'; sleep 7000) | docker exec -i node1-yaci-cli-1 /app/yaci-cli.sh > yaci-run.log 2>&1 &
```

- Interactive equivalent: `./bin/devkit.sh start`, then `yaci-cli:> create-node -o --start`. The prompt becomes `devnet:default>`.
- Startup log ends with:
  - `Started ogmios : http://localhost:1337`
  - `Started kupo : http://localhost:1442`
  - `Yaci Store tx evaluator mode: ogmios`
  - `Yaci Store synced to chain tip`
- To stop: `./bin/devkit.sh stop`. It runs `docker compose … kill`, and the `cluster-data` volume persists.
  - For a clean slate, run `docker compose --env-file ../config/env --env-file ../config/version down -v` from `scripts/`.
  - `reset` inside the CLI wipes chain data and keeps the config.
- Do not run two `yaci-cli.sh` processes in the container at once. The second one dies with `BindException: Address already in use` on :10000.
- Non-Docker alternatives (from the docs, not run here):
  - npm: `npm i -g @bloxbean/yaci-devkit@beta`, then `yaci-devkit up --enable-yaci-store --enable-kupomios`.
  - Native zip: `yaci-cli-0.12.0-beta5-macos-ARM64.zip`, then `./yaci-cli`.
  - The docs say consensus-rollback testing is more reliable in those two distributions.

### `create-node` flags

| Flag | Meaning |
|---|---|
| `-o` / `--overwrite` | Overwrite an existing node |
| `--start` | Start after creating |
| `-b` / `--block-time <sec>` | Block time; default 1, sub-second allowed |
| `-s` / `--slot-length <sec>` | Slot length; default 1 |
| `-e` / `--epoch-length <slots>` | Docs say default 500. **Measured: 600.** |
| `--era conway` | Era |
| `--enable-multi-node` | 3 producers, needed for consensus rollback |

- Genesis and protocol overrides go in `config/node.properties`: `securityParam`, `maxTxExUnitsMem`, `protocolMajorVer`, `initialAddresses[n]`, and so on.
- Service toggles and ports go in `config/env`.
- Ogmios and Kupo can also be started later from the CLI with `enable-kupomios` / `kupomios-start`, or through the admin API (`POST /local-cluster/api/admin/ogmios/start-kupomios`).

## Endpoints and ports (Docker defaults)

| Service | URL |
|---|---|
| Yaci Store (Blockfrost-compatible) | `http://localhost:8080/api/v1/`; Swagger at `http://localhost:8080/swagger-ui.html` |
| Admin / cluster API + MCP + CIP-30 wallet | `http://localhost:10000`; OpenAPI at `/v3/api-docs`; MCP at `/mcp`; wallet at `/wallet` (injects `window.cardano.yacidevkit`) |
| Ogmios | `ws://localhost:1337`. HTTP JSON-RPC POST also works on the same port. |
| Kupo | `http://localhost:1442`, started with `--since origin --match *` |
| Viewer | `http://localhost:5173` |
| Node | n2n `3001`; n2c via socat `3333`; submit-api `8090`; Yano HTTP `6060` |

Yaci Store endpoints checked live:

- All return 200:
  - `GET /blocks/latest`
  - `GET /epochs/latest/parameters`
  - `GET /addresses/{addr}/utxos`
  - `GET /addresses/{addr}/utxos/{unit}`
  - `GET /txs/{hash}` and `GET /txs/{hash}/utxos`
  - `GET /accounts/{stake}`
  - `GET /assets/{unit}/addresses`
  - `GET /network`
- `POST /tx/submit` (application/cbor) returns 400 on junk, so the route exists.
- `POST /utils/txs/evaluate` and `POST /utils/txs/evaluate/utxos` return the **Ogmios v5-style** envelope `{"result":{"EvaluationResult":{"publish:0":{"memory":…,"steps":…}}}}`.
- `/api/v1/genesis` does **not** exist. Use the admin API (below).

## Network parameters (measured on this devnet)

| Param | Value |
|---|---|
| Network magic | **42** (`protocolMagic`, Shelley `networkMagic`) |
| Network id | Testnet, so addresses are `addr_test…` |
| Lucid network name | `"Custom"` |
| Slot length | 1000 ms (`slotLength 1.0`) |
| Block time | 1 s |
| `activeSlotsCoeff` | 1.0 |
| Epoch length | **600 slots** |
| `securityParam` (k) | 100 |
| Safe zone / forecast horizon | 3k/f = **300 slots** (Ogmios `eraSummaries.safeZone = 300`) |
| Protocol version | **11** |
| `max_tx_ex_mem` / steps | **16,500,000** / 10,000,000,000 (preprod: **17,500,000** / 10,000,000,000) |
| `coins_per_utxo_size` | 4310 (same as preprod) |
| `min_fee_a` / `min_fee_b` | 44 / 155381 |
| `key_deposit` | 2,000,000 lovelace |
| `min_fee_ref_script_cost_per_byte` | 15 |
| `maxTxSize` | 16384 |
| Zero time | `startTime` from `GET :10000/local-cluster/api/admin/devnet` (unix **seconds**), equal to Shelley `systemStart` (`2026-09-30T21:46:58Z`, which is `1790804818`). Slot 0 = zero time, verified: block at slot 1904 has `time 1790806722` = `1790804818 + 1904`. The node starts "in the past" (Yano companion mode), so **read `startTime` at runtime** and do not assume "now". |
| Slot config | `{ zeroTime: startTime*1000, zeroSlot: 0, slotLength: 1000 }` |

## Funding

- **Default wallets:** 20 addresses from the mnemonic `test test test test test test test test test test test test test test test test test test test test test test test sauce`. Address #N is at `m/1852'/1815'/N'/0/0`, i.e. **account index N**, each holding 10,000 ADA.
  - Lucid `selectWallet.fromSeed(mnemonic, { accountIndex: N })` produced exactly these addresses (verified for N = 0, 1, 19).
  - Address #0 is `addr_test1qryvgass5dsrf2kxl3vgfz76uhp83kv5lagzcp29tcana68ca5aqa6swlq6llfamln09tal7n5kvt4275ckwedpt4v7q48uhex`.
- **These are genesis UTxOs** (yaci-store shows `block_height: -1`). **Kupo does not index genesis UTxOs**, so a Kupmios provider sees an empty wallet and Lucid fails with "Your wallet does not have enough funds". Yaci Store (Blockfrost) sees them. **For Kupmios, top up first**; a topup is a real tx that Kupo indexes.
- **Topup through the CLI:** `topup <address> <ada>`.
- **Topup through the admin API (verified):**
  ```bash
  curl -X POST localhost:10000/local-cluster/api/addresses/topup \
    -H 'content-type: application/json' -d '{"address":"addr_test1…","adaAmount":123}'
  # → {"address":"…","adaAmount":123.0,"status":true,"message":"Topup successful"}   (UTxO visible in yaci-store ~1 block later)
  ```
- Auto-topup at start: set `topup_addresses=addr1:20000,addr2:10000` in `config/env`.
- Native tokens: the `mint` command mints with the faucet key and a default policy. For our own test-USDM, mint it with a script we control.

## Admin API (`:10000`, from `/v3/api-docs`)

| Area | Endpoints |
|---|---|
| Devnet info | `GET /local-cluster/api/admin/devnet` (config incl. `protocolMagic`, `startTime`, `slotLength`, `epochLength`, ports), `/tip`, `/status`, `/genesis/{era}` (e.g. `shelley`), `/genesis/hash`, `/genesis/download` |
| Lifecycle | `POST /local-cluster/api/admin/devnet/create` with body `{genesisProperties:{…}, enableMultiNode, multiNodeStakeRatioFactor, enableYaciStore, enableOgmios, enableKupomios}`; `POST …/admin/devnet/reset` |
| Services | `POST …/admin/ogmios/start-ogmios`, `…/start-kupomios`, `…/stop`, `…/admin/yaci-store/{start,stop,resync}` |
| Funds and transactions | `POST /local-cluster/api/addresses/topup`, `GET /local-cluster/api/addresses/{addr}/utxos`, `POST /local-cluster/api/tx/submit`, `GET /local-cluster/api/txs/{hash}`, `GET /local-cluster/api/epochs/{latest,parameters,{n}/parameters}` |
| Rollback | `POST /local-cluster/api/devnet/rollback/{take-db-snapshot, rollback-to-db-snapshot, create-forks, join-forks, rollback}`. `rollback` takes body `{"blocks": N}`. |
| Wallet (CIP-30 test wallet) | `/api/v1/wallet/*` |

## Rollback tooling (verified behaviour)

| Mechanism | Mode needed | Result here |
|---|---|---|
| `rollback N` (`POST …/rollback/rollback {"blocks":N}`) | **yano-primary mode only** | In the default companion mode it returns `The 'rollback' command is only available in yano-primary mode. Use 'rollback-to-db-snapshot' for other modes.` |
| `take-db-snapshot`, then `rollback-to-db-snapshot` | Any mode (single node) | **Works, but not through consensus.** The node **process is killed and restarted** from the snapshot DB (about 9 s here). The topup tx submitted after the snapshot (`3a9caf81…`, slot 1948) disappeared from **both Yaci Store and Kupo** after the restart. |
| `create-forks` / `join-forks` | `create-node --enable-multi-node --block-time 2 -o --start` | This is a consensus rollback. Docs: submit txs while forked, then `join-forks`, and the isolated low-stake node 1 loses its fork. Docs warn it is **unreliable in the Docker distribution**; use the npm or native zip for it. Not run here. |

What an Ogmios chain-sync client saw during `rollback-to-db-snapshot` (script `$SCRATCH/research-tooling/lucid/chainsync.mjs`):

- The first `nextBlock` after `findIntersection` is **always a `RollBackward` to the intersection point**. That is standard Ogmios behaviour, not a real rollback.
- During the snapshot rollback the node restart **dropped the WebSocket**. The client got **no `RollBackward` message**; the connection just closed.
- On reconnect, `findIntersection` with the now-orphaned tip point returned
  `{"error":{"code":1000,"message":"No intersection found.","data":{"tip":…}}}`.
  Sending a list of points `[recent…, older…, "origin"]` recovers at the newest point still on chain.
- **So the indexer must**:
  1. persist the last N points (at least k = 100 on Yaci, 2160 on preprod);
  2. on reconnect, send them newest first;
  3. treat the found intersection as an implicit rollback to that point.

## Relevance to Cascade

- PRD acceptance A16 ("forced rollback on Yaci reflected in indexer within one block") is achievable in two ways:
  - (a) the snapshot rollback in single-node mode, which the indexer sees as a disconnect plus a re-intersection, not as a `RollBackward` event; or
  - (b) multi-node `create-forks`/`join-forks`, a real `RollBackward`, but flaky under Docker.
- **Transaction validity windows:** on Yaci, `validTo` must be under about 300 s ahead of the tip. Otherwise Ogmios evaluation fails with `3004 CannotCreateEvaluationContext … PastHorizon`; see lucid-evolution.md. On preprod the horizon is 129,600 slots (36 h).
- **Execution budget:** Yaci's `maxTxExUnitsMem` is 16.5 M against 17.5 M on preprod. A tx that fits preprod can fail on Yaci. Either set `maxTxExUnitsMem=17500000` in `node.properties` or budget against the lower value.
