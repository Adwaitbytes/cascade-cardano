/**
 * Golden examples of the Task result: the formatter's full Markdown for three real-shaped trees,
 * snapshotted to files under test/__golden__ so a reviewer reads exactly what Sokosumi shows.
 * Shapes follow the indexer's tree and receipt views and the Conductor's composed root outcome.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RootOutcome, TreeReceipt, TreeView } from "../src/cascade.js";
import { interpretTask } from "../src/intake.js";
import { renderReport, type ReportInput } from "../src/report.js";

const hex = (label: string, bytes: number) => createHash("sha256").update(label).digest("hex").repeat(2).slice(0, bytes * 2);
const node = (label: string) => hex(`node:${label}`, 28);
const tx = (label: string) => hex(`tx:${label}`, 32);
const ada = (n: number) => String(Math.round(n * 1_000_000));
const SITE = "https://cascade-alpha-amber.vercel.app";

type Line = TreeReceipt["lines"][number];
const fee = (nodeId: string, amount: number, txLabel: string): Line => ({ node_id: nodeId, kind: "fee", to: "addr_test1qpayee", value: { asset: "lovelace", amount: ada(amount) }, tx_id: tx(txLabel) });
const refund = (nodeId: string, amount: number, txLabel: string): Line => ({ node_id: nodeId, kind: "refund", to: "addr_test1qbuyer", value: { asset: "lovelace", amount: ada(amount) }, tx_id: tx(txLabel) });
const treeNode = (id: string, parent: string | null, depth: number, name: string, state: string, budget: number, feeAda: number, txs: string[]): TreeView["nodes"][number] => ({
  node_id: id,
  parent_id: parent,
  depth,
  kind: "Native",
  agent_name: name,
  state,
  budget: ada(budget),
  fee: ada(feeAda),
  tx_ids: txs.map(tx),
});
const verdict = (checked: string, word: "accept" | "reject", score: number, checker: string) => ({
  verdict: { tree_id: node("root"), node_id: checked, result_hash: hex(`result:${checked}`, 32), verdict: word, score, checks: [], evidence_hash: hex(`evidence:${checker}`, 32), verifier: checker },
  reasons: word === "accept" ? ["Claims match the cited pages", "Schema and result hash verified"] : ["Two findings cite pages that do not support them"],
  llm: "nvidia/nemotron-3-super",
});

describe("golden Task results", () => {
  it("market-entry brief: Scout with Pricer, three checkers, Scribe, a failed test translator and a Masumi contingency", async () => {
    const root = node("root");
    const [scout, pricer, a, b, c, scribe, flaky] = ["scout", "pricer", "check-a", "check-b", "check-c", "scribe", "translate-ar"].map(node) as [string, string, string, string, string, string, string];
    const intake = interpretTask("Dubai juice", "We are thinking about launching a cold-pressed juice brand in Dubai. What does the market look like and what should we charge?", { budgetCapLovelace: ada(80), treeWindowMs: 190 * 60_000 });
    if (!intake.ok) throw new Error("intake refused the golden request");
    const outcome: RootOutcome = {
      node_id: root,
      result_hash: hex("root-result", 32),
      partial: false,
      children: [
        { status: "accepted", spec_id: "scout", hire: { agent_id: "scout", node_id: scout } },
        { status: "accepted", spec_id: "check-a", hire: { agent_id: "checker-a", node_id: a } },
        { status: "accepted", spec_id: "check-b", hire: { agent_id: "checker-b", node_id: b } },
        { status: "accepted", spec_id: "check-c", hire: { agent_id: "checker-c", node_id: c } },
        { status: "accepted", spec_id: "scribe", hire: { agent_id: "scribe", node_id: scribe } },
        { status: "partial", spec_id: "translate-ar", actions: ["no result by submit_by; refunded"] },
        { status: "accepted", spec_id: "translate-ar-masumi", hire: { agent_id: "lisan", node_id: "", masumi: { lock_tx: tx("masumi-lock"), blockchain_identifier: "lisan-purchase-01" } } },
      ],
      result: {
        result: {
          scout: {
            competitors: [
              { brand: "Pressed Juicery Dubai", positioning: "Premium cold-pressed, mall kiosks and delivery apps" },
              { brand: "Super Juice", positioning: "Mid-price blends sold through gyms and cafes" },
              { brand: "Detox Delight", positioning: "Juice cleanse programmes with home delivery" },
            ],
            price_table: [
              { brand: "Pressed Juicery Dubai", product: "Greens 1", size_ml: 350, avg_price_aed: 29.5, days: 42, sample: true },
              { brand: "Super Juice", product: "Green Machine", size_ml: 300, avg_price_aed: 22, days: 42, sample: true },
              { brand: "Detox Delight", product: "Day cleanse (6 bottles)", size_ml: 1500, avg_price_aed: 185, days: 42, sample: true },
            ],
            findings: [
              { claim: "The UAE functional beverage market is forecast to grow about 7% a year to 2029.", source_url: "https://www.mordorintelligence.com/industry-reports/uae-functional-beverage-market" },
              { claim: "Dubai food establishments must register products with Dubai Municipality before sale.", source_url: "https://www.dm.gov.ae/business/food-safety/" },
              { claim: "Delivery apps carry a large share of premium juice orders in Dubai.", source_url: "estimate based on competitor channel mix" },
            ],
            notes: ["sub-hired 1 children under node 5c1f…"],
            llm: "nvidia/nemotron-3-super",
          },
          "check-a": verdict(scout, "accept", 0.92, "checker-a"),
          "check-b": verdict(scout, "accept", 0.88, "checker-b"),
          "check-c": verdict(scout, "reject", 0.41, "checker-c"),
          scribe: {
            brief: [
              "# Market-entry brief: cold-pressed juice in Dubai",
              "## Recommendation",
              "Launch at 24 to 26 AED per 300 ml bottle, between Super Juice and Pressed Juicery, through gyms first and delivery apps second.",
              "## Competitors",
              "- Pressed Juicery Dubai: premium, malls and delivery",
              "- Super Juice: mid-price, gyms and cafes",
              "- Detox Delight: cleanse programmes",
              "## Risks",
              "- Product registration with Dubai Municipality takes weeks (https://www.dm.gov.ae/business/food-safety/).",
              "- Prices in this brief come from sample lookup data and need a store check.",
            ].join("\n"),
            summary: "Dubai has room for a mid-premium cold-pressed brand. Price at 24 to 26 AED per 300 ml, sell through gyms first, and register products with Dubai Municipality before launch. Competitor prices here are sample data; confirm them in store.",
            llm: "nvidia/nemotron-3-super",
          },
          "translate-ar-masumi": { result: "لدى دبي مجال لعلامة عصير معصور على البارد في الفئة المتوسطة إلى الممتازة." },
        },
        children: ["scout", "check-a", "check-b", "check-c", "scribe", "translate-ar-masumi"],
        partial: false,
      },
    };
    const tree: TreeView = {
      tree_id: root,
      asset: "lovelace",
      root_budget: ada(80),
      state: "open",
      nodes: [
        treeNode(root, null, 0, "Conductor", "Accepted", 80, 8, ["fund", "root-accept"]),
        treeNode(scout, root, 1, "Scout", "Settled", 22, 10, ["draw-scout", "settle-scout"]),
        treeNode(pricer, scout, 2, "Pricer", "Settled", 9, 3, ["draw-pricer", "settle-pricer"]),
        treeNode(a, root, 1, "Cascade Checker A", "Settled", 1.5, 1, ["settle-a"]),
        treeNode(b, root, 1, "Cascade Checker B", "Settled", 1.5, 1, ["settle-b"]),
        treeNode(c, root, 1, "Cascade Checker C", "Settled", 1.5, 1, ["settle-c"]),
        treeNode(scribe, root, 1, "Scribe", "Settled", 8, 5, ["settle-scribe"]),
        treeNode(flaky, root, 1, "Flaky Lisan (test agent)", "Refunded", 4, 0, ["draw-flaky", "refund-flaky"]),
      ],
    };
    const receipt: TreeReceipt = {
      tree_id: root,
      deposits: { asset: "lovelace", amount: ada(80) },
      payouts: { asset: "lovelace", amount: ada(30) },
      refunds: { asset: "lovelace", amount: ada(46) },
      balanced: true,
      lines: [
        { node_id: root, kind: "deposit", to: "tree", value: { asset: "lovelace", amount: ada(80) }, tx_id: tx("fund") },
        fee(scout, 10, "settle-scout"),
        fee(pricer, 3, "settle-pricer"),
        fee(a, 1, "settle-a"),
        fee(b, 1, "settle-b"),
        fee(c, 1, "settle-c"),
        fee(scribe, 5, "settle-scribe"),
        fee(root, 8, "root-accept"),
        refund(flaky, 4, "refund-flaky"),
        refund(root, 42, "root-close"),
      ],
    };
    const input: ReportInput = { goal: "We are thinking about launching a cold-pressed juice brand in Dubai. What does the market look like and what should we charge?", title: intake.title, treeId: root, outcome, tree, receipt, fundTx: tx("fund"), acceptTx: tx("root-accept"), site: SITE, masumi: { blockchainIdentifier: hex("task-masumi", 40), lockTx: tx("task-lock") } };
    await expect(renderReport(input)).toMatchFileSnapshot("__golden__/market-brief.md");
  });

  it("price comparison: Scout and Pricer only, no brief, native agents on a short window", async () => {
    const root = node("prices-root");
    const scout = node("prices-scout");
    const pricer = node("prices-pricer");
    const intake = interpretTask("Price check", "Quick price comparison of oat milk brands in Dubai supermarkets, urgent", { budgetCapLovelace: ada(80), treeWindowMs: 190 * 60_000 });
    if (!intake.ok) throw new Error("intake refused the golden request");
    expect(intake).toMatchObject({ kind: "price-table", nativeOnly: true, maxDepth: 2, budgetLovelace: ada(60) });
    const outcome: RootOutcome = {
      node_id: root,
      result_hash: hex("prices-result", 32),
      partial: false,
      children: [{ status: "accepted", spec_id: "scout", hire: { agent_id: "scout", node_id: scout } }],
      result: {
        result: {
          scout: {
            competitors: [
              { brand: "Oatly", positioning: "Category leader, barista and original lines" },
              { brand: "Alpro", positioning: "Broad plant-based range, frequent promotions" },
            ],
            price_table: [
              { brand: "Oatly", product: "Oat Drink Barista", size_ml: 1000, price_aed: 18.75, source_url: "https://www.carrefouruae.com/mafuae/en/plant-based-milk/oatly-barista" },
              { brand: "Alpro", product: "Oat No Sugars", size_ml: 1000, price_aed: 15.5, source_url: "https://www.spinneys.com/en-ae/alpro-oat-no-sugars" },
              { brand: "Koita", product: "Oat Milk", size_ml: 1000, price_aed: 12.95, source_url: "estimate" },
            ],
            findings: [{ claim: "Oatly's barista line is the most widely stocked oat milk in Dubai supermarkets.", source_url: "https://www.carrefouruae.com/mafuae/en/plant-based-milk" }],
            notes: [],
            llm: "nvidia/nemotron-3-super",
          },
        },
        children: ["scout"],
        partial: false,
      },
    };
    const tree: TreeView = {
      tree_id: root,
      asset: "lovelace",
      root_budget: ada(60),
      state: "closed",
      nodes: [treeNode(root, null, 0, "Conductor", "Closed", 60, 6, ["p-fund", "p-accept"]), treeNode(scout, root, 1, "Scout", "Settled", 20, 10, ["p-scout"]), treeNode(pricer, scout, 2, "Pricer", "Settled", 6, 3, ["p-pricer"])],
    };
    const receipt: TreeReceipt = {
      tree_id: root,
      deposits: { asset: "lovelace", amount: ada(60) },
      payouts: { asset: "lovelace", amount: ada(19) },
      refunds: { asset: "lovelace", amount: ada(41) },
      balanced: true,
      lines: [fee(scout, 10, "p-scout"), fee(pricer, 3, "p-pricer"), fee(root, 6, "p-accept"), refund(root, 41, "p-close")],
    };
    await expect(renderReport({ goal: "Quick price comparison of oat milk brands in Dubai supermarkets, urgent", title: intake.title, treeId: root, outcome, tree, receipt, fundTx: tx("p-fund"), acceptTx: tx("p-accept"), site: SITE, masumi: null })).toMatchFileSnapshot("__golden__/price-comparison.md");
  });

  it("deadline reached: no deliverable yet, every amount accounted for", async () => {
    const root = node("late-root");
    const research = node("late-research");
    const tree: TreeView = {
      tree_id: root,
      asset: "lovelace",
      root_budget: ada(80),
      state: "open",
      nodes: [treeNode(root, null, 0, "Conductor", "Funded", 80, 8, ["l-fund"]), treeNode(research, root, 1, "Scout", "Refunded", 30, 10, ["l-draw", "l-refund"])],
    };
    const receipt: TreeReceipt = {
      tree_id: root,
      deposits: { asset: "lovelace", amount: ada(80) },
      payouts: { asset: "lovelace", amount: "0" },
      refunds: { asset: "lovelace", amount: ada(30) },
      balanced: false,
      lines: [refund(research, 30, "l-refund")],
    };
    await expect(
      renderReport({
        goal: "Summarise the EU AI Act obligations for a small SaaS company",
        title: "Summary: EU AI Act obligations for a small SaaS company",
        treeId: root,
        outcome: null,
        tree,
        receipt,
        fundTx: tx("l-fund"),
        acceptTx: null,
        site: SITE,
        masumi: { blockchainIdentifier: hex("late-masumi", 40), lockTx: tx("late-lock") },
        failure: "The agent team had not delivered by this Task's result deadline. What it did so far, and every refund, is on chain at the links below.",
      }),
    ).toMatchFileSnapshot("__golden__/deadline-reached.md");
  });
});
