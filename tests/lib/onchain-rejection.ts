/**
 * Negative acceptance tests (A10 to A13, ADR section 10, DECISIONS.md): the offending transaction is
 * built with Lucid from a real honest SDK transaction, submitted to a preprod node, and must be
 * refused for a script failure. A positive control, the honest transaction, is then submitted and
 * confirmed through Blockfrost.
 */
import type { BuiltTx } from "@cascade/sdk";
import { runCase, type CaseSpec } from "../adversarial/lib/runner.js";
import { buildRaw, liftBuilt, type RawPlan } from "../adversarial/lib/raw-tx.js";
import type { AcceptanceRun } from "./acceptance.js";
import { getTx, type ChainTx } from "./chain.js";
import type { TreeLab } from "./tree-fixture.js";

/** Builds the offending tx from `honest`, submits it to the preprod node and records the refusal. */
export async function proveNodeRejects(run: AcceptanceRun, lab: TreeLab, spec: CaseSpec, honest: BuiltTx | RawPlan, mutate: (p: RawPlan) => Promise<void> | void): Promise<void> {
  const result = await runCase(spec, lab.caseContext(), async () => honest, mutate, { record: false });
  run.note(`${spec.id}: ${spec.mutation}. Offending tx body ${result.tx_body_hash ?? "(not built)"}. ${result.detail}`);
  run.check(`${spec.id}: preprod node refuses the offending tx for a script failure`, "rejected_by_script", result.outcome);
  if (result.tx_body_hash !== null) {
    run.check(`${spec.id}: offending tx is not on chain`, null, (await getTx(result.tx_body_hash))?.hash ?? null);
  }
}

/**
 * Signs, submits and confirms an SDK transaction, and checks it on chain through Blockfrost.
 * `moved` lists nodes the tx re-creates; the call returns only once the provider's asset index
 * shows each at this tx, so the next builder never reads a spent node UTxO.
 */
export async function submitAndConfirm(
  run: AcceptanceRun,
  lab: TreeLab,
  label: string,
  built: BuiltTx,
  opts: { viaCranker?: boolean; moved?: string[] } = {},
): Promise<ChainTx> {
  const hash = opts.viaCranker === true ? await lab.submitByCranker(built) : await lab.submit(built);
  const tx = await run.confirmTx(label, hash);
  for (const id of opts.moved ?? []) await lab.awaitNodeAt(id, hash);
  return tx;
}

/**
 * Lifts an honest tx and checks it still builds, now, while its inputs are unspent. Use it when a
 * later step (a Freeze) spends those inputs before the offending tx is built from the plan.
 */
export async function liftWhileUnspent(lab: TreeLab, honest: BuiltTx): Promise<RawPlan> {
  const plan = await liftBuilt(lab.client, honest);
  await buildRaw(lab.client, plan);
  return plan;
}
