import { describe, expect, it } from "vitest";
import type { Receipt, Tree } from "@/lib/api/schemas";
import { reconcile } from "./reconcile";
import { splitPayouts } from "./split";

const ROOT = "45".repeat(28);
const MASUMI = "9e".repeat(28);
const SCOUT = "78".repeat(28);
const ada = (amount: string) => ({ asset: "lovelace", amount });
const line = (kind: Receipt["lines"][number]["kind"], node_id: string, to: string, amount: string) => ({ kind, node_id, to, value: ada(amount), tx_id: "ab".repeat(32) });

// Shape of preprod tree 458310f2: a Masumi hire sends 1.43523 ADA of min-ADA into escrow.
const receipt = {
  tree_id: ROOT,
  deposits: ada("42331630"),
  payouts: ada("7935230"),
  refunds: ada("14500000"),
  fees: ada("0"),
  structural_deposited_lovelace: "21331630",
  structural_paid_lovelace: "1435230",
  structural_returned_lovelace: "19896400",
  balanced: true,
  lines: [
    line("fee", SCOUT, "addr", "1000000"),
    line("fee", MASUMI, "masumi:x", "3000000"),
    line("structural", MASUMI, "escrow:x", "1435230"),
    line("fee", ROOT, "addr", "2500000"),
    line("structural", ROOT, "addr", "19896400"),
  ],
  key: "k",
  signature: "s",
} as unknown as Receipt;

const tree = {
  tree_id: ROOT,
  nodes: [
    { node_id: ROOT, agent_asset_id: "conductor" },
    { node_id: SCOUT, agent_asset_id: "scout" },
    { node_id: MASUMI, agent_asset_id: "conductor" },
  ],
} as unknown as Tree;

describe("splitPayouts", () => {
  it("separates escrow min-ADA from agent pay so the rows add up", () => {
    const rec = reconcile(receipt);
    const paid = new Map([[SCOUT, 1_000_000n], [MASUMI, 3_000_000n], [ROOT, 2_500_000n]]);
    const s = splitPayouts(receipt, rec, tree, paid);
    expect(s.toAgents).toBe(6_500_000n);
    expect(s.toEscrow).toBe(1_435_230n);
    expect(s.toAgents + s.toEscrow + rec.refunds + rec.fees + rec.structuralLovelace).toBe(rec.deposits);
    expect(s.structuralByNode.get(MASUMI)).toBe(1_435_230n);
    expect(s.structuralByNode.has(ROOT)).toBe(false);
  });

  it("counts distinct agents with a payout, not nodes", () => {
    const rec = reconcile(receipt);
    const paid = new Map([[SCOUT, 1_000_000n], [MASUMI, 3_000_000n], [ROOT, 2_500_000n]]);
    expect(splitPayouts(receipt, rec, tree, paid).agents).toBe(2);
    expect(splitPayouts(receipt, rec, tree, new Map([[SCOUT, 0n]])).agents).toBe(0);
  });
});
