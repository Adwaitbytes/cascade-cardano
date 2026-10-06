import { describe, expect, it } from "vitest";
import { FIXTURE_CLOSED } from "@/lib/fixtures/tree";
import type { Receipt } from "@/lib/api/schemas";
import { reconcile, sumLines } from "./reconcile";

const receipt = FIXTURE_CLOSED.receipt as Receipt;

describe("reconcile", () => {
  it("balances the sample tUSDM tree to the base unit", () => {
    const r = reconcile(receipt);
    expect(r.balanced).toBe(true);
    expect(r.difference).toBe(0n);
    expect(r.structuralInEquation).toBe(false);
    expect(r.structuralLovelace).toBe(14_000_000n);
    expect(r.indexerAgrees).toBe(true);
  });

  it("cross-checks payout lines against the payout total", () => {
    expect(sumLines(receipt, ["fee", "masumi"], receipt.deposits.asset)).toBe(BigInt(receipt.payouts.amount));
  });

  it("detects a one-unit discrepancy and flags an indexer that claims balance", () => {
    const off = { ...receipt, refunds: { ...receipt.refunds, amount: (BigInt(receipt.refunds.amount) - 1n).toString() } };
    const r = reconcile(off);
    expect(r.balanced).toBe(false);
    expect(r.difference).toBe(1n);
    expect(r.indexerAgrees).toBe(false);
  });

  it("includes structural lovelace in the sum for ADA trees", () => {
    const ada = (amount: string) => ({ asset: "lovelace", amount });
    const r = reconcile({ ...receipt, deposits: ada("114000000"), payouts: ada("60000000"), refunds: ada("40000000"), fees: ada("0"), structural_returned_lovelace: "14000000" });
    expect(r.structuralInEquation).toBe(true);
    expect(r.balanced).toBe(true);
  });

  it("rejects mixed assets", () => {
    const r = reconcile({ ...receipt, fees: { asset: "lovelace", amount: "0" } });
    expect(r.balanced).toBe(false);
    expect(r.errors[0]).toMatch(/fees are in lovelace/);
  });
});

describe("structural split", () => {
  it("checks deposited = paid + returned when the indexer reports it", () => {
    const ok = reconcile({ ...receipt, structural_deposited_lovelace: "16000000", structural_paid_lovelace: "2000000", structural_returned_lovelace: "14000000" });
    expect(ok.structural?.balanced).toBe(true);
    expect(ok.balanced).toBe(true);
    const off = reconcile({ ...receipt, structural_deposited_lovelace: "16000001", structural_paid_lovelace: "2000000", structural_returned_lovelace: "14000000" });
    expect(off.structural?.balanced).toBe(false);
    expect(off.balanced).toBe(false);
  });
});
