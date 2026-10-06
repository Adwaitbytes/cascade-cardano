# Cascade deck outline

Eight slides for the operator's own deck. Every number below is from the repo; the source is in brackets. Values in `{{DOUBLE_BRACES}}` come from [docs/sokosumi-coworker.md](../sokosumi-coworker.md).

## 1. Cascade

- One Task on Sokosumi. A whole team of agents. Escrow at every level.
- Sokosumi Coworker `01a110cd-4ee0-763b-ae63-4008564c9f8e`, live on Cardano preprod.
- https://cascade-alpha-amber.vercel.app

**Speaker notes.** Cascade is a Coworker you hire on Sokosumi. You give it one Task. It hires the agents it needs, and every one of them is paid from escrow on Cardano, only for checked work.

## 2. The problem

- Real work needs several agents: research, pricing, writing, checking.
- The coordinating agent fronts the money for every sub-hire and trusts each one.
- Escrow stops at the first hop. A failed sub-agent is lost money, not a refund.

**Speaker notes.** Masumi's own workshop slide says "Every hire, at every level, is paid into escrow". Today nothing enforces that past the first hire. The buyer cannot see who did what or what it cost.

## 3. The solution: an escrow tree

- The buyer pays once into a root escrow; the plan is committed on chain as a Merkle root.
- Each hire draws its own child escrow from its parent. Children can hire too.
- Validators enforce budgets, nested deadlines and plan membership. Missed deadline: refund up the tree, re-spent on a replacement.

**Speaker notes.** Every node of the tree is its own UTxO with its own thread token. A child can never hold more than its parent drew for it. A parent cannot submit while a child is open. Anyone can crank a refund after a deadline, so no silent operator can lock funds.

## 4. Demo

- Video: Sokosumi Task, live Tree Explorer, receipt, Masumi escrow on Cardanoscan.
- Task `{{SOKOSUMI_TASK_ID}}`, tree `{{TREE_ID}}`.

**Speaker notes.** Play the 2:30 video or the 20-second hook. Point at the refund: that agent fails on purpose, and its budget flows back up and hires a replacement.

## 5. Built on Masumi, Sokosumi and x402

- Sokosumi: Cascade is a Coworker; Tasks are paid with credits into Masumi escrow.
- Masumi: registry identity for 12 agents, `vested_pay` escrow, unmodified Masumi agents hired through MIP-003 with refunds to the buyer.
- x402: agents quote and pay each other with HTTP 402; metered calls settle on vouchers.

**Speaker notes.** Cascade is the missing layer on top of Masumi and x402. It does not replace them; it nests them. A Cascade agent answers 402 with two offers: pay into a child escrow or into a Masumi lock. [docs/submission/cardano-track.md]

## 6. Proof on preprod

- Every escrow-tree redeemer ran on preprod and was decoded from chain (17 rows, README).
- 112 trees, 536 transactions, 98 payouts to 8 agents, 339.98 ADA paid, 3,236.02 ADA returned to buyers. [landing snapshot, 2026-10-06]
- 7 Aiken scripts, 735 tests with 0 failures; contract audit and re-review. [demo/out/aiken-check.json, security/]

**Speaker notes.** Show the README redeemer table. Click the Refund row: Flaky Lisan, a test agent that fails on purpose, missed its deadline, and the watchtower refunded it into its parent in one transaction.

## 7. What is new

- Masumi escrows one hop; Cascade nests escrows across the whole hiring chain.
- x402 pays one request; Cascade binds every payment to a task the buyer signed off on.
- We checked seven Cardano agent-payment projects; none ships a tree of escrows. [PRD 3.1]

**Speaker notes.** Name them if asked: ArgoOperator, ANTIDOTE, Sentinel, Proof Pair, NightPay, cardano402, Subbit.xyz. Each handles one hop, a pool or a channel.

## 8. What's next

- Second audit, then mainnet with Masumi mainnet escrow and USDM budgets.
- Trustless Masumi leaves once Masumi accepts script-created locks (B6).
- Other Sokosumi Coworkers as leaves of a Cascade tree.

**Speaker notes.** Close on the ask: try the Coworker on Sokosumi, and talk to us if you run agents that hire agents. Show the site URL and the Coworker ID.
