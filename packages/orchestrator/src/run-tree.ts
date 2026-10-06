/**
 * Starting a funded tree: the root's `nodeWorkflow` (PRD 10.4), and a watcher that notices when a
 * drafted plan's FundRoot lands so the buyer never has to tell the orchestrator.
 */
import type { Client } from "@temporalio/client";
import type { JsonValue } from "@cascade/shared/browser";
import type { BuiltPlan } from "./build-plan.js";
import { markPlanFunded, type PlanStore } from "./api/index.js";
import type { IndexerClient } from "./chain/indexer.js";
import { scenarioInput, type TestScenario } from "./test-scenarios.js";
import { DEFAULT_TASK_QUEUE } from "./worker.js";
import type { NodeWorkflowInput } from "./workflows/types.js";

export function rootWorkflowInput(built: BuiltPlan, treeId: string, input: Record<string, JsonValue>, pollMs = 10_000): NodeWorkflowInput {
  const { plan } = built;
  return {
    tree_id: treeId,
    node_id: treeId,
    spec: plan.root.spec,
    children: plan.root.children.map((c) => ({ spec: c.spec, candidates: [c.agents.primary, ...c.agents.fallbacks] })),
    contingencies: built.contingencies,
    after: built.after,
    verifiers: built.verifiers,
    input,
    reserve: plan.totals.reserve,
    poll_ms: pollMs,
  };
}

/**
 * Starts (or finds, by workflow id) the root workflow of a tree. Idempotent per tree. `plansApi` is
 * the Conductor's public base URL: sub-hiring agents fetch the plan there (and check its root on chain).
 */
export async function startTree(client: Client, built: BuiltPlan, treeId: string, goal: string, plansApi: string, testScenario?: TestScenario, taskQueue = DEFAULT_TASK_QUEUE): Promise<string> {
  const workflowId = `tree-${treeId}`;
  const input: Record<string, JsonValue> = { goal, plan_id: built.plan.plan_id, plans_api: plansApi };
  if (testScenario !== undefined) Object.assign(input, { test_scenario: testScenario, ...scenarioInput(testScenario) });
  try {
    await client.workflow.start("nodeWorkflow", { taskQueue, workflowId, args: [rootWorkflowInput(built, treeId, input)] });
  } catch (e) {
    if ((e as Error).name !== "WorkflowExecutionAlreadyStartedError") throw e;
  }
  return workflowId;
}

/**
 * Polls drafted plans that have a tree id (the console asked for a fund tx) and starts the tree
 * once the indexer shows its FundRoot. Returns a stop function.
 */
export function watchFunding(o: { store: PlanStore; indexer: IndexerClient; client: Client; plansApi: string; taskQueue?: string; intervalMs?: number; onError?: (e: unknown) => void }): () => void {
  let stopped = false;
  const tick = async () => {
    // One plan's failing read must not hold back the others' trees until the next tick.
    for (const id of await o.store.awaitingFunding()) {
      try {
        const p = await o.store.get(id);
        if (p === null || p.funded || p.tree_id === null) continue;
        if (!(await o.indexer.hasTree(p.tree_id))) continue;
        await markPlanFunded(o.store, id, p.tree_id);
        await startTree(o.client, p.built, p.tree_id, p.request.goal, o.plansApi, p.request.test_scenario, o.taskQueue);
      } catch (e) {
        o.onError?.(new Error(`plan ${id}: ${e instanceof Error ? e.message : String(e)}`, { cause: e }));
      }
    }
  };
  const loop = async () => {
    while (!stopped) {
      try {
        await tick();
      } catch (e) {
        o.onError?.(e);
      }
      await new Promise((r) => setTimeout(r, o.intervalMs ?? 5_000));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
