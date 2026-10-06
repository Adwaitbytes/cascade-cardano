# Hackathon redeploy: switch-over runbook

Goal: every on-chain artefact of the TOKEN2049 Origins submission is created on or after 2026-10-06. The scripts get new hashes from the deployment tag (ADR 0001, "Hackathon redeploy"). This runbook moves the preprod stack from the old folder (`~/Desktop/cardano`) to this copy (`~/Desktop/cascade-cardano`). Preprod only, never mainnet.

Do not start step 3 while a demo, acceptance tree or paid Sokosumi Task is live on the old stack, and only with the lead's go-ahead.

## New script hashes (tag `cascade/token2049/2026-10-06`)

| Script | Hash |
| --- | --- |
| `cascade_config` | `71c7b6bab9332b7684b8995fb66d7021d508626d364fb2824abbc445` |
| `cascade_bond` | `c658bb48805bf32d2c6bb1dca7b13fbb3567a67a150d9fba6664245f` |
| `cascade_channel` | `b6e93a267107e300194fbc6d836914aa10239eee2f32a9ea427cd071` |
| `cascade_logic_core` | `98ac3c2a0ace0f95750bcc9a9a912ed23e0407a483397a6d056ac9f8` |
| `cascade_logic_draw` | `66dcfce908741d5bdfea7aad54ad8779785983be4c0838544aeb09e1` |
| `cascade_logic_ext` | `aaf22cdcc8c27a42328ec16c09a77bdebf8dcf27c7f49eb4d22b27d9` |
| `cascade_node` | `1eea6bd1b08cf9a466eed7ca7a8d9ab53aa8ed1526ed3281b785ba07` |

Every one differs from the Oct 1 deployment (`deployments/preprod.json` before this change).

## 1. Prepare the copy (nothing on chain)

```sh
cd ~/Desktop/cascade-cardano
cp ~/Desktop/cardano/.env .env                       # never print it; Masumi needs the same MASUMI_PG_PASSWORD
cp -R ~/Desktop/cardano/.vercel .vercel               # or: vercel link
cp ~/Desktop/cardano/deployments/agents.preprod.runtime.json deployments/   # run-preprod-agents.sh reads it
grep -c '^CASCADE_NODE_HASH=' .env                    # must print 0: it would override the new node hash
scripts/heavy.sh pnpm install --frozen-lockfile
scripts/heavy.sh pnpm turbo run build
scripts/heavy.sh pnpm aiken:build && git diff --exit-code contracts/plutus.json   # reproducible
```

## 2. Deploy the scripts (new on-chain artefacts)

Check the treasury first (Cardanoscan preprod, address in `deployments/wallets.preprod.json`, role `treasury`). Seven reference outputs lock about 185 ADA in total (min-UTxO of about 4.3 ADA per KB of script) plus three stake deposits of 2 ADA and fees.

```sh
pnpm -C scripts exec tsx deploy-scripts.ts --network preprod --dry-run
pnpm -C scripts exec tsx deploy-scripts.ts --network preprod \
  --supersede-reason "hackathon redeploy: deployment tag cascade/token2049/2026-10-06"
```

The script publishes seven reference-script UTxOs at the treasury's always-fail holder, registers the three logic stake credentials and rewrites `deployments/preprod.json`, keeping the Oct 1 block under `superseded`. Record the printed Cardanoscan links. Then set `urls.explorer_demo_tree` and `urls.receipt` to `null` in `preprod.json` (they point at old trees) and commit `deployments/preprod.json`.

Done 2026-10-06 from this copy: first tx `efa55635…` at slot 135603932, block 5260469 (11:45:32 UTC); last stake registration `5513ef99…` at slot 135604358, block 5260489. Treasury before deploy: 6,545 ADA. Use `INDEXER_START_HEIGHT=5260469`.

## 3. Stop the old stack (old folder, lead's go-ahead only)

```sh
cd ~/Desktop/cardano
scripts/run-coworker.sh stop
scripts/run-lisan-b.sh stop
scripts/run-preprod-agents.sh stop
kill -- -"$(cat infra/.data/agents/gateway.pid)"     # agents gateway and ngrok; the static domain allows one session
node services/run/dist/cli.js stop                   # indexer, facilitator, signer, watchtower
```

Masumi payment services (compose project `cascade-masumi`) and Temporal (`cascade-local`) are shared by project name and can stay up. Ports the old stack held: 23100-23102, 23111-23112, 24001-24012, 24100, 26100-26400, 27233.

## 4. Fresh state so old trees are not mixed in

- Database: create a new Neon database (or branch) and set its URL as `DATABASE_URL_PREPROD` in the copy's `.env` (and unset `CASCADE_DATABASE_URL` if present). The same variable feeds the services, the Conductor and Vercel. Do not share one database between old and new stacks: each indexer would see the other's script fingerprint and truncate its tables.
  ```sh
  pnpm -C scripts exec tsx migrate-preprod.ts
  ```
  If a new database is not possible, the indexer's fingerprint check already truncates `node_events, node_utxos, chain_points, nodes, trees, redeemer_budgets` and the cursor on the hash change; truncate by hand `plans, quotes, quote_requests, verdicts, gate_logs, x402_claims, x402_results, reputation, reputation_snapshots, watchtower_cranks, dispute_alerts, plan_specs, challenge_reasons, masumi_slot_failures, artefacts` and the `orchestrator_*` tables.
- Indexer start: set `INDEXER_START_HEIGHT` in `.env` to the block height of the first reference-script tx from step 2 (Cardanoscan shows it), so the purchaser wallet's pre-Oct-6 history is not scanned. `deployedAt` is not used for this.
- Temporal: terminate old-tree workflows in namespace `cascade`, queue `cascade-orchestrator`, or recreate the `temporal-data` volume of `cascade-local` (no tree may be live).
- Coworker: do not copy `infra/.data/coworker`; it starts with an empty Task journal.
- Signer: no reference-UTxO allowlist; it reads the node, config and logic hashes from `preprod.json` at start. Old `gate_logs` rows go with the old database.

## 5. Start the new stack

```sh
cd ~/Desktop/cascade-cardano
scripts/preprod-up.sh            # Masumi, services (fresh tokens in services/run/state), agents, Lisan-B, Coworker, gateway
scripts/preprod-status.sh
```

## 6. Masumi registrations

Masumi does not depend on Cascade hashes (`MASUMI_V2_APPLIED_HASH` is Masumi's own contract). The agent registry NFTs in `deployments/agents.preprod.json` were minted on 2026-10-01, so under the "on or after Oct 6" rule they are old artefacts. Re-mint them (new agent ids are written back to `.env` as `CASCADE_AGENT_ID_*`):

```sh
pnpm -C scripts exec tsx register-agents.ts --update    # burn and re-mint every agent NFT
```

The Coworker registers itself from `agents/cascade-coworker/registration.preprod.json`. Restart the agents group afterwards so they pick up the new ids: `scripts/preprod-up.sh --restart-agents`.

## 7. Web

`apps/web/next.config.ts` bundles `deployments/preprod.json`, `wallets.preprod.json` and `contracts/plutus.json`, and `web-deploy.ts` builds a clean worktree of HEAD, so commit them first.

```sh
pnpm -C scripts exec tsx vercel-env.ts      # pushes DATABASE_URL (new database) and the other web env vars
pnpm -C scripts exec tsx web-deploy.ts      # deploys and rewrites preprod.json urls; commit that change
curl -s https://cascade-alpha-amber.vercel.app/api/deployment | jq '.scripts.cascade_node.hash'   # expect 1eea6bd1...
```

## 8. Refresh text that names old hashes

`README.md` (deployment table), `apps/web/src/lib/fixtures/source.ts` (`FIXTURE_DEPLOYMENT`), `apps/web/src/lib/plan/fixtures/fund-preview-ada.json`, `demo/out/redeemers.{md,json}` and `evidence/A1` to `A20` (rerun `pnpm verify:all` on the new deployment; never hand-edit `test-results.json`).
