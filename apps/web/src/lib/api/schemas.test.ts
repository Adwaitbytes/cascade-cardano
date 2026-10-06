import { describe, expect, it } from "vitest";
import { FIXTURE_CLOSED } from "@/lib/fixtures/tree";
import { NodeDetailSchema, ReceiptSchema } from "./schemas";

describe("Masumi receipt lines and leaves (ADR 0001 8.1)", () => {
  const receipt = FIXTURE_CLOSED.receipt;
  it("parses a masumi line with its lock, identifier and outcome", () => {
    const parsed = ReceiptSchema.parse(receipt);
    const line = parsed.lines.find((l) => l.kind === "masumi");
    expect(line?.lock_tx).toMatch(/^[0-9a-f]{64}$/);
    expect(line?.outcome).toBe("withdrawn");
    expect(line?.blockchain_identifier?.length).toBeGreaterThan(0);
  });
  it("rejects an unknown outcome or a malformed lock tx", () => {
    const bad = (patch: Record<string, unknown>) => ({ ...receipt, lines: receipt?.lines.map((l) => (l.kind === "masumi" ? { ...l, ...patch } : l)) });
    expect(ReceiptSchema.safeParse(bad({ outcome: "paid" })).success).toBe(false);
    expect(ReceiptSchema.safeParse(bad({ lock_tx: "xyz" })).success).toBe(false);
  });
  it("defaults masumi_leaves to empty for indexers that predate it", () => {
    const detail = [...FIXTURE_CLOSED.details.values()][0];
    const { masumi_leaves: _omit, ...older } = detail ?? ({} as Record<string, unknown>);
    expect(NodeDetailSchema.parse(older).masumi_leaves).toEqual([]);
  });
});
