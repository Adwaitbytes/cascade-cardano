import type { AcceptanceRun } from "../../lib/acceptance.js";
import { getAddressDetails } from "@lucid-evolution/lucid";
import { paidTo, requiredSigners } from "../../lib/chain.js";
import { arbiterResolve, chainTx, treeView } from "../../lib/console-flow.js";
import { preprodLucid, preprodRole } from "../../lib/preprod.js";
import { payeeAddress, preprodHashes } from "../../lib/tree-chain.js";
import { checkClosedAndReconciled, DEMO_GOAL, runConsoleTree, txOf } from "../../lib/console-scenario.js";
import { ADA } from "../../lib/tree-fixture.js";

const MINUTE = 60_000;

/** A9: console-driven on preprod (runs concurrently with the others; see console-driven.test.ts). */
export async function a09(run: AcceptanceRun): Promise<void> {
  // Run 1: the demo tree's checked node carries VerifierQuorum(3 checker keys, k = 2).
  const t = await runConsoleTree(run, { goal: DEMO_GOAL, budgetLovelace: 40n * ADA, maxDepth: 3, acceptance: "auto_after_checks", testScenario: "a9-quorum" });
  run.check("run 1 plan is labelled as the A9 quorum test scenario", true, JSON.stringify(t.plan).includes("TEST SCENARIO"));
  const quorum = [...t.datums.entries()].find(([, d]) => d.acceptance.type === "VerifierQuorum");
  if (quorum === undefined) throw new Error("no node with VerifierQuorum acceptance on chain");
  const [nodeId, d] = quorum;
  if (d.acceptance.type !== "VerifierQuorum") throw new Error("unreachable");
  run.check("quorum is 2 of 3 verifier keys", { k: 2n, keys: 3 }, { k: d.acceptance.k, keys: d.acceptance.keys.length });
  const accept = txOf(t, "node.accepted", nodeId);
  if (accept === undefined) throw new Error("checked node has no Accept on chain");
  const signers = await requiredSigners(accept.hash);
  const verifierSigs = d.acceptance.keys.filter((k) => signers.includes(k));
  run.check("Accept carries exactly two verifier signatures (two accepted, one rejected)", 2, verifierSigs.length);
  await checkClosedAndReconciled(run, t);

  // Run 2: the worker escalates a challenge; two arbiters sign a split through the console API.
  const arbiter1 = preprodRole("arbiter-1");
  const arbiter2 = preprodRole("arbiter-2");
  let resolved: { nodeId: string; worker: bigint; resolveHash: string } | null = null;
  const t2 = await runConsoleTree(
    run,
    { goal: DEMO_GOAL, budgetLovelace: 30n * ADA, maxDepth: 1, testScenario: "a9-escalation" },
    {
      whileRunning: async (urls, treeId) => {
        const deadline = Date.now() + 90 * MINUTE;
        for (;;) {
          const disputed = (await treeView(urls, treeId)).nodes.find((n) => n.state === "Disputed");
          if (disputed !== undefined) {
            const budget = BigInt(disputed.budget);
            const worker = BigInt(disputed.fee) / 2n;
            const tx = await arbiterResolve(run, urls, await preprodLucid(arbiter1), [arbiter2.privateKey], treeId, disputed.node_id, { worker, parent: budget - worker });
            resolved = { nodeId: disputed.node_id, worker, resolveHash: tx.hash };
            return;
          }
          if (Date.now() > deadline) throw new Error("no node reached Disputed (the worker never escalated)");
          await new Promise((r) => setTimeout(r, 30_000));
        }
      },
    },
  );
  run.check("plan is labelled as the A9 test scenario", true, JSON.stringify(t2.plan).includes("TEST SCENARIO A9"));
  const r = resolved as { nodeId: string; worker: bigint; resolveHash: string } | null;
  if (r === null) throw new Error("arbiters did not resolve");
  const disputedDatum = t2.datums.get(r.nodeId);
  if (disputedDatum === undefined) throw new Error("disputed node's datum is missing on chain");
  const resolveTx = t2.txs.get(r.resolveHash) ?? (await chainTx(r.resolveHash));
  const sigs = await requiredSigners(r.resolveHash);
  run.check("Resolve signed by both arbiters (threshold 2)", true, sigs.includes(arbiter1.vkh) && sigs.includes(arbiter2.vkh));
  run.check("worker paid at least the arbiters' worker share", true, paidTo(resolveTx, payeeAddress(disputedDatum)) >= r.worker);
  const bondHash = preprodHashes().bond;
  const bondsSpent = resolveTx.inputs.filter((i) => getAddressDetails(i.address).paymentCredential?.hash === bondHash);
  run.check("bonds move in the Resolve (challenger bond spent)", true, bondsSpent.length > 0);
  await checkClosedAndReconciled(run, t2);
}
