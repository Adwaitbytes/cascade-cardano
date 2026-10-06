import { computePlanRoot, type NodeSpec, type Plan, type PlanNode } from "../src/plan.js";

export const ASSET = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";
const AGENT = (n: number) => ({ agent_id: `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b${n.toString(16).padStart(2, "0")}`, quote_id: `q-${n}`, price: "1000000" });
const MIN = 60_000;

export function spec(id: string, overrides: Partial<NodeSpec> = {}): NodeSpec {
  return {
    version: "1",
    id,
    task: `Task ${id}`,
    category: "research",
    input_schema: { type: "object", properties: { topic: { type: "string" } } },
    output_schema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
    acceptance: "ParentAccept",
    rail: "native",
    price: { asset: ASSET, max_budget: "4000000", max_fee: "1000000" },
    deadlines: { work_ms: 20 * MIN, compose_ms: 0, challenge_window_ms: 10 * MIN, dispute_window_ms: 10 * MIN },
    may_sub_hire: false,
    max_sub_budget_share_bps: 0,
    verifier: { deterministic: ["schema", "result_hash"], quorum: null, challenge: true, arbitration: true },
    ...overrides,
  };
}

export const node = (s: NodeSpec, children: PlanNode[] = []): PlanNode => ({ spec: s, agents: { primary: AGENT(children.length), fallbacks: [AGENT(9)] }, children });

export function samplePlan(): Plan {
  const root = node(
    spec("root", {
      acceptance: "BuyerAccept",
      price: { asset: ASSET, max_budget: "25000000", max_fee: "2000000" },
      may_sub_hire: true,
      max_sub_budget_share_bps: 9000,
      deadlines: { work_ms: 5 * MIN, compose_ms: 10 * MIN, challenge_window_ms: 10 * MIN, dispute_window_ms: 10 * MIN },
    }),
    [
      node(
        spec("research", {
          price: { asset: ASSET, max_budget: "12000000", max_fee: "3000000" },
          may_sub_hire: true,
          max_sub_budget_share_bps: 8000,
          deadlines: { work_ms: 5 * MIN, compose_ms: 5 * MIN, challenge_window_ms: 10 * MIN, dispute_window_ms: 10 * MIN },
        }),
        [
          node(spec("search", { rail: "metered", price: { asset: ASSET, max_budget: "1000000", max_fee: "0" } })),
          node(spec("summarise", { rail: "masumi", price: { asset: ASSET, max_budget: "5000000", max_fee: "0" } })),
        ],
      ),
      node(
        spec("check", {
          acceptance: "VerifierQuorum",
          verifier: { deterministic: ["schema"], quorum: { n: 3, k: 2, fee: "100000", bond_lovelace: "5000000", keys: ["aa".repeat(28), "bb".repeat(28), "cc".repeat(28)] }, challenge: true, arbitration: false },
        }),
      ),
    ],
  );
  const fund_by = 1_785_700_000_000;
  const submit_by = fund_by + 6 * 60 * MIN;
  return {
    version: "1",
    plan_id: "plan-1",
    asset: ASSET,
    limits: { max_depth: 3, max_fanout: 4, max_child_share_bps: 6000, min_challenge_window_ms: 10 * MIN, min_safety_margin_ms: 5 * MIN },
    root,
    totals: { budget: "25000000", fees: "6000000", structural_lovelace: "12000000", reserve: "2500000" },
    deadlines: { fund_by, submit_by, challenge_until: submit_by + 10 * MIN, refund_after: submit_by, dispute_until: submit_by + 20 * MIN },
    plan_root: computePlanRoot(root),
  };
}
