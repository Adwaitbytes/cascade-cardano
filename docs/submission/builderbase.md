# Cascade: BuilderBase submission

TOKEN2049 Origins, Cardano track (Masumi and Sokosumi).

Values in `{{DOUBLE_BRACES}}` come from the paid Task proof in [docs/sokosumi-coworker.md](../sokosumi-coworker.md). Fill them from that file before submitting.

## Title

Cascade

## Tagline

Give one Task to one Coworker; it hires a team of agents and pays each one from Masumi escrow on Cardano, only for checked work.

## Description (150 words)

Cascade is a Sokosumi Coworker that turns one Task into a tree of hired AI agents. You give it a goal and pay once. Cascade plans the work, commits the plan on chain, and locks the budget in a root escrow on Cardano. It hires specialist agents (research, pricing, writing, checking), and each hire gets its own child escrow drawn from the parent's budget. Hired agents can hire sub-agents the same way. Validators enforce the rules: a child can never hold more than its parent drew for it, a child's deadlines end before its parent's, and only tasks in the committed plan can be paid. Checker agents verify results before money moves. If an agent misses its deadline, anyone can trigger a refund that sends the money up the tree to a replacement. You get the deliverable and a receipt linking every payment to a preprod transaction.

## Problem

Agent marketplaces pay one agent for one job. Useful work needs several agents: one researches, one prices, one writes, one checks. Today the agent that coordinates them has to front the money for every sub-hire and trust each one to deliver. The buyer cannot see who did the work or what each part cost, and a failed sub-agent means lost money, not a refund. Masumi's own workshop slide states the goal: "Every hire, at every level, is paid into escrow". Nothing enforced that past the first hop.

## Solution

Cascade enforces escrow at every level of the hiring chain, on chain.

- **Committed plan.** The buyer signs a plan; its Merkle root is stored in the root escrow. A Draw can only fund a child whose spec is a leaf of that plan.
- **Validator-checked child escrows.** Each node of the tree is its own UTxO with a thread token, budget, nested deadlines and an acceptance rule. A parent cannot submit while a child is open.
- **Verifier quorum.** Checker agents vote on results; a challenged result goes to arbiters with bonds at stake.
- **Refunds up the tree.** A missed deadline lets anyone crank a refund. The child's whole value returns to its parent in one transaction and is spent on a replacement. When the root closes, the buyer gets back every unused lovelace.

## How it uses Masumi, Sokosumi and x402

| Piece | What Cascade does with it |
| --- | --- |
| **Sokosumi** | Cascade is a Coworker in the TOKEN2049 workspace. It picks up Tasks assigned to it, posts the `masumiPayment` event so Sokosumi funds escrow from the buyer's credits, runs the tree, and completes the Task with the deliverable and a payment report. |
| **Masumi** | The Coworker is registered on the Masumi V2 registry and paid through Masumi `vested_pay` escrow: signed terms from our Masumi Payment Service, result hash submitted on chain, seller withdrawal after unlock. Inside the tree, unmodified Masumi agents (Lisan runs the crewai-masumi-quickstart template) are hired through their MIP-003 flow, and their refunds go only to the buyer. 12 registrations on the Masumi V2 registry: 11 tree agents ([deployments/agents.preprod.json](../../deployments/agents.preprod.json)) plus the Coworker. |
| **x402** | Agents price and pay each other with x402 on Cardano. A Cascade agent answers `POST /jobs` with HTTP 402 and two offers: pay into a Cascade child escrow, or into a Masumi `vested_pay` lock. Cheap tool calls run on cumulative vouchers in a channel, so hundreds of calls settle in a few L1 transactions. |

## What is new compared with existing Cardano tools

- **Masumi `vested_pay`** escrows one buyer and one seller. Cascade nests escrows: each hire draws a child escrow from its parent, so escrow holds at every depth, not one hop.
- **x402 on Cardano** pays one request. Cascade binds every x402 payment to a task in the buyer-signed plan, and the payee can never be the orchestrator's own key.
- **Payment channels (Subbit)** stream small payments between two parties. Cascade puts the channel inside the tree as a receipt node, so its unspent deposit returns to the parent.
- We checked ArgoOperator, ANTIDOTE, Sentinel, Proof Pair, NightPay, cardano402 and Subbit.xyz (PRD section 3.1). Each handles one hop, a pool or a channel. None ships a tree of escrows with deadline nesting and refunds up the tree.

## Tech stack

- **On chain:** 7 Aiken scripts (Plutus V3, Aiken v1.1.24): `cascade_node`, three withdraw-zero logic scripts, `cascade_config`, `cascade_bond`, `cascade_channel`. Deployed as reference scripts on preprod; hashes in [deployments/preprod.json](../../deployments/preprod.json).
- **Off chain:** TypeScript with Lucid Evolution; Temporal workflows for the orchestrator; Postgres indexer; x402 facilitator; watchtower; policy signer with 8 gates.
- **Agents:** Conductor, Scout, Pricer, Scribe, Checkers A to C, Lookup API (metered), Lisan (unmodified Masumi CrewAI template), and two labelled test agents that fail on purpose.
- **Clients:** Next.js web app on Vercel (console, live Tree Explorer, receipts, directory), MCP server, CLI, TypeScript and Python SDKs.

## Links

| What | Link |
| --- | --- |
| Agent code | https://github.com/Adwaitbytes/cascade (Coworker worker: `agents/cascade-coworker/`) |
| Deployed agent URL | https://caenogenetic-varnishy-shaunte.ngrok-free.dev/cascade-coworker |
| Sokosumi Coworker ID | `01a110cd-4ee0-763b-ae63-4008564c9f8e` (vendor `01a110cd-2605-751f-8fdf-f310dbf883b8`, TOKEN2049 workspace) |
| Masumi registration tx | [27f2aa49f924...](https://preprod.cardanoscan.io/transaction/27f2aa49f9245d826b1837745d2a54d247f857ced77a7a2ef36856da7b8906a3) |
| Live site | https://cascade-alpha-amber.vercel.app |
| Buyer console | https://cascade-alpha-amber.vercel.app/console |
| Agent directory API | https://cascade-alpha-amber.vercel.app/api/v1/agents |
| Demo video | {{VIDEO_URL}} |

## Proof

| Item | Value |
| --- | --- |
| Sample completed Task | `01a114cd-37f6-75fc-a2a4-3859ed85b11b` |
| Seller payment receipt (Sokosumi) | `Sokosumi completion event 01a11529-e05d-7778-b032-4da2d79ebb0f` |
| Masumi escrow lock for that Task | [3585e64c0afb16d19c711ced384180170d2c256090c68cdc81aee076598a1623](https://preprod.cardanoscan.io/transaction/3585e64c0afb16d19c711ced384180170d2c256090c68cdc81aee076598a1623) |
| Seller withdrawal | [db84039e31a7706f4454380de0a26815df26fb4b856534839ba3000ddd8d5f77](https://preprod.cardanoscan.io/transaction/db84039e31a7706f4454380de0a26815df26fb4b856534839ba3000ddd8d5f77) |
| Cascade tree for that Task | https://cascade-alpha-amber.vercel.app/tree/4b50da32cf987ecdccbf0b421b5269161e3ac84651476ed30bb045bf |
| Tree receipt | https://cascade-alpha-amber.vercel.app/receipt/4b50da32cf987ecdccbf0b421b5269161e3ac84651476ed30bb045bf |
| Root funded | [f22e344be8d2002d9d7995f8103f61239f3e1a2c232519f4d72429376d282512](https://preprod.cardanoscan.io/transaction/f22e344be8d2002d9d7995f8103f61239f3e1a2c232519f4d72429376d282512) |

Proof already on chain, independent of the Task above:

- Every redeemer of the escrow tree ran on preprod, each transaction read back and decoded: [README table](../../README.md#every-redeemer-on-preprod). For example FundRoot [a4d28ac98a37...](https://preprod.cardanoscan.io/transaction/a4d28ac98a371dd43eadf8cef3ca2c6f417dd07bc05e90a2ce48d5c402708cdf), made on the redeployed scripts on 2026-10-06.
- Live preprod activity on the redeployed scripts: [cascade-alpha-amber.vercel.app/economy](https://cascade-alpha-amber.vercel.app/economy), read from the indexer, with every number linked to its transactions.
- 735 Aiken tests (672 unit, 63 property), 0 failures ([demo/out/aiken-check.json](../../demo/out/aiken-check.json)); contract audit and re-review in [security/](../../security/).

## Team

{{TEAM_NAMES_AND_ROLES}}

## What's next

- **Mainnet path:** a second contract audit, then mainnet with Masumi's mainnet `vested_pay` and USDM budgets (preprod trees run in ADA because the treasury holds no preprod tUSDM).
- **Trustless Masumi leaves:** the on-chain `MasumiReceipt` path already works; it needs Masumi's Payment Service to accept locks created by a script transaction (blocker B6), which removes the purchase wallet custody window.
- **More Coworkers as sub-agents:** hire other Sokosumi Coworkers as leaves of a tree, so any Sokosumi agent can be part of a Cascade team.
- **Reputation-weighted planning:** use the per-agent on-chain outcomes the indexer already records to pick and price hires.
