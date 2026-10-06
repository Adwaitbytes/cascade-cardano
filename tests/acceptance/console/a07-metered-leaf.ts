import { getAddressDetails } from "@lucid-evolution/lucid";
import { channelTokenName, decodeChannelDatum } from "@cascade/shared";
import type { AcceptanceRun } from "../../lib/acceptance.js";
import { spentBy, type ChainTx } from "../../lib/chain.js";
import { checkClosedAndReconciled, DEMO_GOAL, runConsoleTree } from "../../lib/console-scenario.js";
import { escrowFlows, escrowMatcher, preprodHashes } from "../../lib/tree-chain.js";
import { ADA } from "../../lib/tree-fixture.js";

/** The approved per-call price of the metered spec: the plan's primary agent price for the metered node. */
function perCallPrice(plan: unknown): bigint | null {
  let price: bigint | null = null;
  const walk = (n: unknown): void => {
    const node = n as { rail?: unknown; spec?: { rail?: unknown }; agents?: { primary?: { price?: unknown } }; children?: unknown };
    const rail = node.rail ?? node.spec?.rail;
    if (rail === "metered" && typeof node.agents?.primary?.price === "string") price = BigInt(node.agents.primary.price);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk((plan as { root?: unknown }).root);
  return price;
}

/** A7: console-driven on preprod (runs concurrently with the others; see console-driven.test.ts). */
export async function a07(run: AcceptanceRun): Promise<void> {
  // Labelled scenario: Pricer under the root opens a metered leaf and makes 210 calls to the Lookup API.
  const t = await runConsoleTree(run, { goal: DEMO_GOAL, budgetLovelace: 25n * ADA, maxDepth: 2, testScenario: "a7-metered" });
  const h = preprodHashes();
  const receipt = [...t.datums.entries()].find(([, d]) => d.kind === "MeteredReceipt");
  if (receipt === undefined) throw new Error("the plan drew no Metered receipt (needs a metered Pricer leaf, or an A7 console test_scenario)");
  const [receiptId] = receipt;
  const channelUnit = h.node + channelTokenName(receiptId);

  // Follow the channel UTxO on chain from the Draw that opened it to the tx that closed it.
  const open = [...t.txs.values()].find((tx) => tx.outputs.some((o) => o.assets.some((a) => a.unit === channelUnit)));
  if (open === undefined) throw new Error("no tree tx opened the channel");
  const chain: ChainTx[] = [open];
  let redeemed = 0n;
  let deposit = 0n;
  for (;;) {
    const cur = chain.at(-1)!;
    const out = cur.outputs.find((o) => o.assets.some((a) => a.unit === channelUnit));
    if (out === undefined) break;
    const datum = decodeChannelDatum(out.inlineDatum ?? "");
    redeemed = datum.redeemed;
    deposit = datum.deposit;
    const next = await spentBy(cur.hash, out.index);
    if (next === null) throw new Error(`channel output ${cur.hash}#${out.index} is still unspent: the channel never closed`);
    chain.push(await run.confirmTx(`channel tx ${chain.length + 1}`, next));
  }
  run.note(`channel L1 txs: ${chain.map((x) => x.hash).join(", ")}`);
  run.check("at most 3 L1 transactions for the channel (open, redeem, close)", true, chain.length <= 3);

  const price = perCallPrice(t.plan);
  if (price === null || price <= 0n) throw new Error("the plan carries no per-call price for the metered spec");
  const calls = redeemed / price;
  run.note(`redeemed ${redeemed} lovelace at ${price} per call = ${calls} calls; deposit ${deposit}`);
  run.check("at least 200 tool calls paid through vouchers", true, calls >= 200n);

  // The close returns the unredeemed deposit into the parent: nothing leaves escrow in that tx.
  const close = chain.at(-1)!;
  run.check("close burns the channel token", false, close.outputs.some((o) => o.assets.some((a) => a.unit === channelUnit)));
  run.check("unspent deposit stays in the tree on close (no escrow outflow)", 0n, escrowFlows([close], escrowMatcher(h)).released);
  const intoParent = close.outputs.filter((o) => getAddressDetails(o.address).paymentCredential?.hash === h.node).reduce((s, o) => s + o.lovelace, 0n);
  run.check("parent output holds at least the unspent deposit", true, intoParent >= deposit - redeemed);
  await checkClosedAndReconciled(run, t);
}
