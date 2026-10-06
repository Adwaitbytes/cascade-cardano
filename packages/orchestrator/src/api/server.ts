/**
 * Orchestrator HTTP API for the buyer console and arbiter console (W5):
 *
 *   POST /v1/jobs                                     goal and constraints in, plan id out
 *   GET  /v1/plans/:plan_id                           plan envelope for review
 *   POST /v1/plans/:plan_id/fund-tx                   unsigned FundRoot tx for the buyer's wallet
 *   POST /v1/trees/:tree_id/actions                   unsigned Accept, Challenge, Freeze, Unfreeze
 *   POST /v1/disputes/:tree_id/:node_id/resolve-tx    unsigned Resolve for an arbiter
 *
 * Transactions come from `BuyerTxBuilder`, implemented with `@cascade/sdk` (W2). Until it exists
 * the tx routes answer 503 with the reason. The server never signs: wallets do.
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { z } from "zod";
import { PlanningError, planJob } from "../planner.js";
import { buildPlan } from "../build-plan.js";
import { labelledIntake, scenarioDraft, type ScenarioKeys } from "../test-scenarios.js";
import type { AgentSource, JobIntake, PlanPolicy, VerifierKeyOf } from "../build-plan.js";
import type { LlmClient } from "../llm.js";
import {
  CreateJobRequestSchema,
  FundTxRequestSchema,
  ResolveTxRequestSchema,
  TreeActionRequestSchema,
  type BuyerAction,
  type PlanEnvelope,
  type WalletContext,
} from "./schemas.js";
import type { BuyerTerms } from "./buyer-policy.js";
import { InMemoryPlanStore, type PlanStore, type StoredPlan } from "./store.js";
import type { Plan } from "@cascade/shared/browser";
import type { StructuralSizer } from "../chain/structural.js";

/** Unsigned transaction builders for wallet-signed actions (W2 `@cascade/sdk`). */
export interface BuyerTxBuilder {
  /** `terms` are the buyer's intake choices; the signer's gates read the policy built from them. */
  fundRoot(plan: Plan, wallet: WalletContext, terms: BuyerTerms): Promise<{ tx_cbor: string; tree_id: string }>;
  treeAction(treeId: string, action: BuyerAction, nodeId: string, wallet: WalletContext): Promise<{ tx_cbor: string }>;
  resolve(treeId: string, nodeId: string, split: { worker: bigint; parent: bigint }, wallet: WalletContext): Promise<{ tx_cbor: string }>;
}

/** Names and reputation for agent ids, from the Cascade Directory (W3). */
export interface AgentNames {
  lookup(agentIds: string[]): Promise<Record<string, { name: string; reputation: number }>>;
}

export interface OrchestratorApiDeps {
  llm: LlmClient;
  agents: AgentSource;
  verifierKeyOf?: VerifierKeyOf;
  /** The Masumi purchase wallet P's payment key hash (ADR 0001 section 8.1). */
  masumiPurchaserHash?: string;
  /** Exact structural reserve from the SDK's min-UTxO sizing; the console's fund check compares it to the FundRoot. */
  structural?: StructuralSizer;
  /** Keys the labelled test scenarios need; without them `test_scenario` is refused. */
  scenarioKeys?: ScenarioKeys;
  names: AgentNames;
  txBuilder?: BuyerTxBuilder;
  store?: PlanStore;
  /** Browser origins allowed to call the API (the console's public URL). */
  allowedOrigins: string[];
  now?: () => number;
  /** Time the buyer has to fund a drafted plan; the policy's `fund_window_ms`, else 30 minutes. */
  fundWindowMs?: number;
  /** Plan windows and shares; `DEFAULT_POLICY` (preprod) unless given. */
  policy?: PlanPolicy;
  onError?: (where: string, error: unknown) => void;
}

const HEX28 = /^[0-9a-f]{56}$/;
const PLAN_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SDK_PENDING = "unsigned transactions need @cascade/sdk (W2), which is not wired into the orchestrator yet";

type ErrorStatus = 400 | 404 | 409 | 422 | 500 | 503;
const fail = (c: Context, status: ErrorStatus, error: string, detail?: string) => c.json(detail === undefined ? { error } : { error, detail }, status);

async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<{ ok: true; value: z.infer<S> } | { ok: false; detail: string }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, detail: "body is not JSON" };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, detail: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") };
  return { ok: true, value: parsed.data };
}

export function orchestratorApi(deps: OrchestratorApiDeps): Hono {
  const store = deps.store ?? new InMemoryPlanStore();
  const now = deps.now ?? Date.now;
  const fundWindow = deps.fundWindowMs ?? deps.policy?.fund_window_ms ?? 30 * 60_000;
  const onError = deps.onError ?? (() => undefined);
  const planKeys = { ...(deps.masumiPurchaserHash === undefined ? {} : { masumiPurchaserHash: deps.masumiPurchaserHash }), ...(deps.structural === undefined ? {} : { structural: deps.structural }) };
  const app = new Hono();
  // The public console reaches the Conductor through an ngrok tunnel, whose interstitial is skipped
  // by the `ngrok-skip-browser-warning` request header. No credentials: the API is cookie-free.
  app.use("/v1/*", cors({ origin: deps.allowedOrigins, allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["content-type", "accept", "ngrok-skip-browser-warning"], maxAge: 600 }));
  app.use("/v1/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => fail(c, 400, "body_too_large") }));

  const envelope = async (p: StoredPlan): Promise<PlanEnvelope> => {
    const plan = p.built.plan;
    const ids = new Set<string>();
    const walk = (n: Plan["root"]): void => {
      ids.add(n.agents.primary.agent_id);
      for (const f of n.agents.fallbacks) ids.add(f.agent_id);
      n.children.forEach(walk);
    };
    walk(plan.root);
    const status = p.funded ? "funded" : now() > plan.deadlines.fund_by ? "expired" : "draft";
    return { plan, goal: p.request.goal, status, tree_id: p.tree_id, agents: await deps.names.lookup([...ids]) };
  };

  app.post("/v1/jobs", async (c) => {
    const body = await parseBody(c, CreateJobRequestSchema);
    if (!body.ok) return fail(c, 400, "invalid_request", body.detail);
    const req = body.value;
    const at = now();
    if (req.deadline <= at + fundWindow) return fail(c, 422, "deadline_too_soon", "the deadline must leave time to fund and run the tree");
    const intake: JobIntake = {
      goal: req.goal,
      asset: req.asset,
      budget: req.budget,
      fund_by: at + fundWindow,
      submit_by: req.deadline,
      max_depth: req.max_depth,
      reputation_floor: req.min_reputation / 100,
      risk: req.risk,
      allowlist: req.allow_agents,
      blocklist: req.block_agents,
    };
    if (req.test_scenario !== undefined) {
      if (deps.scenarioKeys === undefined) return fail(c, 422, "test_scenarios_disabled");
      const draft = scenarioDraft(req.test_scenario, deps.scenarioKeys);
      const res = buildPlan(draft, labelledIntake(draft, intake), deps.agents, deps.policy, deps.verifierKeyOf, planKeys);
      if (!res.ok) return fail(c, 422, "planning_failed", res.errors.join("; "));
      await store.put({ built: res.built, request: req, llm: `test-scenario: ${req.test_scenario}`, fallback_reason: null, tree_id: null, funded: false, created_at: at });
      return c.json({ plan_id: res.built.plan.plan_id });
    }
    try {
      const planned = await planJob(intake, { llm: deps.llm, agents: deps.agents, ...(deps.policy === undefined ? {} : { policy: deps.policy }), ...(deps.verifierKeyOf === undefined ? {} : { verifierKeyOf: deps.verifierKeyOf }), ...planKeys });
      await store.put({
        built: planned.built,
        request: req,
        llm: planned.llm,
        fallback_reason: planned.fallback_reason ?? null,
        tree_id: null,
        funded: false,
        created_at: at,
      });
      return c.json({ plan_id: planned.built.plan.plan_id });
    } catch (e) {
      if (e instanceof PlanningError) return fail(c, 422, "planning_failed", e.errors.join("; "));
      throw e;
    }
  });

  app.get("/v1/plans/:plan_id", async (c) => {
    const id = c.req.param("plan_id");
    if (!PLAN_ID.test(id)) return fail(c, 400, "invalid_plan_id");
    const p = await store.get(id);
    if (p === null) return fail(c, 404, "plan_not_found");
    return c.json(await envelope(p));
  });

  app.post("/v1/plans/:plan_id/fund-tx", async (c) => {
    const id = c.req.param("plan_id");
    if (!PLAN_ID.test(id)) return fail(c, 400, "invalid_plan_id");
    const body = await parseBody(c, FundTxRequestSchema);
    if (!body.ok) return fail(c, 400, "invalid_request", body.detail);
    const p = await store.get(id);
    if (p === null) return fail(c, 404, "plan_not_found");
    if (p.funded) return fail(c, 409, "plan_already_funded");
    if (now() > p.built.plan.deadlines.fund_by) return fail(c, 409, "plan_expired", "draft a new plan");
    if (deps.txBuilder === undefined) return fail(c, 503, "sdk_not_available", SDK_PENDING);
    const tx = await deps.txBuilder.fundRoot(p.built.plan, body.value, p.request);
    if ((await store.assignTree(id, tx.tree_id)) === "tree_funded") return fail(c, 409, "tree_already_funded", "this wallet's seed UTxO already funded a tree; refresh the wallet UTxOs and build again");
    return c.json({ tx_cbor: tx.tx_cbor, tree_id: tx.tree_id });
  });

  app.post("/v1/trees/:tree_id/actions", async (c) => {
    const treeId = c.req.param("tree_id");
    if (!HEX28.test(treeId)) return fail(c, 400, "invalid_tree_id");
    const body = await parseBody(c, TreeActionRequestSchema);
    if (!body.ok) return fail(c, 400, "invalid_request", body.detail);
    if (deps.txBuilder === undefined) return fail(c, 503, "sdk_not_available", SDK_PENDING);
    const { action, node_id, ...wallet } = body.value;
    return c.json({ tx_cbor: (await deps.txBuilder.treeAction(treeId, action, node_id, wallet)).tx_cbor });
  });

  app.post("/v1/disputes/:tree_id/:node_id/resolve-tx", async (c) => {
    const treeId = c.req.param("tree_id");
    const nodeId = c.req.param("node_id");
    if (!HEX28.test(treeId) || !HEX28.test(nodeId)) return fail(c, 400, "invalid_node");
    const body = await parseBody(c, ResolveTxRequestSchema);
    if (!body.ok) return fail(c, 400, "invalid_request", body.detail);
    if (deps.txBuilder === undefined) return fail(c, 503, "sdk_not_available", SDK_PENDING);
    const { worker, parent, ...wallet } = body.value;
    return c.json({ tx_cbor: (await deps.txBuilder.resolve(treeId, nodeId, { worker: BigInt(worker), parent: BigInt(parent) }, wallet)).tx_cbor });
  });

  app.onError((e, c) => {
    onError(`${c.req.method} ${c.req.path}`, e);
    return fail(c, 500, "internal_error");
  });
  return app;
}

/** Marks a plan funded once the indexer reports its FundRoot (called by the indexer listener). */
export async function markPlanFunded(store: PlanStore, planId: string, treeId: string): Promise<void> {
  if (!HEX28.test(treeId)) throw new Error("tree id must be 28 bytes of hex");
  await store.update(planId, (p) => ({ ...p, tree_id: treeId, funded: true }));
}
