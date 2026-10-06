import type { AcceptanceRun } from "../../lib/acceptance.js";
import { conductorStatus, startConductor, stopConductor } from "../../lib/conductor-instance.js";
import { serviceUrls } from "../../lib/console-flow.js";
import { checkClosedAndReconciled, DEMO_GOAL, runConsoleTree } from "../../lib/console-scenario.js";
import { ADA } from "../../lib/tree-fixture.js";

const MINUTE = 60_000;
const PORT = 24115;

/**
 * A15: a test-only Conductor exits (code 86) right after the hire ledger records a signed Draw and
 * before it is sent. On restart it must resend that same Draw: no duplicate, no lost node.
 */
export async function a15(run: AcceptanceRun): Promise<void> {
  const name = `a15_${Date.now() % 1_000_000}`;
  const conductor = await startConductor(name, PORT, "payment-recorded");
  const urls = { conductor, indexer: serviceUrls().indexer };
  let crashed = false;
  try {
    const t = await runConsoleTree(
      run,
      { goal: DEMO_GOAL, budgetLovelace: 80n * ADA, maxDepth: 3 },
      {
        urls,
        whileRunning: async () => {
          const deadline = Date.now() + 60 * MINUTE;
          for (;;) {
            const status = await conductorStatus(name);
            if (status === "exited:86") break;
            if (status.startsWith("exited:")) throw new Error(`test Conductor exited with ${status}, not at the crash point`);
            if (Date.now() > deadline) throw new Error("test Conductor never reached the crash point");
            await new Promise((r) => setTimeout(r, 30_000));
          }
          crashed = true;
          run.note(`crashed at payment-recorded at ${new Date().toISOString()}; restarting without the hook`);
          await startConductor(name, PORT);
        },
      },
    );
    run.check("the orchestrator crashed between signing and submitting", true, crashed);

    // No duplicate Draw: one drawn node per (parent, plan leaf), except a re-hire after a refund.
    const refunded = new Set(t.events.filter((e) => e.type === "node.refunded").map((e) => e.node_id));
    const byLeaf = new Map<string, string[]>();
    for (const [id, d] of t.datums) {
      if (d.parent_id === null) continue;
      const key = `${d.parent_id}/${d.spec_hash}`;
      byLeaf.set(key, [...(byLeaf.get(key) ?? []), id]);
    }
    const duplicates = [...byLeaf.entries()].filter(([, ids]) => ids.filter((id) => !refunded.has(id)).length > 1).map(([k]) => k);
    run.check("no duplicate Draw for any plan leaf", [], duplicates);

    // No lost node: every drawn node reached a terminal state.
    const terminal = new Set(t.events.filter((e) => ["node.settled", "node.refunded", "receipt.closed"].includes(e.type)).map((e) => e.node_id));
    run.check("no lost node", [], [...t.datums.keys()].filter((id) => id !== t.treeId && !terminal.has(id)));
    await checkClosedAndReconciled(run, t);
  } finally {
    await stopConductor(name).catch(() => undefined);
  }
}
