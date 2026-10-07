/**
 * Sub-hiring for reference agents (PRD 10.4): when a tree-bound job's plan node has children, the
 * agent runs them through the orchestrator library on its own Temporal task queue, so each Draw,
 * Accept and Settle under its node is signed with the agent's own role by the signer service. The
 * agent's job runner then submits the composed result as usual.
 *
 * Env (on top of `chainContextFromEnv`): CASCADE_INDEXER_URL, CASCADE_TEMPORAL_ADDRESS (default
 * 127.0.0.1:27233), CASCADE_TEMPORAL_NAMESPACE (default cascade), CASCADE_ORCHESTRATOR_DATABASE_URL
 * (hire records survive a restart; in memory without it).
 */
import pg from "pg";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import { CascadeClient, type CascadeScripts, type ReferenceScripts } from "@cascade/sdk";
import { guardPool, type JobRecord, type JsonValue } from "@cascade/agent";
import {
  composeByMerge,
  createActivities,
  createWorker,
  IndexerClient,
  InMemoryHireLedger,
  migrateOrchestratorState,
  openLucid,
  PostgresHireLedger,
  runSubtree,
  drawSlackMs,
  planPolicyFor,
  SdkChainActions,
  subtreeWorkflowInput,
  temporalClient,
  type AgentDirectory,
  type HireLedger,
  type NodeOutcome,
  type TxSigner,
} from "@cascade/orchestrator";
import type { Plan } from "@cascade/shared";
import type { LlmClient } from "@cascade/orchestrator/llm";
import { chainContextFromEnv } from "./chain.js";
import { referenceDirectory } from "./directory.js";
import { cascadeNetworkFromEnv, env } from "./env.js";
import { fetchTreePlan } from "./metered.js";
import type { AgentRoleName } from "./roles.js";

/** What an agent's handler calls to sub-hire: `SubtreeRunner.run`. */
export type SubtreeHire = (node: JobRecord["node"], context: Record<string, JsonValue>, upstream?: Record<string, JsonValue>) => Promise<NodeOutcome | null>;

/** The parsed results of the children that were accepted, in plan order. */
export function acceptedChildResults(outcome: NodeOutcome): { spec_id: string; result: JsonValue }[] {
  return outcome.children.flatMap((c) => (c.status === "accepted" ? [{ spec_id: c.spec_id, result: c.result }] : []));
}

export interface SubtreeRunner {
  /**
   * Runs the children of the job's plan node and returns their outcome, or null when the job is not
   * bound to a tree node or its node has no children. `upstream` is passed to every child as
   * `depends_on` (e.g. Scout's own research for the writers it hires).
   */
  run: SubtreeHire;
  stop(): Promise<void>;
}

/** Context keys a sub-hired child inherits from its parent's job context. */
const INHERITED = ["goal", "plan_id", "plans_api", "test_scenario", "brands", "x402_query"] as const;

export interface SubtreeRunnerOptions {
  role: string;
  /** The agent's own address: operator of its node and of every Draw under it. */
  operatorAddress: string;
  lucid: LucidEvolution;
  scripts: CascadeScripts;
  refs: ReferenceScripts;
  signer: TxSigner;
  directory: AgentDirectory;
  waitIndexed?: (txId: string, treeId: string) => Promise<void>;
  ledger: HireLedger;
  llm: LlmClient;
  temporal: { address: string; namespace: string };
  /** Default `subtreeTaskQueue(role, "local")`; tests use their own so a running agent's worker never takes their tasks. */
  taskQueue?: string;
  /** Slack each Draw gives a child past its subtree window; must match the plan policy (`drawSlackMs`). */
  slackMs?: number;
  /** Reaches hired agents and the Conductor's plan API (tests pass an in-process router). */
  fetch?: typeof fetch;
  onError: (e: unknown) => void;
}

/**
 * The Temporal task queue an agent's sub-hiring worker polls. The local stack and the preprod agents
 * share one Temporal server and namespace, so the queue carries the network: otherwise the devnet
 * Scout takes a preprod tree's activities and fails them (no plan loaded, its own indexer, its own Pricer).
 */
export function subtreeTaskQueue(role: string, network: "local" | "preprod"): string {
  return `cascade-${network}-${role}`;
}

export async function createSubtreeRunner(o: SubtreeRunnerOptions): Promise<SubtreeRunner> {
  const reader = new CascadeClient(o.lucid, o.scripts, o.refs);
  const plans = new Map<string, Plan>();
  const chain = new SdkChainActions({
    lucid: o.lucid,
    scripts: o.scripts,
    refs: o.refs,
    operatorAddress: o.operatorAddress,
    role: o.role,
    signer: o.signer,
    directory: o.directory,
    plans: async (treeId) => {
      const p = plans.get(treeId);
      if (p === undefined) throw new Error(`no plan is loaded for tree ${treeId}`);
      return p;
    },
    ...(o.waitIndexed === undefined ? {} : { waitIndexed: o.waitIndexed }),
    ...(o.slackMs === undefined ? {} : { slackMs: o.slackMs }),
  });
  const taskQueue = o.taskQueue ?? subtreeTaskQueue(o.role, "local");
  const activities = createActivities({ chain, directory: o.directory, compose: composeByMerge, llm: o.llm, ledger: o.ledger, ...(o.fetch === undefined ? {} : { fetch: o.fetch }) });
  const worker = await createWorker({ ...o.temporal, taskQueue, activities });
  const running = worker.run().catch(o.onError);
  const client = await temporalClient(o.temporal);

  return {
    async run(node, context, upstream) {
      if (node === null) return null;
      const planId = context["plan_id"];
      const plansApi = context["plans_api"];
      if (typeof planId !== "string" || typeof plansApi !== "string") return null;
      const plan = plans.get(node.tree_id) ?? (await fetchTreePlan(plansApi, planId, node.tree_id, reader, o.fetch));
      plans.set(node.tree_id, plan);
      const ownSpecHash = (await reader.node(node.node_id)).datum.spec_hash;
      const input: Record<string, JsonValue> = {};
      for (const key of INHERITED) {
        const v = context[key];
        if (v !== undefined) input[key] = v;
      }
      if (upstream !== undefined) input["depends_on"] = upstream;
      const wf = subtreeWorkflowInput(plan, ownSpecHash, { tree_id: node.tree_id, node_id: node.node_id, input });
      if (wf === null) return null;
      return runSubtree(client, taskQueue, wf);
    },
    async stop() {
      worker.shutdown();
      await running;
    },
  };
}

/** `createSubtreeRunner` from the environment; null when the chain services are not configured. */
export async function subtreeRunnerFromEnv(role: AgentRoleName, operatorAddress: string, llm: LlmClient, onError: (e: unknown) => void): Promise<SubtreeRunner | null> {
  const ctx = await chainContextFromEnv();
  const indexerUrl = env("CASCADE_INDEXER_URL");
  if (ctx === null || indexerUrl === undefined) return null;
  const network = cascadeNetworkFromEnv();
  const dbUrl = env("CASCADE_ORCHESTRATOR_DATABASE_URL");
  let ledger: HireLedger = new InMemoryHireLedger();
  if (dbUrl !== undefined) {
    const pool = guardPool(new pg.Pool({ connectionString: dbUrl, max: 3, keepAlive: true }));
    await migrateOrchestratorState(pool);
    ledger = new PostgresHireLedger(pool);
  }
  return createSubtreeRunner({
    role,
    operatorAddress,
    // A Lucid instance of its own: the job runner's Submit selects this wallet on the shared one.
    lucid: await openLucid(network),
    scripts: ctx.scripts,
    refs: ctx.refs,
    signer: ctx.signer,
    directory: referenceDirectory(network),
    waitIndexed: new IndexerClient({ baseUrl: indexerUrl, adminToken: null }).waitIndexed,
    ledger,
    llm,
    temporal: { address: env("CASCADE_TEMPORAL_ADDRESS") ?? "127.0.0.1:27233", namespace: env("CASCADE_TEMPORAL_NAMESPACE") ?? "cascade" },
    taskQueue: subtreeTaskQueue(role, network),
    slackMs: drawSlackMs(planPolicyFor(network)),
    onError,
  });
}
