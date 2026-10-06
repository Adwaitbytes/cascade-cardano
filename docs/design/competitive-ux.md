# Cascade competitive UX review

Oct 1, 2026. Scope: web app (`apps/web`), stage demo (PRD 21) and judging (PRD 1). Research only; no code changed.

## 1. Where the app stands

Already built: landing with live preprod totals and a replayed tree, React Flow explorer with animated value edges, node drawer (escrow, deadlines, metered usage, Masumi hires, spec, hashes), replay timeline, d3-sankey money flow and reconciliation on the receipt, Cardanoscan and Cexplorer link builders, skeletons, reduced-motion handling.

Gaps against PRD 14 and against the competitors below:

- No agent profile pages, even though the indexer serves `GET /v1/agents/:asset_id` and `/v1/agents/:asset_id/work`. PRD 3.3 sells "outcome-grounded reputation"; nothing in the UI shows it per agent.
- No per-tree Open Graph images. The tree and receipt pages use static titles ("Tree Explorer", "Receipt"), so a shared link looks the same as every other link.
- No waterfall or duration view. The timeline steps through events but does not show how long each node worked, which is what LangSmith, Temporal and Vercel traces lead with.
- No command palette, no tree search by id or hash, no global "paste a tx hash" entry.
- The receipt reconciles but does not let a judge verify a claim in one click (re-hash the result, check the plan Merkle root, open the exact UTxO).

## 2. Competitors and inspirations

| Product | What it does well | What Cascade should take |
| --- | --- | --- |
| [Sokosumi](https://github.com/masumi-network/sokosumi) / [Masumi](https://www.masumi.network/blogs/the-agent-economys-missing-pieces) | Fiverr-style agent cards, one-click hire, Next.js plus shadcn, on-chain identity and escrow behind a Web2 surface | Agent cards with a "Masumi registered" badge and the registry asset id; show the Masumi `blockchainIdentifier` as first-class proof on Masumi leaves |
| [Cardanoscan](https://preprod.cardanoscan.io) | Tabs per transaction for UTxOs, Contracts (redeemer tag, datum, mem and steps) and Collateral ([example](https://testnet.cardanoscan.io/transaction/a76932ded7e91b2f5d7ca961c39e8ebbe39f85b177dc6bbc761da6a3e485c126?tab=utxo)) | Deep link to the right tab (`?tab=contracts` for redeemers, `?tab=utxo`), and show mem and steps per redeemer in the drawer, labelled as the chain reports it |
| [Cexplorer](https://cexplorer.io/article/understanding-utxo-spending-through-a-script) and [eUTxO.org](https://eutxo.org/) | Explain script spending in plain words; draw inputs and outputs as a graph | A "how this node was spent" sentence in the drawer: "Draw: spent node #3, created 2 children, validator `cascade_node`" |
| [x402scan](https://github.com/Merit-Systems/x402scan) | Ecosystem home with volume, top servers, facilitators and resources; embedded wallet to call a resource from the page ([announcement](https://x.com/jsonhedman/status/1976326303893893466)) | A live "agent economy" home: trees, nodes, value moved, refunds recovered, metered calls, top agents, top x402 endpoints |
| [Virtuals ACP](https://whitepaper.virtuals.io/acp-product-resources/acp-concepts-terminologies-and-architecture) | Clear job lifecycle (open, funded, submitted, completed or rejected); Top Agents leaderboard ranked by aGDP; Engagements module grouping jobs per agent ([changelog](https://whitepaper.virtuals.io/acp/acp-changelogs), [aGDP](https://bex.co/blog/2026/05/09/virtuals-protocol-ai-economic-os-agdp-agent-platform)) | Agent leaderboard by settled value and acceptance rate; per-agent engagements list. Cascade can beat aGDP by ranking on settled, verified value, not notional volume |
| [Olas registry](https://registry.olas.network/) and [Pearl](https://olas.network/blog/introducing-pearl-v1-the-ai-agent-app-store-powered-by-olas) | Service pages tied to on-chain activity; Pearl hides crypto behind Web2 onboarding | Agent page that links every claim to chain activity; plain-language copy everywhere |
| [Fetch.ai Agentverse](https://www.fetch.ai/blog/agentverse-017) | Interaction counts on every agent, "last synced from chain" timestamp, sort by usage, verified-developer filter | Show "indexed at slot N, X seconds ago" on every data view; sort agents by settled nodes |
| [Nevermined](https://nevermined.ai/product/) / [Payman](https://paymanai.com/) / [Crossmint](https://www.crossmint.com/solutions/agentic-payments) | Spend mandates, per-transaction caps and human-in-the-loop shown as policy, every payment logged and auditable | Show the tree's caps (amount, depth, fan-out, deadlines) as a policy card, and the signer's 8 gates as pass marks per hire |
| [Skyfire KYAPay](https://kyapay.org/whitepaper) | "Know your agent": identity attached to every payment | Identity chip on every node: agent DID or Masumi asset, verified or not |
| [Crossmint x402 walkthrough](https://www.crossmint.com/learn/inside-an-x402-transaction) and [Coinbase x402](https://www.coinbase.com/developer-platform/discover/launches/x402) | Explains a 402 payment as four steps with elapsed time ("about two seconds") | A metered-leaf panel that shows request, 402 price, voucher, settle as a four-step strip with timings |
| [Request Finance](https://www.requestfinance.com/) | Invoices that look like real business documents, live payment status without opening an explorer | Receipt laid out as an invoice: header, parties, line items, totals, proofs footer, print and PDF |
| [Superfluid Dashboard](https://medium.com/superfluid-blog/superfluid-dashboard-v2-is-live-a-radical-improvement-in-money-streaming-ux-d418dcf75ee7) | Balances that tick in real time; flows as charts | Ticking "holds now" figure on the root while the tree is live (already have `AmountTicker`; use it in the explorer header) |
| [LangSmith](https://docs.langchain.com/langsmith/observability-concepts) and [Vercel traces](https://vercel.com/changelog/traces-now-support-tree-and-waterfall-views) | Run tree plus waterfall: indentation for nesting, bar length for duration, critical path | A waterfall tab next to the tree: one row per node, bar from Draw to settle, coloured by end state |
| [Temporal UI](https://temporal.io/blog/lets-visualize-a-workflow) | Event groups (scheduled, started, completed collapse into one span); green and red outcomes; retry icon with attempt number; zoom and Fit | Group each node's events into one span; show "replacement for Flaky Lisan, attempt 2" on re-hires |
| [Datadog Request Flow Map](https://www.datadoghq.com/blog/apm-request-flow-map-datadog/) | Edge thickness by volume, redder edges for errors, hover isolates upstream and downstream | Edge stroke width proportional to value drawn; hover a node to dim everything outside its subtree and ancestor path |
| [Linear](https://linear.app) / [cmdk](https://dip-cmdk.mintlify.app/examples/linear) | Keyboard-first command palette with shortcuts on the right | Cmd+K to jump to a tree, agent, node or tx hash, replay, copy receipt link |
| [Stripe Dashboard](https://www.saasframe.io/examples/stripe-payments-dashboard) | Payment detail page with a chronological event timeline and fee breakdown | Receipt line item expands into its own mini timeline of events with tx links |
| [Vercel OG](https://vercel.com/docs/og-image-generation) | Dynamic social cards from JSX at the edge | Per-tree and per-receipt OG image with the tree silhouette and totals |

## 3. Ranked improvements

Effort: S under 2 hours, M half a day, L more than a day. "Safe" means no contract, datum or protocol change; it reads data the indexer already exposes (`/v1/trees`, `/v1/trees/:id`, `/events`, `/nodes/:id`, `/receipt`, `/v1/agents`, `/v1/agents/:id/work`, `/v1/reputation/snapshot/*`, `/v1/ops/status`, `/v1/ws`) or needs a small read-only API addition.

| # | Improvement | Why | Where | Effort | Safe before submission |
| --- | --- | --- | --- | --- | --- |
| 1 | **Stage mode for the explorer.** `?stage=1` hides chrome, enlarges cards and type 1.25x, pins a header with root "holds now" ticking, L1 tx count and metered call count, and auto-plays replay at a slower step (2.5 s) with captions from `describe(event)` | PRD 21.2 steps 3 and 4 need "call counter climbs while L1 tx counter stays at 2" and "parent budget visibly grows back" to read on a projector. Superfluid ticking balances | `tree-explorer.tsx`, `timeline.tsx` | M | Yes |
| 2 | **Refund moment choreography.** On a Refund event: node flashes red then settles grey, a value chip rides the edge upward (already in `value-edge.tsx`), the parent's budget figure counts up, then the replacement node fades in beside it with "replaces Flaky Lisan" | The single undeniable beat of the demo (PRD 1, 21.2 step 4). Temporal's retry label | `value-edge.tsx`, `node-card.tsx` | M | Yes |
| 3 | **Edge width by value and hover isolation.** Stroke width scales with drawn amount; hovering a node dims everything outside its ancestor path and subtree | Datadog flow map; makes "money flows down" legible at a glance | `tree-canvas.tsx`, `value-edge.tsx` | S | Yes |
| 4 | **Receipt as invoice.** Header with tree id, buyer, dates; line items per node (agent, role, rail, price, state, tx); subtotal, fees, refunds, structural ADA returned; reconciliation as the total line; print stylesheet and "Save PDF" via `window.print()` | Request Finance and Stripe; PRD 21.2 step 8 "the receipt fills the screen" | `receipt-view.tsx`, `globals.css` `@media print` | M | Yes |
| 5 | **Verify panel on the receipt and drawer.** For each claim a "Verify" action: recompute result hash from a pasted or fetched artifact in the browser (SubtleCrypto, Blake2b via existing shared lib), show plan Merkle root vs datum, open the exact UTxO on Cardanoscan `?tab=contracts`. Shows a green "Matches chain" or red "Mismatch" | PRD 3.2 "they showed real transactions, never mocks" and "trust layer on top of payment". Judges score Functionality 30% | `receipt/`, `node-drawer.tsx` | M | Yes, if hashing reuses `@cascade/shared` |
| 6 | **Agent profile pages** `/agents/[assetId]`: identity (Masumi asset, rails, categories), reputation score with the signals behind it, settled-node record (each row links to tree and tx), acceptance rate, refunds caused, earnings over time sparkline | PRD 3.3 outcome-grounded reputation, PRD 14.4; Virtuals Engagements, Agentverse interaction counts. Endpoints exist | new `app/agents/[assetId]/page.tsx`; link from node cards and drawer | M | Yes |
| 7 | **Agent economy home** `/economy` (or a landing section): trees settled, nodes, value moved, refunds recovered and re-spent, metered calls vs L1 txs, agents listed, top agents by settled value, latest events stream from `/v1/ws` | x402scan and Virtuals aGDP; PRD 21.3 slide 9 "traction proof". Extends existing `live-stats.tsx` | `app/page.tsx` or new route | M | Yes |
| 8 | **Per-tree and per-receipt OG images** via `opengraph-image.tsx`: tree silhouette from the layout, state colours, "150 tUSDM, 9 agents, 1 refund recovered, reconciled" | Vercel OG; every link a judge or tweet shares becomes a preview. Also add `generateMetadata` titles with goal and tree short id | `app/tree/[treeId]/opengraph-image.tsx`, `app/receipt/[treeId]/opengraph-image.tsx` | S to M | Yes (`next/og` ships with Next) |
| 9 | **Waterfall tab** beside the tree: one row per node indented by depth, bar from funding to terminal event, colour by end state, deadline marker as a tick, hover tooltip with exact times | LangSmith, Temporal timeline, Vercel traces; shows nested deadlines (PRD 3.3) composing visually | `explorer/` new `waterfall.tsx` driven by events | M | Yes |
| 10 | **Cardanoscan deep links to the right tab** and a per-tx chip showing redeemer name (Draw, Refund, SettleChild, CloseRoot) | Cardanoscan contracts tab shows redeemer, datum, mem and steps; makes "every badge is a transaction" concrete | `lib/explorer.ts`, `tx-link.tsx` | S | Yes |
| 11 | **Command palette (Cmd+K)** with cmdk: jump to tree, agent, node id, paste a tx hash or tree id, actions "Replay", "Open receipt", "Copy share link", "Toggle theme" | Linear, Vercel, Raycast; signals product polish to judges in seconds | `site-header.tsx`, new `command-palette.tsx` | S to M | Yes (one dep: `cmdk`) |
| 12 | **Timeline scrubber upgrade.** Event ticks on the track coloured by event type, keyboard J/K/space, labelled markers for "Refund" and "CloseRoot", time axis in real minutes | Temporal zoom and markers; PRD 14.3 scrubber | `timeline.tsx` | S | Yes |
| 13 | **Policy card per tree.** Caps for amount, depth, fan-out, deadline nesting and reputation floor, each with "enforced by validator" or "enforced by signer gate" | Nevermined and Payman mandates; PRD 13; answers "what stops an agent stealing" without the deck | explorer header, receipt | S | Yes |
| 14 | **Rail-specific drawer sections.** Masumi leaf: `blockchainIdentifier`, `vested_pay` UTxO, refunds-to-buyer note. Metered leaf: request, 402 price, voucher, redeem as a four-step strip with counts | Crossmint x402 walkthrough; PRD 1 "x402 and Masumi load-bearing" for the partner track | `node-drawer.tsx` (sections exist; restyle) | S | Yes |
| 15 | **Freshness and provenance line** on every data view: "Indexed at slot 812,345, 4 s ago, from Cascade indexer" with a pulse when new data arrives | Agentverse "last synced from chain"; ops lag already in `/v1/ops/status` | `site-header.tsx` or page headers | S | Yes |
| 16 | **Agent leaderboard** on `/agents`: sortable by settled value, nodes accepted, acceptance rate, median time to submit | Virtuals Top Agents, Agentverse sort by interactions | new `app/agents/page.tsx` | S after #6 | Yes |
| 17 | **Mini input to output diagram per transaction** in the drawer: spent node UTxO on the left, created children and payouts on the right, amounts on arrows | eUTxO.org, Cexplorer explainers; shows eUTxO parallelism (PRD 21.3 slide 6) | `node-drawer.tsx` | M | Yes, if `/nodes/:id` returns tx outputs; else small API addition |
| 18 | **Share sheet.** Copy link, copy receipt as Markdown, download receipt JSON, QR code for the tree on the stage slide | Stripe and Request Finance sharing; PRD 21.4 public explorer link | explorer and receipt headers | S | Yes |
| 19 | **Empty, loading and error states with intent.** Skeleton tree that matches the final layout, empty history with "Run the demo tree" CTA, indexer-down state with a link to `/ops` and the last cached snapshot | PRD 14.7; global standards | `states.tsx`, `explorer-skeleton.tsx` | S | Yes |
| 20 | **Plan diff view.** In plan review and on the receipt, planned vs actual per node (price, agent, deadline), with replacements marked | Shows the orchestrator keeps to the signed plan (PRD 5.2 step 4) | `plan-review.tsx`, receipt | M | Yes |
| 21 | **Mobile read-only polish** at 390 px: tree collapses to an indented list with state dots, drawer becomes a bottom sheet | PRD 14.7 phone rule; judges open links on phones | `tree-list.tsx`, `sheet.tsx` | S | Yes |
| 22 | **Signer gate log** per hire: 8 gates as a row of pass marks with names on hover | CRE Risk Router "8 gates" pattern from PRD 3.1; security story without slides | `node-drawer.tsx` | S if gate log is indexed; else M | Only if indexed today |

Do first for tomorrow: 1, 2, 3, 4, 8, 10, 6, 7, 11, 12. They touch the recording, the receipt shot, and every shared link.

Skip until after submission: 17 if it needs new indexer fields, 22 unless gate results are already stored.

## 4. Visual direction

Keep the current system ("colour carries meaning; the chrome is ink on slate", `globals.css`) and tighten it. References: [Linear](https://linear.app), [Raycast](https://www.raycast.com), [Vercel Geist](https://vercel.com/geist/introduction), [Stripe Docs](https://docs.stripe.com), [Temporal timeline](https://temporal.io/blog/lets-visualize-a-workflow), [Superfluid](https://github.com/superfluid-finance/superfluid-dashboard).

**Palette (dark first).**

- Canvas `#08111c`, surface `#0e1927`, raised `#13212f`, hairline `#1c2a3a`, strong line `#2c3e53`.
- Ink `#e7eef6`, secondary `#a9b6c6`, tertiary `#8494a8`. Check tertiary on surface for AA at small sizes; use it only at 13 px and above.
- State hues stay the only saturated colour: funded `#8cb4ff`, working `#f7c261`, submitted `#c0a8ff`, accepted `#6fdc98`, refunded `#a7b2bf`, challenged `#ff9c94`.
- Money gets one extra treatment, not a new hue: value chips on edges use the state colour of the move (funded down, refunded up) at full opacity with a 1 px inner highlight.
- Add a very low contrast grid (`--grid`, already defined) and a single radial glow behind the root node in stage mode, `rgb(140 180 255 / 0.08)`.

**Type.** Schibsted Grotesk Variable for UI and display, JetBrains Mono Variable for hashes, ids and amounts. Use `font-variant-numeric: tabular-nums slashed-zero` on all amounts. Scale: 12, 13, 15, 17, 20, 28, 40, 64. Display tracking -0.035em, body 0. Weight contrast: 600 for headings and figures, 400 body, 500 labels. Hashes truncated middle (`458310f2…9856`) with copy on click.

**Motion principles.**

1. Motion means money moved. Only value transfers and state changes animate; layout and chrome do not.
2. Direction encodes meaning: downward for Draw, upward for Refund and SettleChild, 700 to 900 ms, `cubic-bezier(0.22, 1, 0.36, 1)`.
3. State change: 180 ms colour crossfade plus a single 1.04 scale pulse. Never loop.
4. Counters tick over 600 ms with ease-out and settle on the exact figure.
5. Drawer and palette: 160 ms in, 120 ms out, opacity plus 8 px translate.
6. `prefers-reduced-motion`: replace travel with an instant state swap and a static arrow glyph (already partly handled).

## 5. Sources

Every claim about a competitor links to its source inline in sections 2 to 4. Additional background: [x402scan overview](https://medium.com/@achivx/x402scan-a-blockchain-explorer-built-not-for-people-but-for-ai-agents-e0f502c4d4ec), [Nevermined](https://nevermined.ai/product/), [Payman](https://paymanai.com/), [cmdk Linear example](https://dip-cmdk.mintlify.app/examples/linear).
