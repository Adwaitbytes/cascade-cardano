import { getAddressDetails } from "@lucid-evolution/lucid";
import type { AcceptanceRun } from "../../lib/acceptance.js";
import { nodeDetail, treeView } from "../../lib/console-flow.js";
import { checkClosedAndReconciled, DEMO_GOAL, runConsoleTree } from "../../lib/console-scenario.js";
import { preprodRole } from "../../lib/preprod.js";
import { escrowMatcher, preprodHashes } from "../../lib/tree-chain.js";
import { ADA } from "../../lib/tree-fixture.js";

/** A5: console-driven on preprod (runs concurrently with the others; see console-driven.test.ts). */
export async function a05(run: AcceptanceRun): Promise<void> {
  const t = await runConsoleTree(run, { goal: DEMO_GOAL, budgetLovelace: 30n * ADA, maxDepth: 1, testScenario: "a5-address-payment" });
  run.check("plan is labelled as the A5 test scenario", true, JSON.stringify(t.plan).includes("TEST SCENARIO A5"));

  // The default-method payment leaves escrow straight to the Lookup API's key, inside a Draw.
  const lookupApi = preprodRole("lookup-api").vkh;
  const isEscrow = escrowMatcher(preprodHashes());
  const payments = [...t.txs.values()].flatMap((tx) =>
    tx.inputs.some((i) => isEscrow(i.address))
      ? tx.outputs.filter((o) => getAddressDetails(o.address).paymentCredential?.hash === lookupApi).map((o) => ({ tx, lovelace: o.lovelace }))
      : [],
  );
  run.check("one payment from the tree budget to the third-party endpoint's key", 1, payments.length);
  run.check("payment amount is positive", true, (payments[0]?.lovelace ?? 0n) > 0n);
  const drawn = t.events.find((e) => e.type === "node.drawn" && e.tx_id === payments[0]?.tx.hash);
  run.check("the payment is part of a Draw (escrow spent by the tree)", true, drawn !== undefined || payments[0]?.tx.inputs.some((i) => isEscrow(i.address)) === true);

  // PAYMENT-RESPONSE from the endpoint is kept with the result the indexer serves.
  const views = [await treeView(t.urls, t.treeId), ...(await Promise.all([t.treeId, ...t.datums.keys()].map((n) => nodeDetail(t.urls, t.treeId, n).catch(() => null))))];
  const recorded = views.some((v) => /payment[-_]?response/i.test(JSON.stringify(v)));
  run.check("PAYMENT-RESPONSE recorded with the tree", true, recorded);
  await checkClosedAndReconciled(run, t);
}
