/**
 * Sample data: the PRD 21.2 demo job as a Plan. Built with the shared plan helpers, so its spec
 * hashes and Merkle root are real and `validatePlan` accepts it. Dev and component tests only.
 */
import {
  bytesToHex,
  computePlanRoot,
  planWindows,
  sha256,
  utf8,
  type NodeSpec,
  type Plan,
  type PlanNode,
} from "@cascade/shared/browser";
import { TUSDM_ASSET_ID } from "@/lib/assets";
import type { PlanEnvelope } from "@/lib/api/schemas";

export const FIXTURE_T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const MIN = 60_000;
const USDM = (whole: number, cents = 0): string => (BigInt(whole) * 1_000_000n + BigInt(cents) * 10_000n).toString();

export const hash32 = (label: string): string => bytesToHex(sha256(utf8(label)));
const REGISTRY_POLICY = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b";
/** Payment key hash an agent signs with; the same derivation the sample tree uses for operators. */
export const verifierKey = (slug: string): string => hash32(`vkh:${slug}`).slice(0, 56);
export const agentId = (slug: string): string => REGISTRY_POLICY + hash32(`agent:${slug}`).slice(0, 48);

export interface FixtureAgent {
  slug: string;
  name: string;
  reputation: number;
  categories: string[];
  rails: ("native" | "masumi" | "metered")[];
  note?: string;
}

export const FIXTURE_AGENTS: FixtureAgent[] = [
  { slug: "conductor", name: "Conductor", reputation: 0.91, categories: ["orchestration"], rails: ["native"] },
  { slug: "scout", name: "Scout", reputation: 0.84, categories: ["market-research"], rails: ["native"] },
  { slug: "pricer", name: "Pricer", reputation: 0.78, categories: ["price-collection"], rails: ["native"] },
  { slug: "lookup-api", name: "Lookup API", reputation: 0.88, categories: ["data-api"], rails: ["metered"] },
  { slug: "flaky-lisan", name: "Flaky Lisan", reputation: 0.41, categories: ["translation"], rails: ["native"], note: "Test agent that times out on purpose" },
  { slug: "lisan", name: "Lisan", reputation: 0.82, categories: ["translation"], rails: ["masumi"] },
  { slug: "checker-a", name: "Checker A", reputation: 0.9, categories: ["verification"], rails: ["native"] },
  { slug: "checker-b", name: "Checker B", reputation: 0.87, categories: ["verification"], rails: ["native"] },
  { slug: "scribe", name: "Scribe", reputation: 0.86, categories: ["writing"], rails: ["native"] },
];

export const agentBySlug = (slug: string): FixtureAgent => {
  const agent = FIXTURE_AGENTS.find((a) => a.slug === slug);
  if (agent === undefined) throw new Error(`unknown fixture agent ${slug}`);
  return agent;
};

const objectSchema = { type: "object" } as const;

interface SpecInput {
  id: string;
  task: string;
  category: string;
  rail: NodeSpec["rail"];
  acceptance: NodeSpec["acceptance"];
  budget: string;
  fee: string;
  workMin: number;
  subHire?: number;
  quorum?: boolean;
}

function spec(input: SpecInput): NodeSpec {
  return {
    version: "1",
    id: input.id,
    task: input.task,
    category: input.category,
    input_schema: objectSchema,
    output_schema: objectSchema,
    acceptance: input.acceptance,
    rail: input.rail,
    price: { asset: TUSDM_ASSET_ID, max_budget: input.budget, max_fee: input.fee },
    deadlines: { work_ms: input.workMin * MIN, compose_ms: 10 * MIN, challenge_window_ms: 10 * MIN, dispute_window_ms: 30 * MIN },
    may_sub_hire: input.subHire !== undefined,
    max_sub_budget_share_bps: input.subHire ?? 0,
    verifier: {
      deterministic: ["schema", "result_hash"],
      quorum: input.quorum === true ? { n: 2, k: 2, fee: USDM(6), bond_lovelace: "5000000", keys: [verifierKey("checker-a"), verifierKey("checker-b")] } : null,
      challenge: true,
      arbitration: input.rail === "native",
    },
  };
}

const node = (s: NodeSpec, primary: string, children: PlanNode[] = [], fallbacks: string[] = []): PlanNode => ({
  spec: s,
  agents: {
    primary: { agent_id: agentId(primary), quote_id: `q-${s.id}-${primary}`, price: s.price.max_budget },
    fallbacks: fallbacks.map((f) => ({ agent_id: agentId(f), quote_id: null, price: s.price.max_budget })),
  },
  children,
});

export const FIXTURE_GOAL =
  "Market entry brief for selling cold-pressed juice in Dubai, with a competitor pricing table, an Arabic translation of the summary, and a sourced fact check.";

function buildPlan(): Plan {
  const root = node(
    spec({ id: "brief", task: FIXTURE_GOAL, category: "orchestration", rail: "native", acceptance: "BuyerAccept", budget: USDM(150), fee: USDM(12), workMin: 5, subHire: 8000 }),
    "conductor",
    [
      node(
        spec({ id: "research", task: "Research the Dubai cold-pressed juice market: size, channels, regulation.", category: "market-research", rail: "native", acceptance: "ParentAccept", budget: USDM(40), fee: USDM(22), workMin: 20, subHire: 5000 }),
        "scout",
        [
          node(
            spec({ id: "prices", task: "Collect retail prices for 12 competitor juice brands in Dubai.", category: "price-collection", rail: "native", acceptance: "ParentAccept", budget: USDM(18), fee: USDM(10), workMin: 15, subHire: 5000 }),
            "pricer",
            [node(spec({ id: "price-lookups", task: "Metered price lookups, billed per call.", category: "data-api", rail: "metered", acceptance: "AutoAfterWindow", budget: USDM(8), fee: "0", workMin: 10 }), "lookup-api")],
          ),
        ],
      ),
      node(spec({ id: "translate", task: "Translate the executive summary into Arabic.", category: "translation", rail: "native", acceptance: "ParentAccept", budget: USDM(15), fee: USDM(15), workMin: 10 }), "flaky-lisan"),
      node(spec({ id: "translate-masumi", task: "Translate the executive summary into Arabic (Masumi fallback).", category: "translation", rail: "masumi", acceptance: "ParentAccept", budget: USDM(15), fee: USDM(15), workMin: 10 }), "lisan"),
      node(spec({ id: "write", task: "Write the brief from the research and price table.", category: "writing", rail: "native", acceptance: "VerifierQuorum", budget: USDM(30), fee: USDM(28), workMin: 25, quorum: true }), "scribe"),
      node(spec({ id: "check-a", task: "Fact check the brief against its cited sources.", category: "verification", rail: "native", acceptance: "ParentAccept", budget: USDM(6), fee: USDM(6), workMin: 10 }), "checker-a"),
      node(spec({ id: "check-b", task: "Independent fact check on a second model provider.", category: "verification", rail: "native", acceptance: "ParentAccept", budget: USDM(6), fee: USDM(6), workMin: 10 }), "checker-b"),
    ],
    ["scout"],
  );

  const draft: Plan = {
    version: "1",
    plan_id: "plan-demo-juice",
    asset: TUSDM_ASSET_ID,
    limits: { max_depth: 3, max_fanout: 8, max_child_share_bps: 5000, min_challenge_window_ms: 10 * MIN, min_safety_margin_ms: 5 * MIN },
    root,
    totals: { budget: USDM(150), fees: USDM(114), structural_lovelace: "14000000", reserve: USDM(26) },
    deadlines: { fund_by: FIXTURE_T0, submit_by: 0, challenge_until: 0, refund_after: 0, dispute_until: 0 },
    plan_root: "00".repeat(32),
  };
  const rootWindow = planWindows(draft).get("brief");
  if (rootWindow === undefined) throw new Error("fixture plan has no root window");
  const submitBy = FIXTURE_T0 + Number(rootWindow.submit_offset) + 30 * MIN;
  const challengeUntil = submitBy + 10 * MIN;
  return {
    ...draft,
    deadlines: { fund_by: FIXTURE_T0, submit_by: submitBy, challenge_until: challengeUntil, refund_after: submitBy, dispute_until: challengeUntil + 30 * MIN },
    plan_root: computePlanRoot(root),
  };
}

export const FIXTURE_PLAN: Plan = buildPlan();

export const FIXTURE_PLAN_ENVELOPE: PlanEnvelope = {
  plan: FIXTURE_PLAN,
  goal: FIXTURE_GOAL,
  status: "draft",
  tree_id: null,
  agents: Object.fromEntries(FIXTURE_AGENTS.map((a) => [agentId(a.slug), { name: a.name, reputation: a.reputation }])),
};
