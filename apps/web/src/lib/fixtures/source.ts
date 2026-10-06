/**
 * Dev-only fixture adapter. `lib/api/index.ts` imports it only when FIXTURE_MODE is on, which is
 * a build-time `false` in production, so it never ships in a production bundle.
 */
import { TUSDM_ASSET_ID } from "@/lib/assets";
import { landingSnapshot } from "@/lib/landing/snapshot";
import { ApiError, type DataSource } from "@/lib/api/source";
import type { AgentProfile, AgentSummary, Dispute, OpsStatus, ProviderWork, TreeListItem } from "@/lib/api/schemas";
import { FIXTURE_AGENTS, FIXTURE_PLAN, FIXTURE_PLAN_ENVELOPE, FIXTURE_T0, agentId, hash32 } from "./plan";
import { FIXTURE_CLOSED, FIXTURE_LIVE, type FixtureTree } from "./tree";

const TREES: FixtureTree[] = [FIXTURE_CLOSED, FIXTURE_LIVE];
const LATENCY_MS = 120;

const delay = <T,>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), LATENCY_MS));

function treeOrThrow(treeId: string): FixtureTree {
  const found = TREES.find((t) => t.tree.tree_id === treeId);
  if (found === undefined) throw new ApiError(`Tree ${treeId} is not in the sample data`, 404, "/v1/trees");
  return found;
}

function summary(slug: string): AgentSummary {
  const a = FIXTURE_AGENTS.find((x) => x.slug === slug);
  if (a === undefined) throw new ApiError(`Agent ${slug} not found`, 404, "/v1/agents");
  return {
    agent_asset_id: agentId(a.slug),
    name: a.name,
    api_url: `https://${a.slug}.agents.cascade.example`,
    categories: a.categories,
    rails: a.rails,
    availability: a.slug === "flaky-lisan" ? "unknown" : "available",
    reputation: { score: a.reputation, confidence: 0.7 },
  };
}

function profile(assetId: string): AgentProfile {
  const a = FIXTURE_AGENTS.find((x) => agentId(x.slug) === assetId);
  if (a === undefined) throw new ApiError(`Agent ${assetId} not found`, 404, "/v1/agents");
  const s = summary(a.slug);
  const category = a.categories[0] ?? "general";
  return {
    ...s,
    payment_vkh: hash32(`vkh:${a.slug}`).slice(0, 56),
    capabilities: { version: "1", roles: a.slug === "conductor" ? ["orchestrator"] : a.categories.includes("verification") ? ["verifier"] : ["specialist"], categories: a.categories, max_depth: a.slug === "scout" ? 2 : 0, rails: a.rails, bond_lovelace: "5000000", registry_asset_id: assetId, ...(a.slug === "flaky-lisan" ? { test_agent: true } : {}) },
    signals: {
      [category]: {
        settled_jobs: Math.round(a.reputation * 60),
        on_time_rate: Math.min(1, a.reputation + 0.05),
        verifier_pass_rate: a.reputation,
        refunds: Math.round((1 - a.reputation) * 12),
        disputes_lost: a.slug === "flaky-lisan" ? 3 : 0,
        distinct_buyers: Math.round(a.reputation * 20),
      },
    },
    last_seen: FIXTURE_T0 + 3 * 3600_000,
  };
}

const HISTORY: TreeListItem[] = [
  {
    tree_id: FIXTURE_LIVE.tree.tree_id,
    goal: FIXTURE_LIVE.goal,
    asset: TUSDM_ASSET_ID,
    root_budget: "150000000",
    paid: "93420000",
    refunded: "0",
    recovered: "15000000",
    state: "open",
    created_at: FIXTURE_T0,
    node_count: FIXTURE_LIVE.tree.nodes.length,
    agents: ["Conductor", "Scout", "Pricer", "Lookup API", "Flaky Lisan", "Lisan", "Scribe", "Checker A", "Checker B"],
    spend_by_category: { "market-research": "22000000", "price-collection": "16420000", translation: "15000000", writing: "28000000", verification: "12000000" },
  },
  {
    tree_id: FIXTURE_CLOSED.tree.tree_id,
    goal: FIXTURE_CLOSED.goal,
    asset: TUSDM_ASSET_ID,
    root_budget: "150000000",
    paid: "105420000",
    refunded: "44580000",
    recovered: "15000000",
    state: "closed",
    created_at: FIXTURE_T0 - 86_400_000,
    node_count: FIXTURE_CLOSED.tree.nodes.length,
    agents: ["Conductor", "Scout", "Pricer", "Lookup API", "Flaky Lisan", "Lisan", "Scribe", "Checker A", "Checker B"],
    spend_by_category: { orchestration: "12000000", "market-research": "22000000", "price-collection": "16420000", translation: "15000000", writing: "28000000", verification: "12000000" },
  },
];

const writeSpec = (() => {
  const walk = (n: typeof FIXTURE_PLAN.root): typeof n.spec | null => (n.spec.id === "write" ? n.spec : n.children.map(walk).find((s) => s !== null) ?? null);
  return walk(FIXTURE_PLAN.root);
})();

const DISPUTES: Dispute[] = [
  {
    tree_id: hash32("dispute-tree-1").slice(0, 56),
    node_id: hash32("dispute-node-1").slice(0, 56),
    agent_name: "Scribe",
    state: "Disputed",
    dispute_until: FIXTURE_T0 + 5 * 3600_000,
    locked: { asset: TUSDM_ASSET_ID, amount: "30000000" },
    fee: "28000000",
    arbiters: [hash32("arb-1").slice(0, 56), hash32("arb-2").slice(0, 56), hash32("arb-3").slice(0, 56)],
    threshold: 2,
    spec: writeSpec,
    spec_hash: hash32("spec:write"),
    input_hash: hash32("dispute-input"),
    result_hash: hash32("dispute-result"),
    reason_hash: hash32("reason: price table cites a closed store"),
    bundles: { worker: hash32("bundle-worker"), challenger: hash32("bundle-challenger") },
    verdicts: [
      { verifier: agentId("checker-a"), verifier_name: "Checker A", verdict: "accept", score: 0.71, evidence_hash: hash32("ev-a"), checks: [{ name: "schema", passed: true }, { name: "sources resolve", passed: true }] },
      { verifier: agentId("checker-b"), verifier_name: "Checker B", verdict: "reject", score: 0.38, evidence_hash: hash32("ev-b"), checks: [{ name: "schema", passed: true }, { name: "sources resolve", passed: false }] },
    ],
    gate_logs: [],
    challenge_tx: hash32("challenge-tx-1"),
  },
  {
    tree_id: hash32("dispute-tree-2").slice(0, 56),
    node_id: hash32("dispute-node-2").slice(0, 56),
    agent_name: "Pricer",
    state: "Challenged",
    dispute_until: FIXTURE_T0 + 9 * 3600_000,
    locked: { asset: TUSDM_ASSET_ID, amount: "18000000" },
    fee: "10000000",
    arbiters: [hash32("arb-1").slice(0, 56), hash32("arb-2").slice(0, 56), hash32("arb-3").slice(0, 56)],
    threshold: 2,
    spec: null,
    spec_hash: hash32("spec:prices"),
    input_hash: hash32("dispute-input-2"),
    result_hash: hash32("dispute-result-2"),
    reason_hash: hash32("reason: 4 of 12 brands missing"),
    bundles: { worker: null, challenger: hash32("bundle-challenger-2") },
    verdicts: [],
    gate_logs: [],
    challenge_tx: hash32("challenge-tx-2"),
  },
];

const OPS: OpsStatus = {
  indexer: { tip_slot: 138_244_512, indexed_slot: 138_244_509, lag_ms: 3_000, rollbacks_24h: 1 },
  facilitator: { queued: 2, settlement_pending: 1, settled_24h: 47, rejected_24h: 3 },
  cranks: [
    { action: "Refund", tree_id: FIXTURE_CLOSED.tree.tree_id, node_id: FIXTURE_CLOSED.tree.nodes[2]?.node_id ?? FIXTURE_CLOSED.tree.tree_id, tx_id: hash32("demo-closed:tx:refund:flaky"), at: FIXTURE_T0 + 250_000 },
    { action: "Accept", tree_id: FIXTURE_CLOSED.tree.tree_id, node_id: FIXTURE_CLOSED.tree.tree_id, tx_id: hash32("crank-accept"), at: FIXTURE_T0 + 900_000 },
  ],
  failed_txs: [{ action: "Draw", tx_id: null, error: "Script evaluation failed: child dispute_until + margin exceeds parent submit_by", at: FIXTURE_T0 + 120_000 }],
  exec_units: [
    { redeemer: "FundRoot", mem: 1_812_004, steps: 612_330_118, max_mem: 14_000_000, max_steps: 10_000_000_000, samples: 12 },
    { redeemer: "Draw", mem: 9_640_220, steps: 3_402_118_902, max_mem: 14_000_000, max_steps: 10_000_000_000, samples: 41 },
    { redeemer: "Submit", mem: 2_104_880, steps: 701_553_210, max_mem: 14_000_000, max_steps: 10_000_000_000, samples: 38 },
    { redeemer: "Accept", mem: 2_340_016, steps: 790_120_004, max_mem: 14_000_000, max_steps: 10_000_000_000, samples: 36 },
    { redeemer: "Refund", mem: 3_020_512, steps: 1_002_410_774, max_mem: 14_000_000, max_steps: 10_000_000_000, samples: 5 },
    { redeemer: "SettleChild", mem: 5_880_342, steps: 2_010_887_301, max_mem: 14_000_000, max_steps: 10_000_000_000, samples: 33 },
    { redeemer: "CloseReceipt", mem: 6_402_118, steps: 2_300_441_020, max_mem: 14_000_000, max_steps: 10_000_000_000, samples: 9 },
    { redeemer: "CloseRoot", mem: 4_110_235, steps: 1_420_556_118, max_mem: 14_000_000, max_steps: 10_000_000_000, samples: 11 },
  ],
};

const WORK: ProviderWork = {
  quote_requests: [
    { spec_hash: hash32("quote-1"), task: "Collect retail prices for 8 competitor kombucha brands in Riyadh.", max_budget: { asset: TUSDM_ASSET_ID, amount: "15000000" }, submit_by: FIXTURE_T0 + 4 * 3600_000, received_at: FIXTURE_T0 + 600_000 },
    { spec_hash: hash32("quote-2"), task: "Price table for oat milk brands in Abu Dhabi supermarkets.", max_budget: { asset: TUSDM_ASSET_ID, amount: "12000000" }, submit_by: FIXTURE_T0 + 7 * 3600_000, received_at: FIXTURE_T0 + 1_500_000 },
  ],
  active_jobs: [
    { tree_id: FIXTURE_LIVE.tree.tree_id, node_id: FIXTURE_LIVE.tree.nodes[7]?.node_id ?? FIXTURE_LIVE.tree.tree_id, task: "Collect retail prices for 12 competitor juice brands in Dubai.", fee: { asset: TUSDM_ASSET_ID, amount: "10000000" }, state: "Settled", state_tx: hash32("demo-live:tx:settle:pricer"), next_deadline: FIXTURE_T0 + 2 * 3600_000 },
  ],
  earnings: { paid: { asset: TUSDM_ASSET_ID, amount: "486500000" }, pending: { asset: TUSDM_ASSET_ID, amount: "10000000" }, jobs_settled: 47, jobs_refunded: 3 },
  bonds_at_risk_lovelace: "5000000",
};

/** Hashes of the preprod deployment at the time of writing; dev and tests only. */
export const FIXTURE_DEPLOYMENT = {
  network: "preprod" as const,
  scripts: { node: "5f58ba03d373f7510827aa4cb5c39615d0e65ea3630169afaa48abee", config: "a356b07564f29624375eb1612cc7387e454ebb0df1bee2b1e98cda4c" },
  oracle_address: null,
};

const SAMPLE_ROOT_ADDRESS = "addr_test1xp043wsr6delw5ggy74yedwrjc2apej75d3sz6d04fy2hmjltzaq85mn7agssfa2fj6u89s46rn9agmrq956l2jg40hqp8puxf";
const SAMPLE_CONFIG_ADDRESS = "addr_test1wz34dvr4vnefvfpht6ckztx88ply2n4mphcmac43axxd5nqgm0ljq";
export const SAMPLE_BUYER_ADDRESS = "addr_test1qqcpl6pst4j2wh0jdnya4hmhglhz0kj0rfa9pc6as9t7x8004y7jr7qlnj4wnxxle0jw5l9jsu0uyc53e47w3gyc0ddsl6xewv";

/**
 * Indexer-shaped preview of the sample FundRoot at the deployed script addresses. Setting
 * localStorage `cascade-sample-preview` to `mismatch` makes it disagree with the plan, so the
 * blocked state can be seen and tested in development.
 */
function fixtureFundPreview() {
  let mismatch = false;
  try {
    mismatch = window.localStorage.getItem("cascade-sample-preview") === "mismatch";
  } catch {
    mismatch = false;
  }
  const node = FIXTURE_DEPLOYMENT.scripts.node;
  const tree = FIXTURE_LIVE.tree.tree_id;
  return {
    tx_body_hash: hash32("fund-tx-body"),
    summary: "Fund root with 150.00 USDM and 14.00 ADA structural reserve. Network fee 0.62 ADA.",
    actions: [{ type: "FundRoot" as const, node_id: tree, text: "Create the root escrow and its tree config for plan plan-demo-juice." }],
    moves: [
      { to: SAMPLE_ROOT_ADDRESS, value: { asset: "lovelace", amount: mismatch ? "13000000" : "14000000" } },
      { to: SAMPLE_ROOT_ADDRESS, value: { asset: TUSDM_ASSET_ID, amount: mismatch ? "151000000" : "150000000" } },
      { to: SAMPLE_ROOT_ADDRESS, value: { asset: `${node}.${tree}`, amount: "1" } },
      { to: SAMPLE_CONFIG_ADDRESS, value: { asset: "lovelace", amount: "2133150" } },
      { to: SAMPLE_CONFIG_ADDRESS, value: { asset: `${node}.63${tree}`, amount: "1" } },
      { to: SAMPLE_BUYER_ADDRESS, value: { asset: "lovelace", amount: "9826245718" } },
      { to: SAMPLE_BUYER_ADDRESS, value: { asset: TUSDM_ASSET_ID, amount: "850000000" } },
    ],
    warnings: [],
  };
}

export const fixtureTrees = TREES;
export const FIXTURE_DEMO_TREE_ID = FIXTURE_CLOSED.tree.tree_id;
export const FIXTURE_LIVE_TREE_ID = FIXTURE_LIVE.tree.tree_id;

export function createFixtureSource(): DataSource {
  return {
    kind: "fixture",
    getDeployment: async () => delay(FIXTURE_DEPLOYMENT),
    getTree: async (treeId) => delay(treeOrThrow(treeId).tree),
    getTreeEvents: async (treeId) => delay({ events: treeOrThrow(treeId).events, warnings: [] }),
    async getReceipt(treeId) {
      const t = treeOrThrow(treeId);
      if (t.receipt === null) throw new ApiError("The receipt is issued when the root closes.", 404, "/v1/trees/receipt");
      return delay(t.receipt);
    },
    async getNodeDetail(treeId, nodeId) {
      const detail = treeOrThrow(treeId).details.get(nodeId);
      if (detail === undefined) throw new ApiError(`Node ${nodeId} not found`, 404, "/v1/trees/nodes");
      return delay(detail);
    },
    getAgent: async (assetId) => delay(profile(assetId)),
    searchAgents: async () => delay(FIXTURE_AGENTS.map((a) => summary(a.slug))),
    previewTx: async () => delay(fixtureFundPreview()),
    createJob: async () => delay({ plan_id: FIXTURE_PLAN.plan_id }),
    async getPlan(planId) {
      if (planId !== FIXTURE_PLAN.plan_id) throw new ApiError(`Plan ${planId} is not in the sample data`, 404, "/v1/plans");
      return delay(FIXTURE_PLAN_ENVELOPE);
    },
    // Not a real transaction: the sample flow stops at the wallet, which rejects it.
    requestFundTx: async () => delay({ tx_cbor: "84a0a0f5f6", tree_id: FIXTURE_LIVE.tree.tree_id }),
    buildTreeActionTx: async () => {
      throw new ApiError("Sample data cannot build transactions. Connect the orchestrator to act on a real tree.", 501, "/v1/trees/actions");
    },
    listTrees: async (_buyer, limit) => delay(limit === undefined ? HISTORY : HISTORY.slice(0, limit)),
    getLanding: async () => delay(landingSnapshot()),
    listDisputes: async () => delay(DISPUTES),
    buildResolveTx: async () => {
      throw new ApiError("Sample data cannot build a Resolve transaction. Connect the signer service to collect arbiter signatures.", 501, "/v1/disputes/resolve-tx");
    },
    getOpsStatus: async () => delay(OPS),
    getProviderWork: async () => delay(WORK),
    subscribeTree(_treeId, _since, handlers) {
      handlers.onStatus("sample");
      return { close: () => undefined };
    },
  };
}
