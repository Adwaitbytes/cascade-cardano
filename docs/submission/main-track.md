# Cascade: main track

Escrow trees for the agent supply chain. The buyer pays once. Every agent down the chain is paid only for verified work. Failed work refunds up the tree.

This page maps each judging criterion (PRD section 1) to evidence a judge can open. Transaction links go to Cardanoscan preprod. Test links go to the code that runs.

## Functionality (30%)

Claim: every state change is a real preprod transaction checked by our validators.

| Evidence | Where |
| --- | --- |
| Every PRD 7.5 redeemer, plus Escalate, executed on the current deployment, each transaction read back from chain and its redeemer decoded | [README table](../../README.md#every-redeemer-on-preprod), [demo/out/redeemers.md](../../demo/out/redeemers.md) |
| Buyer console, Tree Explorer and receipts live | https://cascade-alpha-amber.vercel.app/console |
| Acceptance tests A1 to A20 on preprod, written by `pnpm verify:all` only | [test-results.json](../../test-results.json), [evidence/](../../evidence/) |

A few of those transactions: FundRoot [1364b85b0c84...](https://preprod.cardanoscan.io/transaction/1364b85b0c8438064ff25df80911fb4068b2571f55797d30c079e5d08f10e341), Draw of three native children [1461b5e28e73...](https://preprod.cardanoscan.io/transaction/1461b5e28e73678764ab60110cfeea680bd6d7a189d25b48ef14c772e9828914), SettleChild [f93df02f0b7f...](https://preprod.cardanoscan.io/transaction/f93df02f0b7f612277d9a6a7507df25e631d04d1c94c6a0b412ba2e44f4540dc), arbiter Resolve with a bond slash [3b6145b240d1...](https://preprod.cardanoscan.io/transaction/3b6145b240d100d96123b231ed96f1b698ed5c7dfc846643e97f1889472074bb), CloseRoot [d00de4aae32c...](https://preprod.cardanoscan.io/transaction/d00de4aae32c5305ca68e3e283b4ab0c6d0aaaf79001fec0132c9c5ff8059217).

## Technical (25%)

Claim: original Aiken validators, with x402 and Masumi on the money path.

| Evidence | Where |
| --- | --- |
| Seven Aiken scripts (Plutus V3), split to fit the 16,384-byte transaction limit; withdraw-zero logic, thread tokens, Merkle plan membership, nested deadlines | [contracts/](../../contracts/), [docs/adr/0001-onchain-design.md](../adr/0001-onchain-design.md) |
| Deployed hashes, reference UTxOs and blueprint SHA-256 | [README](../../README.md#deployed-scripts), [deployments/preprod.json](../../deployments/preprod.json) |
| 735 Aiken tests (672 unit, 63 property), 0 failures at commit 86cb9a1 ([demo/out/aiken-check.json](../../demo/out/aiken-check.json)); every audit and evaluator finding fixed with regression tests | [security/review-report.md](../../security/review-report.md) |
| Adversarial suite: one changed field per transaction, submitted to a real node; every case must fail, 0 unexpected successes is the pass bar (report.json) | [tests/adversarial/](../../tests/adversarial/) |
| x402 sell side (`script` and `masumi` methods), buy side (`default`), metered vouchers | [cardano-track.md](cardano-track.md) |
| Masumi `vested_pay` V2 leaves, refunds to the buyer, registry discovery | [cardano-track.md](cardano-track.md) |
| TypeScript and Python SDKs, CLI, MCP server | [packages/sdk](../../packages/sdk), [python/cascade-py](../../python/cascade-py), [packages/cli](../../packages/cli), [packages/mcp](../../packages/mcp) |

## Innovation (20%)

Claim: hierarchical escrow. We did not find another Cardano project that ships it. We checked the projects in PRD section 3.1: ArgoOperator, ANTIDOTE, Sentinel, Proof Pair, NightPay, cardano402 and Subbit.xyz; each handles one hop, a pool or a channel, not a tree of escrows.

- A parent draws child escrows from its own budget inside one transaction; each child spec must be a leaf of the buyer-signed plan's Merkle root, so agents can only be paid for tasks the buyer approved.
- Deadlines compose by construction: a child's dispute window plus a safety margin must end before its parent's submit deadline, checked on every Draw.
- A refund from a failed child lands back in the parent's budget in one transaction and is spent again on a replacement. On preprod the watchtower refunded Flaky Lisan, a test agent that fails on purpose, into its parent in one transaction [426cd7629b60...](https://preprod.cardanoscan.io/transaction/426cd7629b60a86a3f3064686e21b962daa444ccf024c74de73b6ce982ad6285).
- Metered voucher channels are receipt nodes inside the tree. Masumi leaves are paid through a purchase wallet and tracked on the receipt by their lock, `blockchainIdentifier` and outcome, so one receipt lists every rail; Masumi refunds land at the buyer's address even after the tree closes.

## Impact (15%)

Claim: multi-agent services become financially safe.

- An orchestrator no longer fronts capital: it hires from the buyer's locked budget.
- The buyer sees who did the work, at what price, with every result hash and transaction on a public receipt.
- Any existing Masumi agent can be hired unmodified, and any MCP client can hire through tools, so the reachable supply is the whole ecosystem.

## Demo (10%)

Claim: a live tree, one failure, one refund that flows up and is re-spent.

- The recording drives the public console and Tree Explorer on preprod with a CIP-30 test wallet. Flaky Lisan and Lisan-B are labelled on screen as test agents that fail on purpose.
- Waits for preprod blocks are sped up with a visible badge. Nothing is cut.
- Rerun it: `scripts/heavy.sh pnpm --filter @cascade/demo record` ([demo/record.ts](../../demo/record.ts)). The video and deck are added to this page once the final recording runs.

## Honest limitations

See [README, Limitations](../../README.md#limitations): the Masumi purchase wallet and its custody window, B6 (Masumi ignores script-created locks), Masumi deadlines outside the tree's nesting, two-phase Masumi refund (24-hour template deadline), the Lisan shim and dependency pin, labelled test agents, the labelled deterministic LLM fallback, and ADA-denominated preprod budgets.
