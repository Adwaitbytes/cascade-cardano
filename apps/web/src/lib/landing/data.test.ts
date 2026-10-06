import { describe, expect, it } from "vitest";
import type { Tree } from "@/lib/api/schemas";
import { buildLanding, hiresOf, pickBench, pickHeroTree, pickJobTrees, totalsOf, type AgentRow, type TreeRow } from "./data";

const id = (c: string): string => c.repeat(56);

const row = (c: string, over: Partial<TreeRow> = {}): TreeRow => ({
  tree_id: id(c),
  goal: "Market-entry brief",
  state: "closed",
  asset: "lovelace",
  root_budget: "20000000",
  created_at: 1,
  node_count: 3,
  paid: "5000000",
  returned: "15000000",
  structural_returned: "4000000",
  payouts: 2,
  settled_nodes: 2,
  closed_receipts: 0,
  ...over,
});

const node = (nodeId: string, agent: string | null, state: Tree["nodes"][number]["state"], fee = "1000000"): Tree["nodes"][number] => ({
  node_id: nodeId,
  tree_id: id("a"),
  parent_id: null,
  depth: 0,
  kind: "Native",
  operator_vkh: "0".repeat(56),
  payee: "addr_test1",
  agent_name: agent,
  budget: "5000000",
  fee,
  committed: "0",
  children_open: 0,
  spec_hash: "0".repeat(64),
  input_hash: "0".repeat(64),
  result_hash: null,
  acceptance: { type: "ParentAccept" },
  submit_by: 0,
  challenge_until: 0,
  refund_after: 0,
  dispute_until: 0,
  state,
  current_utxo: null,
  external_ref: null,
  tx_ids: [],
});

const tree = (nodes: Tree["nodes"]): Tree => ({
  tree_id: id("a"),
  buyer_vkh: "0".repeat(56),
  asset: "lovelace",
  root_budget: "20000000",
  plan_root: "0".repeat(64),
  config_utxo: `${"0".repeat(64)}#0`,
  state: "closed",
  frozen: false,
  created_slot: 0,
  closed_slot: null,
  nodes,
});

const agent = (name: string, score: number, confidence: number): AgentRow => ({
  agent_asset_id: `${"ab".repeat(28)}${name.length.toString(16).padStart(2, "0")}`,
  name,
  categories: ["research"],
  price: { asset: "lovelace", amount: "1000000" },
  reputation: { score, confidence },
});

describe("pickHeroTree", () => {
  it("replays the tree that settled the most nodes, not the largest tree funded only at the root", () => {
    const rootOnly = row("a", { node_count: 9, settled_nodes: 0, closed_receipts: 0, created_at: 9 });
    const settled = row("b", { node_count: 6, settled_nodes: 2, closed_receipts: 2 });
    expect(pickHeroTree([rootOnly, settled])).toBe(id("b"));
  });

  it("prefers a closed tree, then more payouts, on equal settled nodes", () => {
    const refunded = row("a", { state: "cancelled", settled_nodes: 3, payouts: 9 });
    const closedFew = row("b", { settled_nodes: 3, payouts: 1 });
    const closedMany = row("c", { settled_nodes: 3, payouts: 4 });
    expect(pickHeroTree([refunded, closedFew, closedMany])).toBe(id("c"));
  });

  it("falls back to the largest tree when nothing settled, and to null with no trees", () => {
    const small = row("a", { node_count: 1, settled_nodes: 0 });
    const big = row("b", { node_count: 4, settled_nodes: 0 });
    expect(pickHeroTree([small, big])).toBe(id("b"));
    expect(pickHeroTree([])).toBeNull();
  });
});

describe("pickJobTrees", () => {
  it("keeps finished trees that paid agents, once per identical rerun", () => {
    const jobs = pickJobTrees([
      row("a"),
      row("b"),
      row("c", { state: "open" }),
      row("d", { payouts: 0, paid: "0" }),
      row("e", { state: "cancelled", paid: "3000000" }),
    ]);
    expect(jobs.map((j) => j.tree_id)).toEqual([id("a"), id("e")]);
  });

  it("ranks by nodes settled and caps the count", () => {
    const rows = ["a", "b", "c", "d", "e"].map((c, i) => row(c, { settled_nodes: i, paid: String(i + 1) }));
    expect(pickJobTrees(rows, 3).map((j) => j.tree_id)).toEqual([id("e"), id("d"), id("c")]);
  });
});

describe("hiresOf", () => {
  it("groups nodes by agent and takes each outcome from what was paid", () => {
    const t = tree([node("1".repeat(56), "Conductor", "Settled", "0"), node("2".repeat(56), "Scout", "Settled"), node("3".repeat(56), "Lisan", "Refunded"), node("4".repeat(56), "Conductor", "Settled"), node("5".repeat(56), null, "Funded")]);
    const hires = hiresOf(t, new Map([["2".repeat(56), 1_000_000n], ["4".repeat(56), 3_000_000n]]));
    expect(hires).toEqual([
      { agent: "Conductor", nodes: 2, fee: "1000000", paid: "3000000", outcome: "paid" },
      { agent: "Scout", nodes: 1, fee: "1000000", paid: "1000000", outcome: "paid" },
      { agent: "Lisan", nodes: 1, fee: "1000000", paid: "0", outcome: "refunded" },
      { agent: "Node 555555", nodes: 1, fee: "1000000", paid: "0", outcome: "open" },
    ]);
  });
});

describe("totalsOf", () => {
  it("splits trees by outcome and sums only the most common asset", () => {
    const t = totalsOf(
      [row("a"), row("b", { state: "cancelled", payouts: 1 }), row("c", { state: "cancelled", payouts: 0, paid: "0" }), row("d", { state: "open" }), row("e", { asset: `${"f".repeat(56)}.00`, paid: "999" })],
      40,
      3,
    );
    expect(t).toMatchObject({ trees: 5, closed: 2, refunded: 2, refunded_after_payouts: 1, open: 1, txs: 40, agents_paid: 3, asset: "lovelace" });
    expect(t.paid).toBe("15000000");
    expect(t.returned).toBe("60000000");
    expect(t.structural_returned).toBe("20000000");
  });
});

describe("pickBench", () => {
  it("seats agents hired in the shown jobs first, then by weighted reputation", () => {
    const agents = [agent("Idle", 0.9, 0.9), agent("Scout", 0.3, 0.3), agent("New", 0.5, 0), agent("Pricer", 0.4, 0.9)];
    const t = tree([node("2".repeat(56), "Scout", "Settled")]);
    const data = buildLanding({
      source: "live",
      generated_at: 0,
      complete: true,
      trees: [row("a")],
      jobTrees: [{ tree: t, paidByNode: new Map() }],
      agents,
      txs: 1,
      agentsPaid: 1,
    });
    expect(data.agents.map((a) => a.name)).toEqual(["Scout", "Idle", "Pricer", "New"]);
    expect(pickBench(agents, [], 2).map((a) => a.name)).toEqual(["Idle", "Pricer"]);
  });
});
