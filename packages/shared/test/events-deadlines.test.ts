import { describe, expect, it } from "vitest";
import {
  deadlinesFrom,
  masumiDeadlineErrors,
  masumiDeadlinesFrom,
  masumiMinimumWindow,
  MINUTE_MS,
  minimumRootWindow,
  nestingErrors,
  nodeDeadlineErrors,
  nodeWindow,
} from "../src/deadlines.js";
import { planWindows } from "../src/plan.js";
import { ASSET, node, samplePlan, spec } from "./plan-fixture.js";
import { CascadeEventSchema, EVENT_TYPES } from "../src/events.js";

describe("events (PRD 17.3)", () => {
  const base = {
    event_id: "1",
    tree_id: "77".repeat(28),
    node_id: "88".repeat(28),
    tx_id: "aa".repeat(32),
    slot: 123,
    confirmations: 2,
    value: { asset: "lovelace", amount: "1500000" },
    emitted_at: 1_785_700_000_000,
  };
  const payloads: Record<(typeof EVENT_TYPES)[number], object> = {
    "tree.funded": { plan_root: "bb".repeat(32), config_utxo: `${"aa".repeat(32)}#1` },
    "node.drawn": { parent_id: "77".repeat(28), kind: "Native", spec_hash: "cc".repeat(32) },
    "node.working": {},
    "node.input_requested": { input_schema_hash: "dd".repeat(32) },
    "node.submitted": { result_hash: "ee".repeat(32) },
    "node.verified": { verdict: "accept", verifier: "67ab", evidence_hash: "ff".repeat(32) },
    "node.challenged": { reason_hash: "11".repeat(32), challenger: "22".repeat(28), bond_lovelace: "5000000" },
    "node.resolved": { worker: "1", parent: "2" },
    "node.accepted": {},
    "node.refunded": {},
    "node.settled": { fee_paid: "1000000", returned_to_parent: "0" },
    "receipt.closed": { external_ref: `${"aa".repeat(32)}#0` },
    "tree.frozen": { frozen: true },
    "tree.closed": { paid: "1", refunded: "2", structural_returned_lovelace: "3" },
    "chain.rollback": { rollback_to_slot: 100, undone_event_ids: ["1"] },
  };

  it("parses every event type with the common fields", () => {
    for (const type of EVENT_TYPES) {
      const e = { type, ...base, payload: payloads[type] };
      expect(CascadeEventSchema.parse(e)).toEqual(e);
    }
    expect(EVENT_TYPES).toHaveLength(15);
  });

  it("rejects numeric amounts, unknown fields and missing common fields", () => {
    expect(() => CascadeEventSchema.parse({ type: "node.accepted", ...base, value: { asset: "lovelace", amount: 5 }, payload: {} })).toThrow();
    expect(() => CascadeEventSchema.parse({ type: "node.accepted", ...base, payload: { x: 1 } })).toThrow();
    const { slot: _slot, ...noSlot } = base;
    expect(() => CascadeEventSchema.parse({ type: "node.accepted", ...noSlot, payload: {} })).toThrow();
  });
});

describe("deadline algebra", () => {
  const timing = { work_ms: 20n * MINUTE_MS, compose_ms: 5n * MINUTE_MS, challenge_window_ms: 10n * MINUTE_MS, dispute_window_ms: 10n * MINUTE_MS };

  it("ADR 4.3 node rules", () => {
    const d = { submit_by: 100n, challenge_until: 200n, refund_after: 100n, dispute_until: 201n };
    expect(nodeDeadlineErrors(d, 100n)).toEqual([]);
    expect(nodeDeadlineErrors({ ...d, challenge_until: 199n }, 100n)).toHaveLength(1);
    expect(nodeDeadlineErrors({ ...d, dispute_until: 200n }, 100n)).toHaveLength(1);
    expect(nodeDeadlineErrors({ ...d, refund_after: 99n }, 100n)).toHaveLength(1);
  });

  it("child nesting with safety margin and compose time", () => {
    expect(nestingErrors({ dispute_until: 100n }, { submit_by: 110n }, 10n)).toEqual([]);
    expect(nestingErrors({ dispute_until: 100n }, { submit_by: 110n }, 10n, 1n)).toHaveLength(1);
  });

  it("Masumi minimums: 5 / 15 / 15 minutes and the issuance rules", () => {
    expect(masumiMinimumWindow(20n * MINUTE_MS)).toBe(55n * MINUTE_MS);
    expect(masumiMinimumWindow(0n)).toBe(45n * MINUTE_MS);
    const m = masumiDeadlinesFrom(1_000_000n, 20n * MINUTE_MS);
    expect(masumiDeadlineErrors(m)).toEqual([]);
    expect(masumiDeadlineErrors(m, { now: 999_000n, maxTimeoutMs: 600_000n })).toEqual([]);
    expect(masumiDeadlineErrors({ ...m, submitResultTime: m.payByTime + 4n * MINUTE_MS })).not.toEqual([]);
    expect(masumiDeadlineErrors(m, { now: 2_000_000n })).toContain("payByTime must be in the future");
  });

  it("minimum root window grows with depth and nests exactly", () => {
    const p = { timing, leaf_rail: "native" as const, min_safety_margin: 5n * MINUTE_MS };
    const w0 = minimumRootWindow(0, p);
    const w1 = minimumRootWindow(1, p);
    const w2 = minimumRootWindow(2, p);
    expect(w0).toEqual({ submit_offset: 20n * MINUTE_MS, total: 40n * MINUTE_MS });
    expect(w1.submit_offset).toBe(timing.work_ms + w0.total + p.min_safety_margin + timing.compose_ms);
    expect(w2.total > w1.total).toBe(true);
    const child = deadlinesFrom(0n, w0, timing);
    const parent = deadlinesFrom(0n, w1, timing);
    expect(nestingErrors(child, parent, p.min_safety_margin, 0n)).toEqual([]);
    expect(nodeDeadlineErrors(parent, timing.challenge_window_ms)).toEqual([]);
    const masumi = minimumRootWindow(1, { ...p, leaf_rail: "masumi" });
    expect(masumi.submit_offset).toBe(timing.work_ms + 55n * MINUTE_MS + p.min_safety_margin + timing.compose_ms);
  });
});

describe("address leaves with masumi_followup (ADR 8.1)", () => {
  const timing = { work_ms: 3_600_000n, compose_ms: 0n, challenge_window_ms: 60_000n, dispute_window_ms: 60_000n };
  it("a plain address payment is final at Draw and holds no window", () => {
    expect(nodeWindow("address", timing, [], 60_000n)).toEqual({ submit_offset: 0n, total: 0n });
  });
  it("a Masumi purchase through P holds the parent for its work_ms, the wait for the seller", () => {
    expect(nodeWindow("address", timing, [], 60_000n, { masumiFollowup: true })).toEqual({ submit_offset: 3_600_000n, total: 3_600_000n });
  });
  it("planWindows gives the parent of a masumi_followup leaf room for the seller's work", () => {
    const plan = samplePlan();
    const child = spec("buy", { rail: "address", acceptance: "AutoAfterWindow", payee_hash: "52".repeat(28), price: { asset: ASSET, max_budget: "1000000", max_fee: "0" }, deadlines: { work_ms: 7_200_000, compose_ms: 0, challenge_window_ms: 600_000, dispute_window_ms: 600_000 } });
    const plain = { ...plan, root: { ...plan.root, children: [node(child)] } };
    const followed = { ...plan, root: { ...plan.root, children: [node({ ...child, masumi_followup: { agent_identifier: "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b10" } })] } };
    const rootOffset = (p: typeof plan) => planWindows(p).get(p.root.spec.id)?.submit_offset ?? -1n;
    expect(rootOffset(followed) - rootOffset(plain)).toBe(7_200_000n);
  });
});
