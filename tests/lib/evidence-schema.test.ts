import { describe, expect, it } from "vitest";
import { EvidenceResultSchema } from "./evidence-schema.js";

const hash = "99b6e524e77c7a6b45bc827cf63fa1b9b8cdd8ab3c48cc2423cf19f8437ff2b3";
const base = {
  id: "A1",
  title: "Happy path",
  criterion: "c",
  network: "preprod",
  started_at: "2026-10-01T00:00:00.000Z",
  finished_at: "2026-10-01T00:01:00.000Z",
  commit: "0".repeat(40),
  passed: true,
  assertions: [{ name: "a", expected: 1, actual: 1, passed: true }],
  transactions: [{ label: "fund", tx_hash: hash, cardanoscan: `https://preprod.cardanoscan.io/transaction/${hash}` }],
  artefacts: [],
  notes: [],
};

describe("evidence schema", () => {
  it("accepts a consistent passing result", () => {
    expect(EvidenceResultSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a pass with no assertions", () => {
    expect(EvidenceResultSchema.safeParse({ ...base, assertions: [] }).success).toBe(false);
  });

  it("rejects a pass with a failed assertion", () => {
    const assertions = [{ name: "a", expected: 1, actual: 2, passed: false }];
    expect(EvidenceResultSchema.safeParse({ ...base, assertions }).success).toBe(false);
  });

  it("rejects a Cardanoscan link for a different transaction", () => {
    const transactions = [{ ...base.transactions[0], cardanoscan: `https://preprod.cardanoscan.io/transaction/${"1".repeat(64)}` }];
    expect(EvidenceResultSchema.safeParse({ ...base, transactions }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(EvidenceResultSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });
});
