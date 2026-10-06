# Cascade: Cardano Agentic Commerce track

Cascade turns one buyer payment into a tree of agent subcontracts on Cardano. This page shows where x402 and Masumi sit on the money path. Each claim links to a preprod transaction or a test.

## The brief, and where Cascade meets it

| Track ask | How Cascade uses it | Proof |
| --- | --- | --- |
| x402 for agent-to-agent payment | Every hire is an x402 exchange on the Cardano `exact` scheme. A Cascade agent answers `POST /jobs` with HTTP 402 and two offers: `script` (pay into a Cascade child escrow) and `masumi` (pay into a Masumi `vested_pay` lock). | A6: a plain x402 client paid a Cascade agent through the `masumi` method; the lock is [467c99d2ea40...](https://preprod.cardanoscan.io/transaction/467c99d2ea40be9e42d548bc79ec915951a3f8bf92c29b32abaae3ee39649753) ([evidence/A6](../../evidence/A6/result.json)). |
| Masumi for escrow, refunds, identity and discovery | Unmodified Masumi agents are hired through their MIP-003 flow. The tree pays a dedicated purchase wallet `P`, which makes a plain lock in Masumi's own `vested_pay` V2 contract at the canonical script hash; refunds go only to the tree buyer. Agents are found on the Masumi V2 registry. | On-chain Masumi receipt path (test seller): lock [ad5617ecd09b...](https://preprod.cardanoscan.io/transaction/ad5617ecd09b1510821cd9ce2c442e7aefb961cd8e399fecd085254a787192b5), refunded to `buyer_refund` by Masumi's own `WithdrawRefund` [cdd3cf934223...](https://preprod.cardanoscan.io/transaction/cdd3cf934223c590c6abb0b9e9e88b964fd84f978949d700f9c0ef24225d216c), receipt closed [41b453be4ebd...](https://preprod.cardanoscan.io/transaction/41b453be4ebdd4975220d270e2e966529079763c415ebe03d3a192a2a15f140b). |
| Agent identity and discovery | 11 agent registration records on the Masumi V2 registry ([deployments/agents.preprod.json](../../deployments/agents.preprod.json)); the directory API lists them at https://cascade-alpha-amber.vercel.app/api/v1/agents. | Lisan's V2 registry entry [f06dc7513c1b...](https://preprod.cardanoscan.io/transaction/f06dc7513c1ba2b7e6ad223321229bc0b0416f54a4c9fb0144524fe7275a8a55); Conductor's [2e206ae83fde...](https://preprod.cardanoscan.io/transaction/2e206ae83fde6af014d173d3cadcc8986190d28cc0474633eb4e745369369889). |

## x402 is load-bearing

x402 is how agents price and pay each other inside the tree. Without it there is no hire.

1. **Sell side (`script` and `masumi` methods).** A Cascade agent returns `PaymentRequired` with an `exact` offer whose `extra.assetTransferMethod` is `script` (the Draw that funds the agent's child escrow is the payment) or `masumi` (a `vested_pay` lock). The facilitator verifies the signed transaction, settles it and returns `PAYMENT-RESPONSE`. Code: [packages/x402/src/script.ts](../../packages/x402/src/script.ts), [packages/x402/src/sell.ts](../../packages/x402/src/sell.ts).
2. **Buy side (`default` method).** The orchestrator pays third-party x402 Cardano endpoints from the tree budget with an `AddressPayment` child. The payee is bound in the buyer-signed plan and can never be the orchestrator's own key (ADR 0001 section 5.2, acceptance test A10). Code: [packages/x402/src/buy.ts](../../packages/x402/src/buy.ts).
3. **Metered calls.** Cheap tool calls (the Lookup API) are paid with cumulative Ed25519 vouchers against a `cascade_channel` deposit. Hundreds of calls settle in a few L1 transactions, and the unspent deposit returns into the parent node.

On preprod:

- `masumi` method, sell side: a plain x402 client, with no Cascade code, paid a deployed Cascade agent; the facilitator settled the lock [467c99d2ea40...](https://preprod.cardanoscan.io/transaction/467c99d2ea40be9e42d548bc79ec915951a3f8bf92c29b32abaae3ee39649753) and returned `PAYMENT-RESPONSE`; the job ran (acceptance test A6, [evidence](../../evidence/A6/result.json)).
- Metered channel: the receipt Draw that opened a voucher channel to the Lookup API [ad5617ecd09b...](https://preprod.cardanoscan.io/transaction/ad5617ecd09b1510821cd9ce2c442e7aefb961cd8e399fecd085254a787192b5) and its close, which returned the unredeemed deposit into the parent [5dce5000a644...](https://preprod.cardanoscan.io/transaction/5dce5000a644ba7fcd10f1c5f90ccdd5ac9c78fc84b60f2ba98d76f1c083b489). On a second channel the Lookup API redeemed a 1 ADA cumulative voucher signed off chain [8924aab51904...](https://preprod.cardanoscan.io/transaction/8924aab51904951588a261c3b81b1c8d3a1be1734c0eb7454d4aaa83a4f6259a), and the close returned the other 2 ADA into the root [62f5c2630a02...](https://preprod.cardanoscan.io/transaction/62f5c2630a0279ac2f6eae4b89efbef1ee7b0a0e3965ec4a039c8eef439c9691). The 200-call run with at most 3 L1 transactions is acceptance test A7.
- The `default` buy-side payment from a tree budget is acceptance test A5; the self-draw block behind it is A10 ([evidence](../../evidence/A10/result.json)).

## Masumi is load-bearing

Unmodified Masumi sellers are hired through the purchase wallet path of ADR 0001 section 8.1:

1. **Hiring.** The orchestrator calls the agent's MIP-003 `/start_job` and gets the `blockchainIdentifier` and deadlines. A Draw child of kind `AddressPayment` pays exactly the lock amount to the tree's Masumi purchase wallet `P`, a dedicated key bound in the buyer-signed plan and never the operator key.
2. **A plain lock.** `P` makes a plain key-signed `vested_pay` V2 lock (no scripts, no redeemers), so the seller's own Masumi Payment Service sees `FundsLocked` and submits, withdraws, refunds and disputes with unchanged tooling. The lock's `buyer_return_address` is the tree's `buyer_refund`.
3. **Refunds stay with the buyer.** A failed leaf refunds to `buyer_refund`, never to `P` or the orchestrator. The watchtower requests and withdraws the refund after `submit_result_time` without the Conductor (acceptance test A4).
4. **Accounting.** The `AddressPayment` is final for the tree, so the tree may close before the Masumi escrow resolves. The receipt line for the leaf links the Draw, the lock, the `blockchainIdentifier` and the outcome (seller withdrawal or refund).
5. **Trust, stated plainly.** The signer holds `P`'s key and signs for it only the lock, refunds on that lock, or a return of the received amount to `buyer_refund`. Custody lasts from the Draw to the lock, normally one block. A compromised signer could take in-flight Masumi payments; locked funds can only go to the seller or `buyer_refund`. Refund liveness depends on the signer, the watchtower and the purchase wallet holding a little ADA for fees; safety does not: if either service is down, funds wait in the escrow or at the purchase wallet, and the signer cannot send them anywhere but the buyer.
6. **Safety across both contracts.** Every Cascade payout to a key address carries no datum, so one output tagged for Masumi's `WithdrawRefund` can never also satisfy a Cascade exit (evaluator finding E1, tests in `contracts/lib/cascade/tests/evaluator.ak`).

Why not lock straight from the tree: Cascade also has an on-chain `MasumiReceipt` kind, where the Draw itself writes the lock and a receipt node tracks it. The Masumi Payment Service skips any lock created in a transaction with redeemers, so unmodified sellers never see such a lock ([BLOCKERS.md](../../BLOCKERS.md) B6). The kind stays in the contracts for when Masumi accepts script-created locks. It runs on preprod with a test seller key ([demo/out/redeemers.md](../../demo/out/redeemers.md)):

| Step | Transaction |
| --- | --- |
| Draw a Masumi receipt: the `vested_pay` V2 lock (canonical script `a15ce9d8...14ad`) and the receipt node in one transaction | [ad5617ecd09b...](https://preprod.cardanoscan.io/transaction/ad5617ecd09b1510821cd9ce2c442e7aefb961cd8e399fecd085254a787192b5) |
| The seller never submits; Masumi's `WithdrawRefund` pays the whole lock to the tree's `buyer_refund` | [cdd3cf934223...](https://preprod.cardanoscan.io/transaction/cdd3cf934223c590c6abb0b9e9e88b964fd84f978949d700f9c0ef24225d216c) |
| `CloseReceipt` folds the receipt back into the root | [41b453be4ebd...](https://preprod.cardanoscan.io/transaction/41b453be4ebdd4975220d270e2e966529079763c415ebe03d3a192a2a15f140b) |

This run proves the contract path, not hiring a real Masumi agent. Hiring an unmodified agent through `P` is acceptance tests A3 (completion, `blockchainIdentifier` on the receipt) and A4 (refund to `buyer_refund`, in two phases because the template fixes `submit_result_time` 24 hours after the job starts).

## Why it needs Cardano

Each node of a tree is its own UTxO with its own thread token and validator state. Siblings settle in separate transactions with no shared state to contend for. Deadlines are checked against validity intervals, and every state has a deadline exit that any wallet can crank, so no node can be stuck by a silent operator. On preprod the Cascade watchtower did exactly that during our runs: it refunded Flaky Lisan, a test agent that fails on purpose, into its parent [426cd7629b60...](https://preprod.cardanoscan.io/transaction/426cd7629b60a86a3f3064686e21b962daa444ccf024c74de73b6ce982ad6285), and in a console job it refunded a child that missed its deadline [c24c683d0f1b...](https://preprod.cardanoscan.io/transaction/c24c683d0f1ba61f2ca3da9d0e550f89e2b56d6a5c79203d8acc3bb20d23a01f) before the root closed [98ca6753611c...](https://preprod.cardanoscan.io/transaction/98ca6753611c627b85051cddcc3ab922d9142e0684161f7249692e1079c5f89e).

## Where to look

- Every PRD 7.5 redeemer with a preprod transaction: [README](../../README.md#every-redeemer-on-preprod) and [demo/out/redeemers.md](../../demo/out/redeemers.md).
- On-chain design: [docs/adr/0001-onchain-design.md](../adr/0001-onchain-design.md).
- Threat model and audits: [security/](../../security/).
- Research digests of the x402 Cardano spec, MIP-003 and the Masumi payment service: [docs/research/](../research/).
