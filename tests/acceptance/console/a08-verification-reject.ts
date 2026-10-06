import type { AcceptanceRun } from "../../lib/acceptance.js";
import { paidTo } from "../../lib/chain.js";
import { checkClosedAndReconciled, DEMO_GOAL, runConsoleTree, txOf } from "../../lib/console-scenario.js";
import { httpFetch } from "../../lib/http.js";
import { notImplemented } from "../../lib/not-implemented.js";
import { preprodRole } from "../../lib/preprod.js";
import { logicActions } from "../../lib/reputation-from-chain.js";
import { payeeAddress, preprodHashes } from "../../lib/tree-chain.js";
import { ADA } from "../../lib/tree-fixture.js";

const ZERO_HASH = "0".repeat(64);

/** The indexer's L0 verdict for a node, read from the node detail (PRD 13: L0 schema checks). */
async function l0Rejection(indexer: string, treeId: string, nodeId: string): Promise<{ key: string; reason: string } | null> {
  const res = await httpFetch("A8: read the challenged node's detail", `${indexer}/v1/trees/${treeId}/nodes/${nodeId}`, {}, { idempotent: true });
  if (!res.ok) throw new Error(`node detail: HTTP ${res.status}`);
  const detail = (await res.json()) as Record<string, unknown>;
  const key = Object.keys(detail).find((k) => /^l0/i.test(k));
  if (key === undefined) return null;
  const value = detail[key];
  const reason = typeof value === "string" ? value : typeof value === "object" && value !== null ? (value as Record<string, unknown>)["reason"] : undefined;
  return { key, reason: typeof reason === "string" ? reason : "" };
}

/** A8: console-driven on preprod (runs concurrently with the others; see console-driven.test.ts). */
export async function a08(run: AcceptanceRun): Promise<void> {
  const t = await runConsoleTree(run, { goal: DEMO_GOAL, budgetLovelace: 30n * ADA, maxDepth: 1, testScenario: "a8-schema-fail" });
  run.check("plan is labelled as the A8 test scenario", true, JSON.stringify(t.plan).includes("TEST SCENARIO A8"));

  const challenged = t.events.find((e) => e.type === "node.challenged");
  if (challenged === undefined) throw new Error("no node was challenged");
  const nodeId = challenged.node_id;
  const d = t.datums.get(nodeId);
  if (d === undefined) throw new Error("challenged node's datum is missing on chain");
  if (d.parent_id === null) throw new Error("the challenged node is the root; A8 expects a hired child");
  const parent = t.datums.get(d.parent_id);
  if (parent === undefined) throw new Error("challenged node's parent datum is missing on chain");
  run.check("challenged node submitted a result first", true, t.events.some((e) => e.type === "node.submitted" && e.node_id === nodeId));
  run.check("challenged node was never accepted", false, t.events.some((e) => e.type === "node.accepted" && e.node_id === nodeId));

  // The Challenge itself, decoded from the challenge tx's logic redeemer on chain.
  const challengeTx = txOf(t, "node.challenged", nodeId);
  if (challengeTx === undefined) throw new Error("challenge tx is missing on chain");
  const { actions, inputs } = await logicActions(challengeTx);
  const nodeIn = BigInt(inputs.findIndex((i) => i.assets.some((a) => a.unit === preprodHashes().node + nodeId)));
  const challenge = actions.find((a) => a.type === "Challenge" && a.node_in === nodeIn);
  if (challenge === undefined || challenge.type !== "Challenge") throw new Error("challenge tx carries no Challenge action for the node");
  run.check("on-chain Challenge carries a non-zero reason_hash", true, /^[0-9a-f]{64}$/.test(challenge.reason_hash) && challenge.reason_hash !== ZERO_HASH);
  run.check("challenger is the parent's operator key", parent.operator, challenge.challenger);
  run.check("parent operator is the Conductor's key", preprodRole("conductor").vkh, parent.operator);
  run.check("indexer's node.challenged matches the chain", { reason_hash: challenge.reason_hash, challenger: challenge.challenger }, {
    reason_hash: (challenged.payload as Record<string, unknown> | null)?.["reason_hash"],
    challenger: (challenged.payload as Record<string, unknown> | null)?.["challenger"],
  });

  // Why: the L0 rejection reason the indexer exposes for the node.
  const l0 = await l0Rejection(t.urls.indexer, t.treeId, nodeId);
  if (l0 === null) notImplemented("indexer L0 rejection reason on GET /v1/trees/:tree_id/nodes/:node_id (W3)");
  run.note(`indexer ${l0.key}: ${l0.reason}`);
  run.check("indexer exposes a non-empty L0 rejection reason", true, l0.reason.trim().length > 0);

  const resolve = txOf(t, "node.resolved", nodeId);
  if (resolve === undefined) throw new Error("challenge was never resolved on chain");
  run.check("Resolve landed after dispute_until (deadline exit)", true, BigInt(resolve.blockTime) * 1000n > d.dispute_until);
  run.check("worker paid nothing: the challenge resolved in the parent's favour", 0n, paidTo(resolve, payeeAddress(d)));
  await checkClosedAndReconciled(run, t);
}
