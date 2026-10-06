/**
 * Sub-hiring (PRD 10.4): a hired agent whose plan node has children runs them as its own
 * `nodeWorkflow`, on its own task queue so every Draw, Accept and Settle under its node is signed
 * with its own role. The agent's job runner submits the composed result, so the workflow does not.
 */
import type { Client } from "@temporalio/client";
import { specHash, type JsonValue, type Plan } from "@cascade/shared/browser";
import type { NodeOutcome, NodeWorkflowInput } from "./workflows/types.js";

type PlanNode = Plan["root"];

function findBySpecHash(node: PlanNode, hash: string): PlanNode | null {
  if (specHash(node.spec) === hash) return node;
  for (const c of node.children) {
    const found = findBySpecHash(c, hash);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The workflow input for the children of the plan node whose spec hash is `ownSpecHash`, or null
 * when that node has no children. Contingency, ordering and verifier wiring is not carried in the
 * plan itself, so a sub-hired node's children run independently and are parent-accepted.
 */
export function subtreeWorkflowInput(plan: Plan, ownSpecHash: string, at: { tree_id: string; node_id: string; input: Record<string, JsonValue>; poll_ms?: number }): NodeWorkflowInput | null {
  const own = findBySpecHash(plan.root, ownSpecHash);
  if (own === null) throw new Error(`no node of plan ${plan.plan_id} has spec hash ${ownSpecHash}`);
  if (own.children.length === 0) return null;
  const quorum = own.children.find((c) => c.spec.verifier.quorum !== null || c.spec.acceptance === "VerifierQuorum");
  if (quorum !== undefined) throw new Error(`sub-hired spec ${quorum.spec.id} needs a verifier quorum, which only the root workflow wires`);
  return {
    tree_id: at.tree_id,
    node_id: at.node_id,
    spec: own.spec,
    children: own.children.map((c) => ({ spec: c.spec, candidates: [c.agents.primary, ...c.agents.fallbacks] })),
    contingencies: {},
    after: {},
    verifiers: {},
    input: at.input,
    reserve: "0",
    poll_ms: at.poll_ms ?? 10_000,
    submit: false,
  };
}

/** Runs (or rejoins, by workflow id) the subtree workflow of one node and waits for its outcome. */
export async function runSubtree(client: Client, taskQueue: string, input: NodeWorkflowInput): Promise<NodeOutcome> {
  const workflowId = `subtree-${input.tree_id}-${input.node_id}`;
  try {
    await client.workflow.start("nodeWorkflow", { taskQueue, workflowId, args: [input] });
  } catch (e) {
    if ((e as Error).name !== "WorkflowExecutionAlreadyStartedError") throw e;
  }
  return (await client.workflow.getHandle(workflowId).result()) as NodeOutcome;
}
