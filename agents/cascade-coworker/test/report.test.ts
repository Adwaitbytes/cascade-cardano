import { describe, expect, it } from "vitest";
import { formatAda, renderReport, type ReportInput } from "../src/report.js";

const tree = "a".repeat(56);
const child = "b".repeat(56);
const input: ReportInput = {
  goal: "Market-entry brief for cold-pressed juice in Dubai",
  treeId: tree,
  outcome: {
    node_id: tree,
    result_hash: "c".repeat(64),
    partial: false,
    children: [{ status: "accepted", spec_id: "brief" }],
    result: {
      result: {
        brief: { brief: "# Brief\nDubai is a growing market.", summary: "Enter through gyms.", llm: "claude" },
        market: { competitors: [{ brand: "Pressed | Co", positioning: "premium" }], price_table: [{ brand: "Pressed", product: "Green", size_ml: 300, price_aed: 28 }], findings: [], notes: [], llm: "x" },
      },
      children: ["brief", "market"],
      partial: false,
    },
  },
  tree: {
    tree_id: tree,
    asset: "lovelace",
    root_budget: "80000000",
    state: "open",
    nodes: [
      { node_id: child, parent_id: tree, depth: 1, kind: "Native", agent_name: "Cascade Scribe", state: "Settled", budget: "20000000", fee: "5000000", tx_ids: ["d".repeat(64)] },
      { node_id: tree, parent_id: null, depth: 0, kind: "Native", agent_name: "Cascade Conductor", state: "Accepted", budget: "80000000", fee: "8000000", tx_ids: ["e".repeat(64)] },
    ],
  },
  receipt: {
    tree_id: tree,
    deposits: { asset: "lovelace", amount: "80000000" },
    payouts: { asset: "lovelace", amount: "13000000" },
    refunds: { asset: "lovelace", amount: "0" },
    balanced: true,
    lines: [
      { node_id: child, kind: "fee", to: "addr_test1q", value: { asset: "lovelace", amount: "5000000" }, tx_id: "d".repeat(64) },
      { node_id: tree, kind: "fee", to: "addr_test1q", value: { asset: "lovelace", amount: "8000000" }, tx_id: "e".repeat(64) },
      { node_id: tree, kind: "deposit", to: "tree", value: { asset: "lovelace", amount: "80000000" }, tx_id: "f".repeat(64) },
    ],
  },
  fundTx: "f".repeat(64),
  acceptTx: "e".repeat(64),
  site: "https://cascade-alpha-amber.vercel.app",
  masumi: { blockchainIdentifier: "0123456789abcdef0123", lockTx: "9".repeat(64) },
};

describe("formatAda", () => {
  it("prints whole and fractional ADA without trailing zeros", () => {
    expect(formatAda(80_000_000n)).toBe("80 ADA");
    expect(formatAda(1_500_000n)).toBe("1.5 ADA");
    expect(formatAda(0n)).toBe("0 ADA");
  });
});

describe("renderReport", () => {
  const text = renderReport(input);
  it("leads with the deliverable: brief, summary, competitors and a price table", () => {
    expect(text.startsWith("# Market-entry brief for cold-pressed juice in Dubai")).toBe(true);
    expect(text).toContain("Dubai is a growing market.");
    expect(text).toContain("**Summary.** Enter through gyms.");
    expect(text).toContain("- Pressed / Co: premium");
    expect(text).toContain("| brand | product | size_ml | price_aed |");
    expect(text).toContain("| Pressed | Green | 300 | 28 |");
  });
  it("lists each hired agent with what it was paid, root first, and the links", () => {
    expect(text).toContain("| Cascade Conductor | 0 | 80 ADA | 8 ADA | Accepted |");
    expect(text).toContain("| Cascade Scribe | 1 | 20 ADA | 5 ADA | Settled |");
    expect(text.indexOf("Cascade Conductor |")).toBeLessThan(text.indexOf("Cascade Scribe |"));
    expect(text).toContain(`https://cascade-alpha-amber.vercel.app/tree/${tree}`);
    expect(text).toContain(`https://cascade-alpha-amber.vercel.app/receipt/${tree}`);
    expect(text).toContain(`https://preprod.cardanoscan.io/transaction/${"f".repeat(64)}`);
    expect(text).toContain("80 ADA locked, 13 ADA paid to agents, 0 ADA refunded");
    expect(text).toContain(`https://preprod.cardanoscan.io/transaction/${"9".repeat(64)}`);
  });
  it("says plainly when the tree delivered nothing", () => {
    const empty = renderReport({ ...input, outcome: null, failure: "The tree had not delivered by this Task's result deadline." });
    expect(empty).toContain("had not delivered");
    expect(empty).not.toMatch(/\s$/);
  });
  it("uses no em dashes", () => expect(text).not.toContain("—"));
});
