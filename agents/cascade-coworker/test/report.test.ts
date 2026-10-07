import { readFileSync } from "node:fs";
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
    expect(text).toContain("## Executive summary\n\nEnter through gyms.");
    expect(text.indexOf("## Executive summary")).toBeLessThan(text.indexOf("## Brief"));
    expect(text).toContain("### Brief\nDubai is a growing market.");
    expect(text).toContain("| Pressed / Co | premium |");
    expect(text).toContain("| Brand | Product | Size (ml) | Price (AED) |");
    expect(text).toContain("| Pressed | Green | 300 | 28 |");
  });
  it("lists each hired agent with what it was paid, root first, and the links", () => {
    expect(text).toContain(`| Cascade Conductor | Planned the job, hired and paid the team | 8 ADA |  | [Accepted](https://preprod.cardanoscan.io/transaction/${"e".repeat(64)}) |`);
    expect(text).toContain("| Cascade Scribe | Wrote the brief and executive summary | 5 ADA |  | [Settled]");
    expect(text.indexOf("Cascade Conductor |")).toBeLessThan(text.indexOf("Cascade Scribe |"));
    expect(text).toContain(`https://cascade-alpha-amber.vercel.app/tree/${tree}`);
    expect(text).toContain(`https://cascade-alpha-amber.vercel.app/receipt/${tree}`);
    expect(text).toContain(`https://preprod.cardanoscan.io/transaction/${"f".repeat(64)}`);
    expect(text).toContain("80 ADA locked · 13 ADA paid to agents · 0 ADA refunded · ledger balanced");
    expect(text.indexOf("## How this was made")).toBeGreaterThan(text.indexOf("## Price table"));
    expect(text).toContain(`https://preprod.cardanoscan.io/transaction/${"9".repeat(64)}`);
  });
  it("says plainly when the tree delivered nothing", () => {
    const empty = renderReport({ ...input, outcome: null, failure: "The tree had not delivered by this Task's result deadline." });
    expect(empty).toContain("had not delivered");
    expect(empty).not.toMatch(/\s$/);
  });
  it("uses no em dashes", () => expect(text).not.toContain("—"));
});

describe("renderReport on the showcase Task (preprod tree c011aadb)", () => {
  const showcase = JSON.parse(readFileSync(new URL("./fixtures/showcase-c011aadb.json", import.meta.url), "utf8")) as { goal: string; tree_id: string; result_hash: string; result: never };
  const text = renderReport({ ...input, goal: showcase.goal, treeId: showcase.tree_id, outcome: { node_id: showcase.tree_id, result_hash: showcase.result_hash, partial: false, children: [], result: showcase.result } });
  it("is one brief, answer first, then how it was made, with no per-agent dumps", () => {
    expect(text).not.toMatch(/^## (scout|scribe|translate-ar)$/m);
    expect(text.match(/^# /gm)).toHaveLength(1);
    expect(text).not.toContain("## Further detail");
    // The English brief Scribe echoed from the translation slot (with its invented competitors) is dropped.
    expect(text).not.toContain("Naked Juice");
    expect(text).not.toMatch(/^## (Translation|Arabic summary)$/m);
    const order = ["## Executive summary", "## Key findings", "## Brief", "## How this was made"].map((h) => text.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("shows an Arabic translation from a translation slot", () => {
    const arabic = "لدى دبي مجال واسع لعلامة عصير معصور على البارد في الفئة المتوسطة إلى الممتازة.";
    const result = { result: { ...(showcase.result as { result: Record<string, unknown> }).result, "translate-ar": { brief: arabic, summary: arabic, arabic_summary: arabic, language: "ar", llm: "m" } } };
    const withArabic = renderReport({ ...input, goal: showcase.goal, treeId: showcase.tree_id, outcome: { node_id: showcase.tree_id, result_hash: showcase.result_hash, partial: false, children: [], result: result as never } });
    expect(withArabic.match(/^## Arabic summary$/gm)).toHaveLength(1);
    expect(withArabic).toContain(arabic);
    expect(withArabic.match(/^## Brief$/gm)).toHaveLength(1);
  });
});
