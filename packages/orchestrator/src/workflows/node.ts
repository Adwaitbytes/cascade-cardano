/**
 * One workflow per node (PRD 10.4): hires the node's children as child workflows in dependency
 * order, swaps in contingency specs when a slot cannot be filled, composes the parsed child results
 * and submits the node's result hash.
 */
import { ChildWorkflowFailure, executeChild, isCancellation, proxyActivities, workflowInfo } from "@temporalio/workflow";
import type { JsonValue } from "@cascade/shared/browser";
import type { CascadeActivities } from "../activities.js";
import { CHAIN_ACTIVITY_OPTIONS, CHAIN_ACTIVITY_RETRY } from "./activity-options.js";
import { hireWorkflow } from "./hire.js";
import type { HireOutcome, NodeOutcome, NodeWorkflowInput } from "./types.js";

const acts = proxyActivities<CascadeActivities>({
  ...CHAIN_ACTIVITY_OPTIONS,
  retry: { ...CHAIN_ACTIVITY_RETRY, nonRetryableErrorTypes: ["ChainUnavailable"] },
});

/** "Child Workflow execution failed: Activity task failed: <reason>", for the slot's action log. */
function failureChain(e: Error): string {
  const parts: string[] = [];
  for (let cur: unknown = e; cur instanceof Error && parts.length < 4; cur = cur.cause) parts.push(cur.message);
  return parts.join(": ").slice(0, 500);
}

export async function nodeWorkflow(input: NodeWorkflowInput): Promise<NodeOutcome> {
  const byId = new Map(input.children.map((c) => [c.spec.id, c]));
  const verifierOf = new Map<string, string>();
  for (const [target, ids] of Object.entries(input.verifiers)) for (const id of ids) verifierOf.set(id, target);
  const contingencyFor = new Map(Object.entries(input.contingencies).map(([contingency, original]) => [original, contingency]));
  const scheduled = input.children.filter((c) => !verifierOf.has(c.spec.id) && input.contingencies[c.spec.id] === undefined).map((c) => c.spec.id);
  const deps = (id: string): string[] => [...new Set((input.after[id] ?? []).map((d) => verifierOf.get(d) ?? d))].filter((d) => d !== id);

  const inheritedDeps = input.input["depends_on"];
  const inherited: Record<string, JsonValue> = typeof inheritedDeps === "object" && inheritedDeps !== null && !Array.isArray(inheritedDeps) ? inheritedDeps : {};
  const reserveEach = scheduled.length === 0 ? 0n : BigInt(input.reserve) / BigInt(scheduled.length);
  const outcomes = new Map<string, HireOutcome>();
  const results = new Map<string, JsonValue>();

  const runHire = async (specId: string): Promise<HireOutcome> => {
    const child = byId.get(specId);
    if (child === undefined) throw new Error(`unknown child spec ${specId}`);
    const depResults: Record<string, JsonValue> = {};
    for (const d of deps(specId)) {
      const r = results.get(d);
      if (r !== undefined) depResults[d] = r;
    }
    const verifiers = (input.verifiers[specId] ?? []).flatMap((id) => {
      const v = byId.get(id);
      return v === undefined ? [] : [v];
    });
    return executeChild(hireWorkflow, {
      workflowId: `${workflowInfo().workflowId}/hire-${specId}`,
      args: [
        {
          tree_id: input.tree_id,
          parent_node_id: input.node_id,
          spec: child.spec,
          candidates: child.candidates,
          // A sub-hired subtree inherits its agent's upstream results; siblings' results come on top.
          input: { ...input.input, depends_on: { ...inherited, ...depResults } },
          reserve: reserveEach.toString(),
          remaining_budget: "0",
          can_replan: false,
          poll_ms: input.poll_ms,
          verifiers,
        },
      ],
    }).catch((e: unknown): HireOutcome => {
      // A slot whose hire failed (activity retries exhausted, a deadline passed) is a missing part,
      // not a failed node: the contingency runs if there is one, and the node still composes and
      // submits (partial). Rethrowing failed preprod trees fcca2101 and 42811ec9 whole, so their
      // roots never submitted and the buyer waited for refund_after.
      if (!(e instanceof ChildWorkflowFailure) || isCancellation(e)) throw e;
      return { status: "partial", spec_id: specId, unused_budget: "0", actions: [`hire failed: ${failureChain(e)}`] };
    });
  };

  const pending = new Set(scheduled);
  while (pending.size > 0) {
    const ready = [...pending].filter((id) => deps(id).every((d) => outcomes.has(d) || !scheduled.includes(d)));
    if (ready.length === 0) throw new Error(`dependency cycle among ${[...pending].join(", ")}`);
    const wave = await Promise.all(
      ready.map(async (id) => {
        let outcome = await runHire(id);
        const contingency = contingencyFor.get(id);
        if (outcome.status !== "accepted" && contingency !== undefined) outcome = await runHire(contingency);
        return [id, outcome] as const;
      }),
    );
    for (const [id, outcome] of wave) {
      pending.delete(id);
      outcomes.set(id, outcome);
      if (outcome.status === "accepted") results.set(id, outcome.result);
    }
  }

  const parts = scheduled.flatMap((id) => {
    const o = outcomes.get(id);
    return o?.status === "accepted" ? [{ spec_id: o.spec_id, result: o.result, result_hash: o.result_hash }] : [];
  });
  const partial = parts.length < scheduled.length;
  const composed = await acts.compose({ spec: input.spec, parts, partial });
  if (input.submit !== false) await acts.submit({ tree_id: input.tree_id, node_id: input.node_id, result_hash: composed.result_hash });
  return { node_id: input.node_id, result: composed.result, result_hash: composed.result_hash, partial, children: [...outcomes.values()] };
}
