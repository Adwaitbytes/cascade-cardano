# Cascade

> **Timeline.** Cascade's design and early prototypes started on 2026-10-01, before the TOKEN2049 Origins hackathon. As agreed with the Cardano DevRel team, this repository was created and every on-chain deployment (scripts, reference UTxOs, demo trees and the Sokosumi Coworker's paid Tasks) was made during the hackathon window, 6 to 8 October 2026.


Escrow trees for the agent supply chain on Cardano. The buyer pays once. Every agent down the chain is paid only for verified work. Failed work refunds up the tree.

## For judges: quickstart

Cascade is a Sokosumi Coworker that turns one Task into a tree of hired AI agents, each paid from its own escrow on Cardano preprod.
It is the missing layer on top of Masumi and x402: a committed plan, validator-checked child escrows, a verifier quorum and refunds up the tree.

**Try it on Sokosumi in 3 steps**

1. In the Sokosumi preprod TOKEN2049 workspace, open the Coworker **Cascade Coworker** (ID `01a110cd-4ee0-763b-ae63-4008564c9f8e`).
2. Create a Task with a goal, for example "Compare the prices of three running shoe brands in Singapore and write a one-page brief", and pay with Sokosumi credits. Sokosumi locks the payment in Masumi escrow.
3. Wait for the Task to complete. Its result holds the deliverable, links to the live tree and receipt on https://cascade-alpha-amber.vercel.app, and a table of every agent hired, what each was paid and the preprod transaction that paid it.

| Link | URL |
| --- | --- |
| Live site | https://cascade-alpha-amber.vercel.app |
| Deployed Coworker | https://caenogenetic-varnishy-shaunte.ngrok-free.dev/cascade-coworker |
| Coworker code | [agents/cascade-coworker/](agents/cascade-coworker/) |
| Submission write-up | [docs/submission/builderbase.md](docs/submission/builderbase.md) |
| Agent directory | https://cascade-alpha-amber.vercel.app/api/v1/agents |

| Proof | Link |
| --- | --- |
| Sample completed Sokosumi Task | `{{SOKOSUMI_TASK_ID}}` (see [docs/sokosumi-coworker.md](docs/sokosumi-coworker.md)) |
| Seller payment receipt | `{{SOKOSUMI_RECEIPT}}` |
| Masumi escrow for that Task | `{{MASUMI_LOCK_TX}}` on preprod Cardanoscan |
| Coworker's Masumi registration | [27f2aa49f924...](https://preprod.cardanoscan.io/transaction/27f2aa49f9245d826b1837745d2a54d247f857ced77a7a2ef36856da7b8906a3) |
| Every escrow-tree redeemer on preprod | [table below](#every-redeemer-on-preprod) |
| Failed agent refunded into its parent | [426cd7629b60...](https://preprod.cardanoscan.io/transaction/426cd7629b60a86a3f3064686e21b962daa444ccf024c74de73b6ce982ad6285) |
| x402 client paid a Cascade agent into a Masumi lock | [467c99d2ea40...](https://preprod.cardanoscan.io/transaction/467c99d2ea40be9e42d548bc79ec915951a3f8bf92c29b32abaae3ee39649753) |

## What Cascade is

A buyer locks one budget in a root escrow on Cardano. A prime agent, the Conductor, splits that budget into child escrows for the agents it hires, and those agents can hire their own sub-agents the same way. Every node of the tree is its own UTxO with its own thread token, budget, deadlines and acceptance rule.

The validators decide where money moves. A child can never hold more than its parent drew for it. A parent cannot submit while a child is open. A child node's deadlines always end before its parent's. When an agent misses its deadline, anyone can crank a refund that returns its whole value into the parent, where it is spent on a replacement. When the root closes, the buyer gets back every unused lovelace.

Cascade plugs into what already exists. Agents quote and pay each other with x402 on Cardano. Any unmodified Masumi agent can be hired through its normal MIP-003 flow: the tree pays a dedicated Masumi purchase wallet, which makes a plain lock in Masumi's own `vested_pay` contract with every refund going to the buyer. Cheap tool calls run through voucher channels with a few L1 transactions. LLM agents can hire through the Cascade MCP server.

## Architecture

```mermaid
flowchart TB
  subgraph Clients
    BC["Buyer console<br/>plan review, fund, live tree"]
    MCPC["MCP clients<br/>LLM agents hire through tools"]
    SDKC["SDKs and CLI"]
  end
  subgraph Services["Cascade services: sign under policy"]
    ORC["Orchestrator<br/>plans, hires, verifies, holds no key"]
    SIG["Signer<br/>8 policy gates; holds the Masumi purchase key P"]
    FAC["x402 facilitator<br/>verify, settle, dedupe"]
    WT["Watchtower<br/>permissionless cranks"]
    IDX["Indexer and directory<br/>events, receipts, reputation"]
  end
  subgraph Agents["Agents, any operator"]
    CA["Cascade agents<br/>MIP-003 plus x402 /jobs"]
    MA["Masumi agents, unmodified<br/>paid through purchase wallet P"]
    XA["x402 Cardano APIs<br/>paid by metered vouchers"]
  end
  subgraph Chain["Cardano preprod"]
    CN["cascade_node and 3 logic scripts<br/>one UTxO per node"]
    TC["cascade_config<br/>Tree Config reference input"]
    BD["cascade_bond<br/>challenge and verifier bonds"]
    CH["cascade_channel<br/>voucher channels"]
    VP["Masumi vested_pay V2<br/>leaf escrow, refunds to the buyer"]
  end
  Clients --> Services
  ORC --> SIG --> FAC
  Services <-->|quotes, x402 purchases, verdicts| Agents
  FAC -->|submit signed txs| Chain
  WT -->|cranks| Chain
  Agents -->|submit, withdraw, redeem| Chain
  IDX -.->|reads| Chain
```

The full design is in [docs/PRD.md](docs/PRD.md) (sections 6 to 13) and the frozen on-chain interface in [docs/adr/0001-onchain-design.md](docs/adr/0001-onchain-design.md).

## Live on preprod

| What | URL |
| --- | --- |
| Buyer console | https://cascade-alpha-amber.vercel.app/console |
| Tree Explorer (public, per tree) | https://cascade-alpha-amber.vercel.app/tree/{tree_id} |
| Receipt (public, per tree) | https://cascade-alpha-amber.vercel.app/receipt/{tree_id} |
| Directory API | https://cascade-alpha-amber.vercel.app/api/v1/agents |
| Ops status | https://cascade-alpha-amber.vercel.app/api/v1/ops/status |
| Reference agents (MIP-003) | https://caenogenetic-varnishy-shaunte.ngrok-free.dev/{agent}, for example [/lisan/availability](https://caenogenetic-varnishy-shaunte.ngrok-free.dev/lisan/availability) |

The redeemer showcase tree below is public: [Tree Explorer](https://cascade-alpha-amber.vercel.app/tree/458310f2eacb01e8f6a5750f812f8d4e38d81304359c5467d26f9856) and [receipt](https://cascade-alpha-amber.vercel.app/receipt/458310f2eacb01e8f6a5750f812f8d4e38d81304359c5467d26f9856). The recorded demo tree is linked from `demo/out/cascade-demo.json` once the final recording runs.

## Deployed scripts

Aiken `v1.1.24+bacbeb3`, Plutus V3. Blueprint `contracts/plutus.json`, SHA-256 `0452fa1f0fbbbfd61f74d3c394a025429fe735187db19b30c2ae33fb167dbb51`. Deployed 2026-10-06 11:52 UTC. Every script is a reference script at an address no key can spend. Source: [deployments/preprod.json](deployments/preprod.json).

| Script | Hash | Size | Reference UTxO |
| --- | --- | --- | --- |
| `cascade_node` | `1eea6bd1b08cf9a466eed7ca7a8d9ab53aa8ed1526ed3281b785ba07` | 1,013 B | [febaa2fe...#0](https://preprod.cardanoscan.io/transaction/febaa2fec5500e154998978058203725e9c49c8d3ccec0e3aeb535cb5f0d9aba) |
| `cascade_logic_core` | `98ac3c2a0ace0f95750bcc9a9a912ed23e0407a483397a6d056ac9f8` | 14,980 B | [57d93b79...#0](https://preprod.cardanoscan.io/transaction/57d93b791abe8e8906abeaf7f649008aa0f717210da8a0e645b2d65f3aa8b954) |
| `cascade_logic_draw` | `66dcfce908741d5bdfea7aad54ad8779785983be4c0838544aeb09e1` | 12,503 B | [0e1383bd...#0](https://preprod.cardanoscan.io/transaction/0e1383bd049e7038440d3ca3c475f261fb5af253606116fc0e0a70524f9ca66a) |
| `cascade_logic_ext` | `aaf22cdcc8c27a42328ec16c09a77bdebf8dcf27c7f49eb4d22b27d9` | 11,221 B | [d329ed62...#0](https://preprod.cardanoscan.io/transaction/d329ed6230743de4a2bae2a466ed09e22302926a72acabfdb93f4bece71b0aaa) |
| `cascade_config` | `71c7b6bab9332b7684b8995fb66d7021d508626d364fb2824abbc445` | 671 B | [efa55635...#0](https://preprod.cardanoscan.io/transaction/efa556352641877b4f3762acb3393635c0914c3d71569748d99c17f870643666) |
| `cascade_bond` | `c658bb48805bf32d2c6bb1dca7b13fbb3567a67a150d9fba6664245f` | 761 B | [2c03dd86...#0](https://preprod.cardanoscan.io/transaction/2c03dd8639715251576dad6b854abf7e27f3beb24765a172ca613c7b845afc62) |
| `cascade_channel` | `b6e93a267107e300194fbc6d836914aa10239eee2f32a9ea427cd071` | 1,883 B | [d479322a...#0](https://preprod.cardanoscan.io/transaction/d479322a5f7756b0eb8036f2b1c84353905344d62bb0626460dfef7f0c701555) |

The three logic scripts are withdraw-zero stake validators. Their stake credentials are registered: core [eb10fdec...](https://preprod.cardanoscan.io/transaction/eb10fdec1b8766b1106a2c9542941d97f43b03dacb7f0795c77ec24f5c6f4072), draw [30c77138...](https://preprod.cardanoscan.io/transaction/30c77138f3c795dbd4218ab030ed57d462f14c38152fd70aec2c279054814fd1), ext [5513ef99...](https://preprod.cardanoscan.io/transaction/5513ef9920d9dd7d2dd4cc2f5753e5d9154f1b8a7843aeb4f890429149e64b6a). Why seven scripts and not four: one script with all the logic compiled to 23,286 bytes, above the 16,384-byte transaction limit (ADR 0001 sections 1.3 and 1.4).

## Every redeemer on preprod

Each PRD 7.5 redeemer (plus Escalate from ADR 0001) ran on the current deployment in one scripted run, [demo/redeemers.ts](demo/redeemers.ts). Every transaction was read back from Blockfrost and its Cascade redeemer decoded from the on-chain withdraw redeemer before it was written here. Full table with supporting transactions: [demo/out/redeemers.md](demo/out/redeemers.md).

Main tree `458310f2eacb01e8f6a5750f812f8d4e38d81304359c5467d26f9856`, spare tree `f073ac10fc9d3b0a60b0b31c00991f7879f3188a30f9cb1a14871018`. Lovelace budgets of a few ADA.

| Redeemer | Preprod transaction | What it proved |
| --- | --- | --- |
| FundRoot | [1364b85b0c84...](https://preprod.cardanoscan.io/transaction/1364b85b0c8438064ff25df80911fb4068b2571f55797d30c079e5d08f10e341) | Buyer locks 20 ADA plus 18 ADA structural reserve; root and config thread tokens minted from a one-shot seed; plan root set. |
| TopUp | [d525ce88bd77...](https://preprod.cardanoscan.io/transaction/d525ce88bd775070ad1c5ef0d19ce9ac9d65ae42b60dfbce0c2e7c55b364919e) | Buyer raises the root budget by 1 ADA; nothing else in the datum changes. |
| Freeze | [3478b1545fbf...](https://preprod.cardanoscan.io/transaction/3478b1545fbf8e4bf391ca2849843ad0ddc808687581a0b1160623f43740110f) | Buyer sets frozen on the root; no value moves. Acceptance test A13 checks that a Draw fails while frozen. |
| Unfreeze | [c6c13dc163d5...](https://preprod.cardanoscan.io/transaction/c6c13dc163d58f7872bed6efb0813959ee9e21323a6787909d5bb2d14747b75c) | Buyer clears frozen; Draws are allowed again. |
| Draw (native) | [1461b5e28e73...](https://preprod.cardanoscan.io/transaction/1461b5e28e73678764ab60110cfeea680bd6d7a189d25b48ef14c772e9828914) | Conductor draws Scout, Pricer and Flaky Lisan as native children: three child tokens minted, each spec proven against plan_root, deadlines nested inside the root. |
| Draw (receipt) | [ad5617ecd09b...](https://preprod.cardanoscan.io/transaction/ad5617ecd09b1510821cd9ce2c442e7aefb961cd8e399fecd085254a787192b5) | Conductor draws a Metered receipt (voucher channel to the Lookup API, channel token minted) and a Masumi receipt (vested_pay V2 lock at the canonical Masumi script) in one transaction. |
| Submit | [3f3515dfbdfc...](https://preprod.cardanoscan.io/transaction/3f3515dfbdfca2fcc3b95564f44b754e999d3c769e6fcf8c73f5502cea4a627a) | Scout commits its result hash before submit_by with no open children. |
| Accept | [0d4a943180b7...](https://preprod.cardanoscan.io/transaction/0d4a943180b7e4076145c33ecee6e4f2b560b2b6dfe596e1cd0401f0fad4d145) | The parent operator's signature satisfies Scout's ParentAccept rule. |
| SettleChild | [f93df02f0b7f...](https://preprod.cardanoscan.io/transaction/f93df02f0b7f612277d9a6a7507df25e631d04d1c94c6a0b412ba2e44f4540dc) | Scout's 1 ADA fee goes to its payee, the unused 2 ADA folds back into the root, the child token burns (withdraw-zero settlement). |
| Challenge | [0accdf81c601...](https://preprod.cardanoscan.io/transaction/0accdf81c601e9c8608436f2c960dd4f16cf2c5ce0a4b95a5b1cf25c4a4f2232) | The parent operator challenges Pricer's submitted result before challenge_until and posts a 4 ADA bond at cascade_bond. |
| Escalate | [2cb65930d439...](https://preprod.cardanoscan.io/transaction/2cb65930d439c835813f6674c92de59ab5990d2b46efb8d8c2cefe2eea8b6d8d) | Pricer, the challenged worker, escalates to the arbiters before dispute_until. |
| Resolve | [3b6145b240d1...](https://preprod.cardanoscan.io/transaction/3b6145b240d100d96123b231ed96f1b698ed5c7dfc846643e97f1889472074bb) | Arbiters 1 and 2 (threshold 2) split Pricer's 3 ADA: 1.5 ADA to the worker, 1.5 ADA back into the root. The challenger's bond is slashed 70/30: 2.8 ADA to the worker, 1.2 ADA to the arbiter fee address. |
| Refund | [426cd7629b60...](https://preprod.cardanoscan.io/transaction/426cd7629b60a86a3f3064686e21b962daa444ccf024c74de73b6ce982ad6285) | Flaky Lisan, a test agent that fails on purpose, missed submit_by. After refund_after anyone may crank Refund; its whole value returns into the root in one transaction. Cranked by the Cascade watchtower on preprod before the script reached it. |
| CloseReceipt (Metered) | [5dce5000a644...](https://preprod.cardanoscan.io/transaction/5dce5000a644ba7fcd10f1c5f90ccdd5ac9c78fc84b60f2ba98d76f1c083b489) | Operator and provider close the metered receipt: the part of the 3 ADA deposit the provider did not redeem returns from the channel into the root; channel and receipt tokens burn. |
| CloseReceipt (Masumi) | [41b453be4ebd...](https://preprod.cardanoscan.io/transaction/41b453be4ebdd4975220d270e2e966529079763c415ebe03d3a192a2a15f140b) | After the Masumi lock refunded to buyer_refund, the operator closes the Masumi receipt; parent counters drop and the receipt token burns. |
| CloseRoot | [d00de4aae32c...](https://preprod.cardanoscan.io/transaction/d00de4aae32c5305ca68e3e283b4ab0c6d0aaaf79001fec0132c9c5ff8059217) | Buyer accepted the root; the Conductor gets its 1 ADA fee, everything else (unused budget and all structural ADA) returns to buyer_refund, root and config tokens burn. |
| Cancel | [46c6dc88268c...](https://preprod.cardanoscan.io/transaction/46c6dc88268cced653430f61ce1d5008953f9b016aedbbca28603292b22aa21b) | Buyer cancels a funded tree with nothing drawn: full refund, both tokens burn. |

The Masumi rows use the on-chain `MasumiReceipt` kind: the Draw itself locks into the real `vested_pay` V2 script. Its seller is a test key with short deadlines so the refund ([cdd3cf934223...](https://preprod.cardanoscan.io/transaction/cdd3cf934223c590c6abb0b9e9e88b964fd84f978949d700f9c0ef24225d216c)) runs in minutes. Unmodified Masumi sellers cannot use this path today (see Limitations, B6); they are hired through the purchase wallet path of ADR 0001 section 8.1, which is acceptance tests A3 and A4. A provider `Redeem` of a voucher channel, on a third tree: [8924aab51904...](https://preprod.cardanoscan.io/transaction/8924aab51904951588a261c3b81b1c8d3a1be1734c0eb7454d4aaa83a4f6259a).

## Run it

Requirements: Node 20 or later, pnpm 12, Docker, [Aiken v1.1.24](https://aiken-lang.org), and for the deck [uv](https://docs.astral.sh/uv/). Secrets go in a git-ignored `.env` at the repo root: `CASCADE_TREASURY_MNEMONIC` (preprod only), `BLOCKFROST_PROJECT_ID_PREPROD`, `DATABASE_URL_PREPROD`, `OPENROUTER_API_KEY`. Never use a mainnet key.

```bash
pnpm install
pnpm aiken:check             # validator unit and property tests
pnpm local:up                # Yaci DevKit, Postgres, Temporal, services, agents and web app on one machine
pnpm verify:all              # build, aiken, unit, integration, adversarial, A1 to A20 on preprod, e2e, public URLs
pnpm local:down
```

`pnpm verify:all` is the only writer of [test-results.json](test-results.json).

Demo material (all from `demo/`):

```bash
scripts/heavy.sh pnpm --filter @cascade/demo redeemers           # every PRD 7.5 redeemer on preprod, about 25 min, resumable
scripts/heavy.sh pnpm --filter @cascade/demo web-local -- --build-only # optional: build apps/web at HEAD with the preprod config
pnpm --filter @cascade/demo web-local -- --no-build               # optional: serve it on http://localhost:3100
scripts/heavy.sh pnpm --filter @cascade/demo record -- --stage --dry-run # check the recording pipeline, no money moves
scripts/heavy.sh pnpm --filter @cascade/demo record -- --stage    # the PRD 21.2 flow on preprod -> demo/out/cascade-demo.mp4
scripts/heavy.sh pnpm --filter @cascade/demo shots                # deck screenshots of the recorded tree
cd demo && uv run deck.py                                         # demo/out/cascade-deck.pptx, video embedded in slide 4
```

The recording drives the console with a CIP-30 test wallet injected into the page. It signs as the `demo-buyer` account (index 23), so it never competes with `pnpm verify:all` for the buyer's UTxOs. `CASCADE_DEMO_WEB_URL` points `record` and `shots` at a local build; the deployed site is the default. The key stays in the Node process that runs Playwright and is never sent to the page or logged.

## Test report

| Report | What it holds |
| --- | --- |
| `aiken check` | 735 tests (672 unit, 63 property), 0 failures, 6,972 checks at commit 86cb9a1 ([demo/out/aiken-check.json](demo/out/aiken-check.json)). |
| [test-results.json](test-results.json) | Pass or fail for acceptance tests A1 to A20, the evidence path and the commit each ran on. Written only by `pnpm verify:all`; this file is the source of truth for acceptance status. |
| [evidence/](evidence/) | One `result.json` per acceptance test: assertions, every transaction with its Cardanoscan link, notes. |
| [security/review-report.md](security/review-report.md) | Validator review: the contract audit trail: every audit (F1 to F5) and evaluator (E1 to E14) finding with its fix and regression tests. |
| [security/audit-2026-10-01-21f7228.md](security/audit-2026-10-01-21f7228.md), [security/re-review-2026-10-01-814cc42.md](security/re-review-2026-10-01-814cc42.md) | Independent audit of the contracts and its re-review. |
| [security/threat-model.md](security/threat-model.md) | Trust assumptions, threats T1 to T19 with their on-chain checks and tests, invariants mapped to tests. |
| [tests/adversarial/](tests/adversarial/) | Mutated transactions per redeemer, each submitted to a real node. [report.json](tests/adversarial/report.json) lists every case and the count of unexpected successes, which must be 0. |
| [demo/out/redeemers.json](demo/out/redeemers.json) | The redeemer showcase above, with block heights and decoded on-chain redeemers. |

## Limitations

- **Masumi purchase wallet `P` holds funds briefly.** Unmodified Masumi sellers are hired through ADR 0001 section 8.1: an `AddressPayment` Draw pays the lock amount to a dedicated purchase wallet `P` (bound in the buyer-signed plan, never the operator key), and `P` then makes a plain `vested_pay` lock whose refunds go only to the tree's `buyer_refund`. The signer holds `P`'s key and signs for it only that lock, refunds on such a lock, or a return of exactly the received amount to `buyer_refund`. Custody lasts from the Draw to the lock, normally one block. A compromised signer could take in-flight Masumi payments held by `P`; funds already locked can only go to the seller on delivery or to `buyer_refund`, enforced by `vested_pay`. The watchtower requests and withdraws Masumi refunds for failed leaves without the Conductor.
- **Masumi refunds depend on Cascade services for liveness, not safety.** A failed Masumi leaf is refunded to the buyer without the Conductor: Cascade's watchtower sees the purchase wallet's lock past its result deadline with no result (or a payment it never locked) and asks Cascade's signer to sign as the purchase wallet, which signs only a full refund or return to the tree's `buyer_refund`. Liveness depends on the signer, the watchtower and the purchase wallet holding a little ADA for fees; safety does not: if either service is down, funds wait in the escrow or at the purchase wallet, and the signer cannot send them anywhere but the buyer.
- **B6: the trustless Masumi receipt is unusable with unmodified sellers.** The Masumi Payment Service classifies any lock created in a transaction with redeemers as invalid and skips it, and a Cascade Draw always carries redeemers. So a lock made by a `MasumiReceipt` Draw is never seen by the seller. The on-chain `MasumiReceipt` kind stays in the contracts (it is the one in the redeemer table) for when Masumi accepts script-created locks ([BLOCKERS.md](BLOCKERS.md) B6).
- **Masumi deadlines are not nested.** On the purchase wallet path the Masumi leaf has no tree node, so its deadlines are not checked against the parent's window (a deviation from PRD 7.7). The tree may close before the Masumi escrow resolves; refunds still go to `buyer_refund`. The receipt line tracks the lock, its `blockchainIdentifier` and the outcome.
- **A4 runs in two phases.** The unmodified template fixes `submit_result_time` 24 hours after a job starts, and Masumi allows a refund only after it. So the Masumi refund test locks and requests the refund first, and withdraws at least 24 hours later ([DECISIONS.md](DECISIONS.md)).
- **Lisan shim, two changes.** Lisan runs the crewai-masumi-quickstart-template with its code unmodified. A disclosed shim between the template and its payment service (1) rewrites the payment-source fields of `POST /payment`, because the template's library requests a V1 source and the service has only V2, and (2) adds `filterPaymentSourceType=Web3CardanoV2` to the library's payment-list poll, without which the agent never sees it was paid. The shim is disclosed in the agent's README and on the receipt.
- **Lisan dependency pin.** The template's Python dependencies are pinned to the template's own commit date (crewai 1.6.1, masumi 0.1.41) in `agents/lisan-masumi/requirements.lock`, because newer releases break the unmodified template.
- **Test agents.** Flaky Lisan and Lisan-B are test agents that fail on purpose, to show refunds. They are labelled as test agents in the registry, the UI and the recording.
- **Deterministic LLM fallback.** Product LLM calls go through OpenRouter with a 3 USD spend cap. When the cap is near or a provider is down, agents switch to a deterministic fallback, labelled "deterministic fallback, no LLM" in results, UI and evidence. Chain behaviour is the same either way.
- **Preprod budgets are in ADA.** The treasury holds no preprod tUSDM, so preprod trees are funded in lovelace. The 6-decimal token path is tested on the local devnet.
- **Hosting.** Services and agents run on the operator's machine behind one ngrok domain; the web app runs on Vercel and reads the indexer's Postgres. Agent URLs are stable while that machine runs.
- **Subbit.** Metered leaves use Cascade's own `cascade_channel` validator, which keeps Subbit's cumulative-voucher model but constrains every close output (Subbit's published close path does not).

## Repository

| Path | What |
| --- | --- |
| `contracts/` | Aiken validators, property tests, blueprint |
| `packages/` | `shared` (codecs, Merkle, COSE), `sdk` (tree client and transaction builders), `x402`, `agent`, `orchestrator`, `policy` (signer gates), `mcp`, `cli` |
| `services/` | indexer, facilitator, signer, watchtower, service runner |
| `agents/` | Conductor, Scout, Pricer, Lookup API, Scribe, Checkers, Flaky Lisan, Lisan (Masumi template) |
| `apps/web` | buyer console, Tree Explorer, receipts, provider, arbiter and ops pages |
| `tests/` | acceptance A1 to A20, integration, adversarial, e2e, chaos, load |
| `demo/` | redeemer showcase, recording, deck |
| `docs/` | PRD, ADRs, research notes, submission write-ups |

## Licence

Apache-2.0. See [LICENSE](LICENSE). Third-party code and libraries are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
