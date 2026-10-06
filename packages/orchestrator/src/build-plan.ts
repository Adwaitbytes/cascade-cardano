/**
 * Deterministic compiler from a `PlanDraft` to a signed-ready `Plan` (PRD 10.1 steps 3 and 6):
 * budgets with a 10% re-hire reserve, the orchestrator margin, per-node deadlines from the deadline
 * algebra (PRD 7.7), verifier quorums, output schemas and the Merkle `plan_root`.
 */
import {
  computePlanRoot,
  jcsSha256Hex,
  planWindows,
  type AgentRef,
  type JsonValue,
  type NodeSpec,
  type Plan,
  type PlanNode,
} from "@cascade/shared/browser";
import type { StructuralSizer } from "./chain/structural.js";
import { draftErrors, type DraftTask, type PlanDraft } from "./draft.js";
import type { RiskPreset } from "./scoring.js";
import { TestAgentRefusedError } from "./test-agents.js";

const MINUTE = 60_000;

export interface JobIntake {
  goal: string;
  /** x402 asset id of the tree budget. */
  asset: string;
  /** Root budget in base units. */
  budget: string;
  /** POSIX ms by which the buyer funds the root. */
  fund_by: number;
  /** POSIX ms by which the root must submit its result. */
  submit_by: number;
  max_depth: number;
  /** Minimum specialist reputation as the canonical fraction (0 to 1), never a percent; see @cascade/shared reputation.ts. */
  reputation_floor: number;
  risk: RiskPreset;
  allowlist?: string[];
  blocklist?: string[];
}

export interface PlanPolicy {
  /** Orchestrator margin (root fee) in basis points of the budget. */
  margin_bps: number;
  /** Re-hire reserve in basis points of the budget (PRD 10.1 step 3: 10%). */
  reserve_bps: number;
  /** Share of a sub-hiring node's budget passed to its children, in basis points. */
  sub_budget_share_bps: number;
  min_challenge_window_ms: number;
  min_safety_margin_ms: number;
  dispute_window_ms: number;
  /** Structural lovelace per node until the SDK computes exact min-UTxO (PRD 7.8). */
  structural_lovelace_per_node: bigint;
  verifier_bond_lovelace: string;
  /** Upper bound on any node's `work_ms`, whatever effort the draft asks for. */
  max_step_ms?: number;
  /** Upper bound on any node's `compose_ms`; `max_step_ms` when unset. */
  max_compose_ms?: number;
  /** Time the buyer has to fund a drafted plan (`fund_by - now`); 30 minutes when unset. */
  fund_window_ms?: number;
  /**
   * When false, Masumi slots are planned as native slots and Masumi contingencies are dropped (they
   * would re-hire the same native agent): a network without a Masumi payment service (Yaci) can
   * never pay one, and Masumi's own 35-minute minimum window would set the pace of the whole tree.
   */
  masumi_rail?: boolean;
  /**
   * When set, the root's submit_by is the latest moment the plan can need (its critical path,
   * `after` chains, fallbacks and contingencies included, each Draw `draw_slack_ms` late), if that
   * is earlier than the buyer's deadline. Without it the buyer's deadline is submit_by.
   */
  tight_submit_by?: { draw_slack_ms: number };
}

export const DEFAULT_POLICY: PlanPolicy = {
  margin_bps: 1_000,
  reserve_bps: 1_000,
  sub_budget_share_bps: 6_000,
  min_challenge_window_ms: 10 * MINUTE,
  min_safety_margin_ms: 5 * MINUTE,
  dispute_window_ms: 10 * MINUTE,
  structural_lovelace_per_node: 3_000_000n,
  verifier_bond_lovelace: "5000000",
};

/**
 * Yaci DevKit makes a block every second, so a local tree needs no preprod-sized safety windows:
 * shorter challenge, dispute and margin windows let a full buyer flow (fund, work, accept, close)
 * finish in minutes. Budgets and shares are the same as preprod.
 */
export const LOCAL_POLICY: PlanPolicy = {
  ...DEFAULT_POLICY,
  // The tree config takes its minimums from the plan (`buyer-tx.ts`: min_dispute_window is the
  // shortest spec dispute window, which the contract only requires to be positive).
  min_challenge_window_ms: 30_000,
  min_safety_margin_ms: 15_000,
  dispute_window_ms: 30_000,
  // The root closes at its challenge_until, which is fixed at planning from the worst case: every
  // slot running to its deadline. Minute-scale steps keep that worst case near a quarter of an hour
  // for the demo tree; a planner's generous effort estimate would stretch it past an hour.
  max_step_ms: MINUTE,
  max_compose_ms: 30_000,
  fund_window_ms: 5 * MINUTE,
  masumi_rail: false,
  // Yaci settles a payment within seconds; `SdkChainActions` gets this slack (`drawSlackMs`).
  tight_submit_by: { draw_slack_ms: 30_000 },
};

/** Slack a Draw gives a child past its subtree window (`SdkChainActions.slackMs`); 60 s unless the policy plans tighter. */
export const drawSlackMs = (policy: PlanPolicy): number => policy.tight_submit_by?.draw_slack_ms ?? MINUTE;

/** The plan policy for a network: preprod keeps `DEFAULT_POLICY`. */
export const planPolicyFor = (network: "local" | "preprod"): PlanPolicy => (network === "local" ? LOCAL_POLICY : DEFAULT_POLICY);

/**
 * Candidate agents for a task, best first, with the output schema the primary agent advertises for
 * this capability (its agent card `outputSchema`, served at `/output_schema`). That schema becomes
 * the spec's `output_schema`, so it is part of the committed `spec_hash` and is exactly what L0
 * checks the delivered result against. Every fallback must advertise the same schema; a source
 * leaves out candidates that do not. Real sourcing replaces this with ranked directory quotes.
 */
export interface SourcedAgents {
  primary: AgentRef;
  fallbacks: AgentRef[];
  /** Ignored for the root, whose schema is the orchestrator's own. */
  output_schema?: Record<string, JsonValue>;
  /**
   * The highest agent card list price among the candidates, in base units. An agent refuses a job
   * whose `max_budget` is below its list price (preprod A2 and A18: Scout lists 10 ADA and refused
   * slots of 5.4 to 6.8 ADA), so the plan never prices a non-metered slot below it.
   */
  list_price?: string;
}
export type AgentSource = (task: DraftTask | "root", spec: NodeSpec) => SourcedAgents;

export interface BuiltPlan {
  plan: Plan;
  /** Contingency spec id -> the spec id it replaces on failure. */
  contingencies: Record<string, string>;
  /** Spec id -> spec ids whose results it needs first. */
  after: Record<string, string[]>;
  /** Spec id -> ids of the verifier specs that check it. */
  verifiers: Record<string, string[]>;
}

/**
 * Without a quote the buyer approves the slot's budget ceiling as the agent's price; the signer's
 * price-cap gate (PRD 13.2 gate 2) compares every Draw against this value. Metered specs keep the
 * agent's per-call price (calls = total redeemed / price, the indexer's convention).
 */
function priced(refs: SourcedAgents, spec: NodeSpec): { primary: AgentRef; fallbacks: AgentRef[] } {
  const fill = (r: AgentRef): AgentRef => (r.quote_id === null && spec.rail !== "metered" ? { ...r, price: spec.price.max_budget } : r);
  return { primary: fill(refs.primary), fallbacks: refs.fallbacks.map(fill) };
}

export class MissingVerifierKeysError extends Error {
  constructor(readonly specId: string) {
    super(`spec ${specId} uses VerifierQuorum, but no verifier key resolver was given (ADR 1.6)`);
    this.name = "MissingVerifierKeysError";
  }
}

export type BuildResult = { ok: true; built: BuiltPlan } | { ok: false; errors: string[] };

/** Schema from a code-written draft's own fields: only for drafts no LLM wrote, when the agent advertises none. */
function draftOutputSchema(task: DraftTask): Record<string, JsonValue> {
  const properties: Record<string, JsonValue> = {};
  for (const f of task.output_fields) properties[f.name] = { type: f.type, description: f.description };
  // Every agent may label how it produced the result (a model id or `deterministic-fallback`) and
  // add notes on how (sub-hires, fallbacks); a planner that leaves them out must not fail L0.
  properties["llm"] ??= { type: "string", description: "Model id, deterministic-fallback, or none" };
  properties["notes"] ??= { type: "array", description: "How the result was produced" };
  return { type: "object", additionalProperties: false, required: task.output_fields.map((f) => f.name), properties };
}

/**
 * Splits `pool` by integer weights, flooring each share, while no share drops below its minimum:
 * a share under its minimum is pinned there and the rest of the pool is split again among the
 * others. Returns null when the minimums alone exceed the pool.
 */
function split(pool: bigint, weights: number[], mins: bigint[] = weights.map(() => 0n)): bigint[] | null {
  if (mins.reduce((a, b) => a + b, 0n) > pool) return null;
  const pinned = new Set<number>();
  for (;;) {
    const free = pool - [...pinned].reduce((a, i) => a + (mins[i] ?? 0n), 0n);
    const total = BigInt(weights.reduce((a, w, i) => (pinned.has(i) ? a : a + w), 0));
    const shares = weights.map((w, i) => (pinned.has(i) ? (mins[i] ?? 0n) : total === 0n ? 0n : (free * BigInt(w)) / total));
    const short = shares.findIndex((v, i) => !pinned.has(i) && v < (mins[i] ?? 0n));
    if (short === -1) return shares;
    pinned.add(short);
  }
}

/** The plan's budget cannot pay every hired agent its list price. */
export class BudgetBelowListPricesError extends Error {
  constructor(readonly budget: bigint, readonly minimumBudget: bigint, readonly listPrices: { task: string; price: bigint }[]) {
    const priced = listPrices.map((l) => `${l.task} ${l.price}`).join(", ");
    super(`budget ${budget} is too low to pay every hired agent at least its list price (${priced}); raise the budget to at least ${minimumBudget}`);
    this.name = "BudgetBelowListPricesError";
  }
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/**
 * Payment key hash of the agent that will run a verifier task. ADR 1.6 (E7) binds the verifier keys
 * of a VerifierQuorum node into its plan leaf, so the buyer approves who may accept it.
 */
export type VerifierKeyOf = (verifier: DraftTask) => string;

export interface PlanKeys {
  /** Payment key hash of the tree's Masumi purchase wallet P (wallet role masumi-purchaser, ADR 0001 section 8.1). */
  masumiPurchaserHash?: string;
  /**
   * Exact structural reserve from the SDK's min-UTxO sizing (`sdkStructuralSizer`). Without it the
   * plan uses the flat `structural_lovelace_per_node` estimate (offline planning and tests only).
   */
  structural?: StructuralSizer;
  /**
   * Who wrote the draft. An LLM never sources a hard schema an agent cannot know: with `llm`, every
   * task's output schema must come from its hired agent (preprod tree 86f6eb46 challenged a valid
   * Scout result against fields the planner invented). Default `code` (fallback and test drafts).
   */
  draftedBy?: "llm" | "code";
}

class MissingPurchaserError extends Error {
  constructor(specId: string) {
    super(`${specId}: a Masumi slot is paid through the purchase wallet P, and no masumiPurchaserHash was given (ADR 0001 section 8.1)`);
  }
}

/** The draft with every Masumi slot planned as a native one (`PlanPolicy.masumi_rail` false). */
export function withoutMasumiRail(draft: PlanDraft): PlanDraft {
  const dropped = new Set(draft.tasks.filter((t) => t.rail === "masumi" && t.contingency_for !== "").map((t) => t.id));
  return {
    ...draft,
    tasks: draft.tasks
      .filter((t) => !dropped.has(t.id))
      .map((t) => ({ ...t, ...(t.rail === "masumi" ? { rail: "native" as const } : {}), after: t.after.filter((a) => !dropped.has(a)) })),
  };
}

/**
 * Latest offset from `fund_by` at which the root may need to submit: the root's own work, then its
 * children in `after` order (a contingency starts once its primary missed), each failed attempt
 * before a fallback costing a full window plus a refund, every Draw `slack` late, then the safety
 * margin and composition (PRD 7.7 nesting at every Draw).
 */
export function rootCriticalPathMs(plan: Plan, draft: PlanDraft, slack: number): number {
  const windows = planWindows(plan);
  const byId = new Map(plan.root.children.map((c) => [c.spec.id, c]));
  const tasks = new Map(draft.tasks.map((t) => [t.id, t]));
  const resultBy = new Map<string, number>();
  const endBy = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const known = resultBy.get(id);
    if (known !== undefined) return known;
    const node = byId.get(id);
    const window = windows.get(id);
    if (node === undefined || window === undefined || seen.has(id)) return 0;
    const task = tasks.get(id);
    const deps = [...(task?.after ?? []), ...(task === undefined || task.contingency_for === "" ? [] : [task.contingency_for])].filter((d) => byId.has(d));
    const next = new Set(seen).add(id);
    const start = deps.reduce((m, d) => Math.max(m, visit(d, next) + (d === task?.contingency_for ? slack : 0)), 0);
    const retries = node.agents.fallbacks.length * (Number(window.submit_offset) + 2 * slack);
    resultBy.set(id, start + retries + Number(window.submit_offset) + slack);
    endBy.set(id, start + retries + Number(window.total) + slack);
    return resultBy.get(id) ?? 0;
  };
  for (const id of byId.keys()) visit(id, new Set());
  const widest = [...endBy.values()].reduce((m, v) => Math.max(m, v), 0);
  const root = plan.root.spec.deadlines;
  return root.work_ms + widest + plan.limits.min_safety_margin_ms + root.compose_ms;
}

export function buildPlan(draftIn: PlanDraft, intake: JobIntake, agents: AgentSource, policy: PlanPolicy = DEFAULT_POLICY, verifierKeyOf?: VerifierKeyOf, keys: PlanKeys = {}): BuildResult {
  const draft = policy.masumi_rail === false ? withoutMasumiRail(draftIn) : draftIn;
  const errors = draftErrors(draft, intake.max_depth);
  if (!/^(?:0|[1-9][0-9]*)$/.test(intake.budget)) errors.push("budget must be a canonical decimal integer");
  if (errors.length > 0) return { ok: false, errors };

  const budget = BigInt(intake.budget);
  const rootFee = (budget * BigInt(policy.margin_bps)) / 10_000n;
  const reserve = (budget * BigInt(policy.reserve_bps)) / 10_000n;
  const childrenOf = (id: string) => draft.tasks.filter((t) => t.parent === id);
  const schemaErrors: string[] = [];
  const outputSchemaFor = (task: DraftTask, sourced: SourcedAgents): Record<string, JsonValue> => {
    // A labelled test scenario (A8, A9) pins a schema its writer is known to fail; LLM drafts never carry one.
    if (task.test_output_schema !== undefined && keys.draftedBy !== "llm") return task.test_output_schema;
    if (sourced.output_schema !== undefined) return sourced.output_schema;
    if (keys.draftedBy === "llm") schemaErrors.push(`task ${task.id}: the hired agent advertises no output schema; a planner LLM may not supply one`);
    return draftOutputSchema(task);
  };
  const specs = new Map<string, NodeSpec>();

  const cap = (ms: number, max: number | undefined): number => (max === undefined ? ms : Math.min(ms, max));
  const timing = (task: DraftTask | null, hasChildren: boolean) => ({
    work_ms: cap(task === null ? 5 * MINUTE : task.effort_minutes * MINUTE, policy.max_step_ms),
    compose_ms: hasChildren ? cap((task === null ? 10 : 5) * MINUTE, policy.max_compose_ms ?? policy.max_step_ms) : 0,
    challenge_window_ms: policy.min_challenge_window_ms,
    dispute_window_ms: policy.dispute_window_ms,
  });

  const verifierQuorum = (task: DraftTask, budgets: Map<string, bigint>): NodeSpec["verifier"]["quorum"] => {
    const checkers = draft.tasks.filter((v) => v.verifies === task.id);
    if (task.acceptance !== "VerifierQuorum" || checkers.length === 0) return null;
    const fee = checkers.map((c) => budgets.get(c.id) ?? 0n).reduce((m, b) => (b > m ? b : m), 0n);
    if (verifierKeyOf === undefined) throw new MissingVerifierKeysError(task.id);
    // k-of-n majority (PRD 11.1 L1): 2 of 2, 2 of 3, 3 of 4, 3 of 5.
    return { n: checkers.length, k: Math.floor(checkers.length / 2) + 1, fee: fee.toString(), bond_lovelace: policy.verifier_bond_lovelace, keys: checkers.map(verifierKeyOf) };
  };

  // List prices learnt from sourcing (first pass), as floors on each slot's budget (second pass).
  const listed = new Map<string, bigint>();
  let floors = new Map<string, bigint>();
  const subShare = BigInt(policy.sub_budget_share_bps);
  /**
   * The smallest budget a task's slot needs. A native agent is paid its node's fee (budget less what
   * its children draw, at most the sub-hire share), so its fee must reach the list price while the
   * sub-hire share still funds every child's own minimum. Other rails pay the whole budget.
   */
  const required = (task: DraftTask): bigint => {
    const grandkids = childrenOf(task.id);
    const list = floors.get(task.id) ?? 0n;
    if (grandkids.length === 0) return list;
    // `need` out of every `bps` of the budget; a zero share can only fund a zero need (else more than the budget).
    const scaled = (need: bigint, bps: bigint): bigint => (need === 0n ? 0n : bps === 0n ? budget + 1n : ceilDiv(need * 10_000n, bps));
    const forFee = task.rail === "native" ? scaled(list, 10_000n - subShare) : list;
    const forChildren = scaled(grandkids.reduce((s, g) => s + required(g), 0n), subShare);
    return forFee > forChildren ? forFee : forChildren;
  };
  class Unaffordable extends Error {}
  const buildChildren = (parentId: string, pool: bigint): PlanNode[] => {
    const kids = childrenOf(parentId);
    const shares = split(pool, kids.map((k) => k.budget_weight), kids.map(required));
    if (shares === null) throw new Unaffordable();
    const budgets = new Map(kids.map((k, i) => [k.id, shares[i] ?? 0n]));
    return kids.map((task) => {
      const own = budgets.get(task.id) ?? 0n;
      const grandkids = childrenOf(task.id);
      const childPool = grandkids.length > 0 ? (own * BigInt(policy.sub_budget_share_bps)) / 10_000n : 0n;
      const children = grandkids.length > 0 ? buildChildren(task.id, childPool) : [];
      const childSum = children.reduce((s, c) => s + BigInt(c.spec.price.max_budget), 0n);
      const fee = task.rail === "native" ? own - childSum : 0n;
      // ADR 8.1: a Masumi seller is paid by an AddressPayment to the purchase wallet P, which then
      // creates the vested_pay lock the seller's payment service recognises.
      const masumi = task.rail === "masumi";
      if (masumi && keys.masumiPurchaserHash === undefined) throw new MissingPurchaserError(task.id);
      const rail = masumi ? "address" : task.rail;
      const payeeHash = masumi ? keys.masumiPurchaserHash : task.payee_hash;
      const base: NodeSpec = {
        version: "1",
        id: task.id,
        task: task.title,
        category: task.category,
        input_schema: { type: "object" },
        output_schema: draftOutputSchema(task),
        // An address payment is final at Draw (ADR 5.2), so the shared PlanSchema requires AutoAfterWindow.
        acceptance: rail === "address" ? "AutoAfterWindow" : task.acceptance,
        rail,
        price: { asset: intake.asset, max_budget: own.toString(), max_fee: fee.toString() },
        deadlines: timing(task, grandkids.length > 0),
        may_sub_hire: task.may_sub_hire,
        ...(payeeHash === undefined ? {} : { payee_hash: payeeHash }),
        max_sub_budget_share_bps: grandkids.length > 0 ? policy.sub_budget_share_bps : 0,
        verifier: {
          deterministic: task.category === "verification" ? ["schema", "signature"] : ["schema", "result_hash"],
          quorum: verifierQuorum(task, budgets),
          challenge: true,
          arbitration: task.acceptance === "VerifierQuorum",
        },
      };
      const picked = agents(task, base);
      if (rail !== "metered" && picked.list_price !== undefined) listed.set(task.id, BigInt(picked.list_price));
      const sourced: NodeSpec = { ...base, output_schema: outputSchemaFor(task, picked) };
      const spec: NodeSpec = masumi ? { ...sourced, masumi_followup: { agent_identifier: picked.primary.agent_id } } : sourced;
      specs.set(task.id, spec);
      return { spec, agents: priced(picked, spec), children };
    });
  };

  const hireable = budget - rootFee - reserve;
  /** What the hired agent is paid: a native node's fee, or the whole budget on the other rails. */
  const paid = (spec: NodeSpec): bigint => BigInt(spec.rail === "native" ? spec.price.max_fee : spec.price.max_budget);
  const belowList = (): string[] => [...listed].filter(([id, price]) => { const spec = specs.get(id); return spec !== undefined && paid(spec) < price; }).map(([id]) => id);
  const tooLow = (): BudgetBelowListPricesError => {
    // The smallest budget whose hireable part (after margin and reserve) covers every floor.
    const need = childrenOf("root").reduce((s, t) => s + required(t), 0n);
    const hire = (b: bigint) => b - (b * BigInt(policy.margin_bps)) / 10_000n - (b * BigInt(policy.reserve_bps)) / 10_000n;
    const kept = 10_000n - BigInt(policy.margin_bps) - BigInt(policy.reserve_bps);
    let minimum = kept > 0n ? ceilDiv(need * 10_000n, kept) : need;
    while (minimum > 0n && hire(minimum - 1n) >= need) minimum--;
    while (hire(minimum) < need) minimum++;
    return new BudgetBelowListPricesError(budget, minimum, [...listed].filter(([, p]) => p > 0n).map(([task, price]) => ({ task, price })));
  };
  let children: PlanNode[] = [];
  // Pass one sources every slot and learns list prices; when a weighted share falls below one,
  // pass two re-splits each pool with list prices as floors, taking the difference from siblings.
  for (let pass = 1; ; pass++) {
    try {
      children = buildChildren("root", hireable);
    } catch (e) {
      if (e instanceof MissingVerifierKeysError || e instanceof MissingPurchaserError || e instanceof TestAgentRefusedError) return { ok: false, errors: [e.message] };
      if (e instanceof Unaffordable) return { ok: false, errors: [tooLow().message] };
      throw e;
    }
    if (belowList().length === 0) break;
    if (pass === 2) return { ok: false, errors: [tooLow().message] };
    floors = new Map(listed);
    specs.clear();
    schemaErrors.length = 0;
  }
  if (schemaErrors.length > 0) return { ok: false, errors: schemaErrors };
  const childSum = children.reduce((s, c) => s + BigInt(c.spec.price.max_budget), 0n);
  const rootSubShare = budget === 0n ? 0 : Number((childSum * 10_000n + budget - 1n) / budget);
  const rootSpec: NodeSpec = {
    version: "1",
    id: "root",
    task: intake.goal.slice(0, 4000),
    category: "orchestration",
    input_schema: { type: "object" },
    output_schema: {
      type: "object",
      additionalProperties: false,
      required: ["result", "children"],
      properties: { result: { type: "object" }, children: { type: "array" }, partial: { type: "boolean" } },
    },
    acceptance: "BuyerAccept",
    rail: "native",
    price: { asset: intake.asset, max_budget: budget.toString(), max_fee: rootFee.toString() },
    deadlines: timing(null, children.length > 0),
    may_sub_hire: true,
    max_sub_budget_share_bps: Math.min(10_000, Math.max(rootSubShare, 1)),
    verifier: { deterministic: ["schema", "result_hash"], quorum: null, challenge: true, arbitration: true },
  };
  const root: PlanNode = { spec: rootSpec, agents: priced(agents("root", rootSpec), rootSpec), children };

  let maxShare = 1;
  let maxFanout = 1;
  let nodes = 0;
  let fees = 0n;
  const walk = (n: PlanNode): void => {
    nodes++;
    fees += BigInt(n.spec.price.max_fee);
    maxFanout = Math.max(maxFanout, n.children.length);
    const pb = BigInt(n.spec.price.max_budget);
    for (const c of n.children) {
      if (pb > 0n) maxShare = Math.max(maxShare, Number((BigInt(c.spec.price.max_budget) * 10_000n + pb - 1n) / pb));
      walk(c);
    }
  };
  walk(root);

  const draftPlan: Plan = {
    version: "1",
    plan_id: "",
    asset: intake.asset,
    limits: {
      max_depth: intake.max_depth,
      max_fanout: maxFanout,
      max_child_share_bps: Math.min(maxShare, 10_000),
      min_challenge_window_ms: policy.min_challenge_window_ms,
      min_safety_margin_ms: policy.min_safety_margin_ms,
    },
    root,
    totals: {
      budget: budget.toString(),
      fees: fees.toString(),
      structural_lovelace: (keys.structural === undefined ? policy.structural_lovelace_per_node * BigInt(nodes) : keys.structural(root, intake.asset, 0)).toString(),
      reserve: reserve.toString(),
    },
    deadlines: { fund_by: intake.fund_by, submit_by: 0, challenge_until: 0, refund_after: 0, dispute_until: 0 },
    plan_root: computePlanRoot(root),
  };

  const window = planWindows(draftPlan).get("root");
  if (window === undefined) return { ok: false, errors: ["deadline algebra returned no root window"] };
  const minSubmit = intake.fund_by + Number(window.submit_offset);
  if (intake.submit_by < minSubmit) {
    return { ok: false, errors: [`deadline too short: this plan needs submit_by >= ${new Date(minSubmit).toISOString()} (fund_by + ${Number(window.submit_offset) / MINUTE} min)`] };
  }
  const tight = policy.tight_submit_by;
  const submitBy = tight === undefined ? intake.submit_by : Math.min(intake.submit_by, Math.max(minSubmit, intake.fund_by + rootCriticalPathMs(draftPlan, draft, tight.draw_slack_ms)));
  const challengeUntil = submitBy + rootSpec.deadlines.challenge_window_ms;
  const plan: Plan = {
    ...draftPlan,
    deadlines: {
      fund_by: intake.fund_by,
      submit_by: submitBy,
      challenge_until: challengeUntil,
      refund_after: submitBy,
      dispute_until: challengeUntil + rootSpec.deadlines.dispute_window_ms,
    },
  };
  plan.plan_id = `plan-${jcsSha256Hex({ root: plan.plan_root, deadlines: plan.deadlines, budget: plan.totals.budget } as JsonValue).slice(0, 24)}`;

  const contingencies: Record<string, string> = {};
  const after: Record<string, string[]> = {};
  const verifiers: Record<string, string[]> = {};
  for (const t of draft.tasks) {
    if (t.contingency_for !== "") contingencies[t.id] = t.contingency_for;
    after[t.id] = [...t.after];
    if (t.verifies !== "") (verifiers[t.verifies] ??= []).push(t.id);
  }
  return { ok: true, built: { plan, contingencies, after, verifiers } };
}
