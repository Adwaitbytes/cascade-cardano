/**
 * Conductor: the root orchestrator (PRD 21.1, 21.2 steps 1 and 2). A job returns the Plan for the
 * buyer to review and fund: task tree, prices, rails, verifiers, deadlines and `plan_root`.
 * Executing the funded tree runs `nodeWorkflow` on Temporal once chain actions exist (W2, W3).
 */
import { CHECKER_OUTPUT_SCHEMA } from "@cascade/agent-kit";
import { TRANSLATION_OUTPUT_SCHEMA } from "@cascade/agent-flaky-lisan";
import { LOOKUP_OUTPUT_SCHEMA, METERED_PER_CALL_LOVELACE } from "@cascade/agent-lookup-api";
import { PRICER_OUTPUT_SCHEMA } from "@cascade/agent-pricer";
import { SCOUT_OUTPUT_SCHEMA } from "@cascade/agent-scout";
import { SCRIBE_OUTPUT_SCHEMA } from "@cascade/agent-scribe";
import { cascadeAgent, type AgentSigner, type CascadeAgent, type JsonValue, type PaymentRequirementsProvider, type PaymentVerifier, type JobStore } from "@cascade/agent";
import type { AgentRuntime } from "@cascade/agent-kit";
import { masumiCollateralLovelace, masumiMinUtxoLovelace } from "@cascade/shared";
import { MASUMI_RESULT_SCHEMA, orchestratorApi, UnpayableSlotError, withoutTestAgents, planJob, planPolicyFor, RISK_PRESETS, type AgentNames, type AgentSource, type BuyerTxBuilder, type DraftTask, type PlanStore, type RiskPreset, type StructuralSizer, type VerifierKeyOf } from "@cascade/orchestrator";
import type { LlmClient } from "@cascade/orchestrator/llm";
import type { AgentRef, JsonValue as SpecJson } from "@cascade/shared/browser";

export const EXECUTION_STATUS = "plan only: running the funded tree needs @cascade/sdk (W2) and the signer service (W3)";

export const CONDUCTOR_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["plan", "plan_id", "plan_root", "contingencies", "verifiers", "after", "normalization", "llm", "fallback_reason", "execution"],
  properties: {
    plan: { type: "object" },
    plan_id: { type: "string" },
    plan_root: { type: "string", pattern: "^[0-9a-f]{64}$" },
    contingencies: { type: "object" },
    verifiers: { type: "object" },
    after: { type: "object" },
    normalization: { type: "array", items: { type: "string" } },
    llm: { type: "string" },
    fallback_reason: { type: ["string", "null"] },
    execution: { type: "string" },
  },
};

/** Registry ids of the reference agents, by role. `lisan` is the unmodified Masumi agent. */
export interface ReferenceAgentIds {
  conductor: string;
  scout: string;
  pricer: string;
  "lookup-api": string;
  "flaky-lisan": string;
  lisan: string;
  "checker-a": string;
  "checker-b": string;
  "checker-c": string;
  scribe: string;
}

const ref = (agent_id: string, price = "0"): AgentRef => ({ agent_id, quote_id: null, price });

/**
 * A metered slot's AgentRef price is the per-call voucher price (the signer bounds only the channel
 * deposit), so it must be the price the Lookup API charges per voucher, not its 1 ADA address price.
 */
export const LOOKUP_PER_CALL_LOVELACE = METERED_PER_CALL_LOVELACE.toString();

type HiredRole = Exclude<keyof ReferenceAgentIds, "conductor">;

/**
 * The output schema each reference agent advertises: the `outputSchema` of its agent card, served
 * at its `/output_schema`, and what its own job runner checks every result against. Lisan is an
 * unmodified Masumi agent with a plain string result. A plan leaf takes its schema from here, never
 * from the planner LLM.
 */
export const REFERENCE_OUTPUT_SCHEMAS: Record<HiredRole, Record<string, SpecJson>> = {
  scout: SCOUT_OUTPUT_SCHEMA,
  pricer: PRICER_OUTPUT_SCHEMA,
  "lookup-api": LOOKUP_OUTPUT_SCHEMA,
  "flaky-lisan": TRANSLATION_OUTPUT_SCHEMA,
  lisan: MASUMI_RESULT_SCHEMA,
  "checker-a": CHECKER_OUTPUT_SCHEMA,
  "checker-b": CHECKER_OUTPUT_SCHEMA,
  "checker-c": CHECKER_OUTPUT_SCHEMA,
  scribe: SCRIBE_OUTPUT_SCHEMA,
};

/**
 * The list price on each reference agent's card (`pricing.amount`, in its runtime asset). An agent
 * refuses a slot whose payment is below it, so the planner never prices a slot under it. Lisan is
 * paid through Masumi at the price its own payment service sets; the metered Lookup API is paid per call.
 */
export const REFERENCE_LIST_PRICES: Partial<Record<HiredRole, string>> = {
  scout: "10000000",
  pricer: "3000000",
  scribe: "5000000",
  "flaky-lisan": "2000000",
  "lookup-api": "1000000",
  "checker-a": "1000000",
  "checker-b": "1000000",
  "checker-c": "1000000",
};

/**
 * Lisan's registered Masumi price (scripts/register-agents.ts): one Fixed lovelace amount, which its
 * payment service requests in the lock. The Conductor takes the live value from the directory, the
 * same source the lock reads (`masumi_price_lovelace`); this is the fallback.
 */
export const LISAN_MASUMI_PRICE_LOVELACE = "10000000";

/**
 * Upper bound on the CBOR size of a `vested_pay` lock datum, in bytes. A lock for a 120-hex agent
 * identifier and a COSE signature encodes to well under this (agents/conductor/test/demo-schemas.test.ts).
 */
const MASUMI_LOCK_DATUM_BYTES_BOUND = 1_200;

/** coinsPerUtxoByte on preprod (and mainnet) since Babbage; the lock itself reads the live value. */
export const PREPROD_COINS_PER_UTXO_BYTE = 4_310n;

/**
 * The lovelace P must lock to buy a Masumi job at `price`: the price plus any collateral the
 * contract needs when the price is below the lock's post-submit min-UTxO (`masumiLockPlan`). The
 * Masumi protocol fee is taken from the seller's side at withdrawal, so it adds nothing here. The
 * plan's Masumi slot budget must reach this, or the Draw to P is refused
 * (preprod tree e42afead: "the Masumi lock needs 10000000, above the plan's 6736842").
 */
export function masumiLockFloorLovelace(price: bigint, coinsPerUtxoByte: bigint = PREPROD_COINS_PER_UTXO_BYTE): bigint {
  return price + masumiCollateralLovelace(price, masumiMinUtxoLovelace(MASUMI_LOCK_DATUM_BYTES_BOUND, 0, coinsPerUtxoByte));
}

export interface ReferenceSourceOptions {
  /** Lisan's Masumi price in lovelace, as the lock reads it; `LISAN_MASUMI_PRICE_LOVELACE` when absent. */
  masumiPriceLovelace?: string;
  coinsPerUtxoByte?: bigint;
}

const highestListPrice = (roles: HiredRole[]): { list_price?: string } => {
  const prices = roles.map((r) => REFERENCE_LIST_PRICES[r]).filter((p): p is string => p !== undefined).map(BigInt);
  return prices.length === 0 ? {} : { list_price: prices.reduce((a, b) => (b > a ? b : a)).toString() };
};

/**
 * Checker A, B or C for a verifier task: a trailing a, b or c names it; a trailing digit (the
 * planner LLM writes `fact-check-1`, `fact-check-2`) counts 1 = A, 2 = B, 3 = C, so sibling
 * verifiers are distinct checkers with distinct quorum keys.
 */
function checkerLetter(taskId: string): "a" | "b" | "c" {
  const last = taskId.at(-1) ?? "a";
  if (last === "a" || last === "b" || last === "c") return last;
  const digit = Number.parseInt(last, 10);
  return Number.isNaN(digit) ? "a" : (["c", "a", "b"] as const)[digit % 3] ?? "a";
}

/** Reference agents that fail on purpose (PRD 21.1): hired only for a TEST SCENARIO task pinned to them. */
export const TEST_AGENT_ROLES: ReadonlySet<HiredRole> = new Set<HiredRole>(["flaky-lisan"]);

/**
 * Which reference agent a plan task hires. Never a test agent: a native translation goes to Scribe,
 * the general writer; only Lisan on the Masumi rail translates as a specialist.
 */
export function referenceRoleFor(task: DraftTask): HiredRole {
  if (task.category === "verification") return `checker-${checkerLetter(task.id)}`;
  if (task.category === "translation") return task.rail === "masumi" ? "lisan" : "scribe";
  if (task.rail === "address" || task.category === "data-lookup") return "lookup-api";
  if (task.id === "summarise") return "scribe";
  const byCategory: Record<string, HiredRole> = { research: "scout", analysis: "scout", pricing: "pricer", writing: "scribe" };
  return byCategory[task.category] ?? "scout";
}

/**
 * Maps plan tasks to reference agents before quotes exist, with each agent's advertised output
 * schema. Real sourcing (PRD 10.1 steps 4 and 5) replaces this with ranked quotes from the Cascade
 * Directory.
 */
export function referenceAgentSource(ids: ReferenceAgentIds, schemas: Record<HiredRole, Record<string, SpecJson>> = REFERENCE_OUTPUT_SCHEMAS, options: ReferenceSourceOptions = {}): AgentSource {
  const testAgentIds = new Set([...TEST_AGENT_ROLES].map((r) => ids[r]));
  const masumiFloor = masumiLockFloorLovelace(BigInt(options.masumiPriceLovelace ?? LISAN_MASUMI_PRICE_LOVELACE), options.coinsPerUtxoByte).toString();
  return withoutTestAgents((task, spec) => {
    if (task === "root") return { primary: ref(ids.conductor), fallbacks: [] };
    const role = referenceRoleFor(task);
    if (role === "lisan") {
      // Lisan sells in lovelace only and P locks lovelace, so the slot's floor is the lock in lovelace.
      if (spec.price.asset !== "lovelace") throw new UnpayableSlotError(task.id, `Lisan sells through Masumi in lovelace only; a tree funded in ${spec.price.asset} cannot pay its lock`);
      return { primary: ref(ids.lisan), fallbacks: [], output_schema: schemas.lisan, list_price: masumiFloor };
    }
    const price = task.category === "data-lookup" && task.rail !== "address" ? LOOKUP_PER_CALL_LOVELACE : "0";
    // TEST SCENARIO A2: Flaky Lisan (test agent) is hired first and never delivers, so the slot is
    // refunded and re-hires its fallback; the slot takes the schema of the agent that will deliver.
    const list = task.rail === "metered" ? {} : highestListPrice(task.test_flaky_primary === true ? ["flaky-lisan", role] : [role]);
    if (task.test_flaky_primary === true) return { primary: ref(ids["flaky-lisan"]), fallbacks: [ref(ids[role], price)], output_schema: schemas[role], ...list };
    return { primary: ref(ids[role], price), fallbacks: [], output_schema: schemas[role], ...list };
  }, (agentId) => testAgentIds.has(agentId));
}

export interface ConductorDeps {
  runtime: AgentRuntime;
  signer: AgentSigner;
  llm: LlmClient;
  agents: ReferenceAgentIds;
  /** Payment key hashes of Checkers A, B and C, bound into VerifierQuorum plan leaves (ADR 1.6). */
  checkerKeys: { a: string; b: string; c: string };
  /** Payment key hash of the Masumi purchase wallet P (wallet role masumi-purchaser, ADR 0001 section 8.1). */
  masumiPurchaserHash?: string;
  /** Lisan's Masumi price in lovelace from the directory (what the lock will read); the registered price when absent. */
  masumiPriceLovelace?: string;
  /** Exact structural reserve for plans (`sdkStructuralSizer`); a flat estimate without it. */
  structural?: StructuralSizer;
  now?: () => number;
  payments?: { requirements: PaymentRequirementsProvider; verifier: PaymentVerifier };
  /** Durable job store (Postgres in production), so a restart never loses a paid job. */
  store?: JobStore;
  /** Lookup API key for the labelled A5 test scenario; when absent `test_scenario` is refused. */
  scenarioKeys?: { lookupApi: string };
  /** Serves the buyer-console API (`/v1/*`) on the same port when set. */
  api?: { names: AgentNames; allowedOrigins: string[]; txBuilder?: BuyerTxBuilder; store?: PlanStore; onError?: (where: string, e: unknown) => void };
}

const MINUTE = 60_000;

/** Names for the reference agents until the Cascade Directory serves them; reputation is the neutral prior for new agents (PRD 12.3). */
export function referenceAgentNames(ids: ReferenceAgentIds): AgentNames {
  const names: Record<string, string> = {
    [ids.conductor]: "Conductor",
    [ids.scout]: "Scout",
    [ids.pricer]: "Pricer",
    [ids["lookup-api"]]: "Lookup API",
    [ids["flaky-lisan"]]: "Flaky Lisan (test agent)",
    [ids.lisan]: "Lisan (Masumi)",
    [ids["checker-a"]]: "Checker A",
    [ids["checker-b"]]: "Checker B",
    [ids["checker-c"]]: "Checker C",
    [ids.scribe]: "Scribe",
  };
  return { lookup: async (agentIds) => Object.fromEntries(agentIds.map((id) => [id, { name: names[id] ?? "Unknown agent", reputation: 0.5 }])) };
}

/** The key of the checker `referenceRoleFor` hires for a verifier task (ADR 1.6). */
export const referenceVerifierKeys =
  (keys: ConductorDeps["checkerKeys"]): VerifierKeyOf =>
  (task) =>
    keys[checkerLetter(task.id)];

export function createConductorAgent(deps: ConductorDeps): CascadeAgent {
  const now = deps.now ?? Date.now;
  const verifierKeyOf = referenceVerifierKeys(deps.checkerKeys);
  const agents = referenceAgentSource(deps.agents, REFERENCE_OUTPUT_SCHEMAS, deps.masumiPriceLovelace === undefined ? {} : { masumiPriceLovelace: deps.masumiPriceLovelace });
  // Preprod keeps its safety windows; on the one-second-slot devnet they shrink to minutes.
  const policy = planPolicyFor(deps.runtime.network === "cardano:preprod" ? "preprod" : "local");
  return cascadeAgent({
    name: "Conductor",
    description: "Orchestrator: plans a goal into an escrow tree of hired agents, prices it, and returns the Plan to fund.",
    baseUrl: deps.runtime.baseUrl,
    registryAsset: deps.runtime.registryAsset,
    network: deps.runtime.network,
    inputSchema: {
      input_data: [
        { id: "goal", type: "textarea", name: "Goal", validations: [{ validation: "min", value: "10" }, { validation: "max", value: "2000" }] },
        { id: "budget", type: "number", name: "Budget (base units of the tree asset)", validations: [{ validation: "format", value: "integer" }, { validation: "min", value: "1000000" }] },
        { id: "deadline_minutes", type: "number", name: "Deadline (minutes from now)", validations: [{ validation: "format", value: "integer" }, { validation: "min", value: "30" }, { validation: "max", value: "43200" }] },
        { id: "max_depth", type: "number", name: "Maximum depth", validations: [{ validation: "optional", value: "true" }, { validation: "min", value: "1" }, { validation: "max", value: "6" }] },
        { id: "risk", type: "option", name: "Risk preset", data: { values: Object.keys(RISK_PRESETS) }, validations: [{ validation: "optional", value: "true" }, { validation: "max", value: "1" }] },
      ],
    },
    outputSchema: CONDUCTOR_OUTPUT_SCHEMA,
    pricing: { asset: deps.runtime.asset, amount: "15000000", etaMs: 5 * MINUTE, maxSubBudgetShareBps: 9_000 },
    rails: ["native"],
    capabilities: { roles: ["orchestrator"], categories: ["orchestration"], maxDepth: 0, bondLovelace: "0", tags: ["planner", "escrow-tree"] },
    signer: deps.signer,
    ...(deps.payments === undefined ? {} : { payments: deps.payments }),
    ...(deps.store === undefined ? {} : { store: deps.store }),
    ...(deps.api === undefined
      ? {}
      : {
          routes: (app) => {
            const api = deps.api;
            if (api === undefined) return;
            app.route(
              "/",
              orchestratorApi({
                llm: deps.llm,
                agents,
                verifierKeyOf,
                policy,
                ...(deps.masumiPurchaserHash === undefined ? {} : { masumiPurchaserHash: deps.masumiPurchaserHash }),
                ...(deps.structural === undefined ? {} : { structural: deps.structural }),
                ...(deps.scenarioKeys === undefined ? {} : { scenarioKeys: deps.scenarioKeys }),
                names: api.names,
                allowedOrigins: api.allowedOrigins,
                now,
                ...(api.txBuilder === undefined ? {} : { txBuilder: api.txBuilder }),
                ...(api.store === undefined ? {} : { store: api.store }),
                ...(api.onError === undefined ? {} : { onError: api.onError }),
              }),
            );
          },
        }),
    handler: async (input, ctx) => {
      const at = now();
      const risk = (Array.isArray(input["risk"]) ? input["risk"][0] : input["risk"]) as RiskPreset | undefined;
      const planned = await planJob(
        {
          goal: String(input["goal"]),
          asset: deps.runtime.asset,
          budget: BigInt(Math.trunc(Number(input["budget"]))).toString(),
          fund_by: at + (policy.fund_window_ms ?? 30 * MINUTE),
          submit_by: at + Math.trunc(Number(input["deadline_minutes"])) * MINUTE,
          max_depth: input["max_depth"] === undefined ? 3 : Math.trunc(Number(input["max_depth"])),
          reputation_floor: 0.6,
          risk: risk ?? "balanced",
        },
        { llm: deps.llm, agents, verifierKeyOf, policy, ...(deps.masumiPurchaserHash === undefined ? {} : { masumiPurchaserHash: deps.masumiPurchaserHash }), ...(deps.structural === undefined ? {} : { structural: deps.structural }) },
      );
      ctx.log({
        tool: "llm.planner",
        input_sha256: planned.llm_record.input_sha256,
        output_sha256: planned.llm_record.output_sha256,
        meta: { llm: planned.llm, prompt_version: planned.llm_record.prompt_version },
      });
      const { plan, contingencies, verifiers, after } = planned.built;
      return {
        result: {
          plan: plan as unknown as JsonValue,
          plan_id: plan.plan_id,
          plan_root: plan.plan_root,
          contingencies,
          verifiers,
          after,
          normalization: planned.normalization,
          llm: planned.llm,
          fallback_reason: planned.fallback_reason ?? null,
          execution: EXECUTION_STATUS,
        },
      };
    },
  });
}
