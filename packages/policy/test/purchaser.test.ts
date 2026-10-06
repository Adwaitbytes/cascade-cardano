import { computePlanRoot, encodeMasumiDatum, type MasumiDatum, type NodeDatum, type NodeSpec, type Plan, type PlutusAddress, type TreeConfig } from "@cascade/shared";
import { describe, expect, it } from "vitest";
import { constrIndex, evaluatePurchaserTx, purchaserReturnDueAt, type PurchaserContext, type PurchaserIo, type PurchaserTx } from "../src/purchaser.js";

const h = (b: string, n: number) => b.repeat(n);
const key = (k: string): PlutusAddress => ({ payment_credential: { type: "VerificationKey", hash: k }, stake_credential: null });
const ADA = 1_000_000n;
const P = h("52", 28);
const OPERATOR = h("22", 28);
const SELLER = h("5e", 28);
const BUYER = h("11", 28);
const MASUMI = h("a1", 28);
const AGENT = `${h("67", 28)}aa`;
const TREE = h("77", 28);
const NOW = 2_000_000_000_000n;
const MIN = 60_000n;

function spec(id: string, extra: Partial<NodeSpec>): NodeSpec {
  return {
    version: "1",
    id,
    task: id,
    category: "masumi",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    acceptance: "AutoAfterWindow",
    rail: "address",
    price: { asset: "lovelace", max_budget: (12n * ADA).toString(), max_fee: "0" },
    deadlines: { work_ms: 60_000, compose_ms: 1_000, challenge_window_ms: 20_000, dispute_window_ms: 20_000 },
    may_sub_hire: false,
    max_sub_budget_share_bps: 0,
    verifier: { deterministic: ["schema"], quorum: null, challenge: false, arbitration: false },
    payee_hash: P,
    ...extra,
  };
}
const root = {
  spec: { ...spec("root", {}), rail: "native", acceptance: "BuyerAccept", payee_hash: undefined, may_sub_hire: true, price: { asset: "lovelace", max_budget: (100n * ADA).toString(), max_fee: (5n * ADA).toString() } } as NodeSpec,
  agents: { primary: { agent_id: `${h("67", 28)}00`, quote_id: null, price: "100000000" }, fallbacks: [] },
  children: [{ spec: spec("lisan", {}), agents: { primary: { agent_id: AGENT, quote_id: null, price: (12n * ADA).toString() }, fallbacks: [] }, children: [] }],
};
const plan = { plan_root: computePlanRoot(root), root } as unknown as Plan;
const config = { buyer_refund: key(BUYER), masumi_script_hash: MASUMI, min_safety_margin: 5n * MIN, asset: { policy: "", name: "" } } as unknown as TreeConfig;
const drawing = { node_id: TREE, operator: OPERATOR, submit_by: NOW + 120n * MIN } as unknown as NodeDatum;

function datum(over: Partial<MasumiDatum> = {}): string {
  return encodeMasumiDatum({
    buyer: key(P),
    buyer_return_address: key(BUYER),
    seller: key(SELLER),
    seller_return_address: null,
    reference_key: "a10101",
    reference_signature: h("55", 16),
    seller_nonce: h("33", 32),
    buyer_nonce: "",
    agent_identifier: AGENT,
    collateral_return_lovelace: 0n,
    input_hash: h("44", 32),
    result_hash: "",
    pay_by_time: NOW + 10n * MIN,
    submit_result_time: NOW + 30n * MIN,
    unlock_time: NOW + 50n * MIN,
    external_dispute_unlock_time: NOW + 70n * MIN,
    seller_cooldown_time: 0n,
    buyer_cooldown_time: 0n,
    state: "FundsLocked",
    ...over,
  });
}

const RECEIVED = `${h("d1", 32)}#2`;
const OWN = `${h("e1", 32)}#0`;
const io = (o: Partial<PurchaserIo>): PurchaserIo => ({ address: "addr_test1x", paymentKeyHash: null, scriptHash: null, lovelace: 0n, assets: {}, datum: null, ...o });

function lockTx(over: { lock?: Partial<PurchaserIo>; extra?: PurchaserIo[]; change?: bigint } = {}): PurchaserTx {
  return {
    bodyHash: h("ab", 32),
    inputs: [
      { ...io({ paymentKeyHash: P, lovelace: 12n * ADA }), outRef: RECEIVED },
      { ...io({ paymentKeyHash: P, lovelace: 5n * ADA }), outRef: OWN },
    ],
    unresolvedInputs: 0,
    outputs: [io({ scriptHash: MASUMI, lovelace: 12n * ADA, datum: datum(), ...over.lock }), io({ paymentKeyHash: P, lovelace: over.change ?? 4_800_000n }), ...(over.extra ?? [])],
    redeemers: [],
    mints: false,
    withdrawals: 0,
    certificates: 0,
    fee: 200_000n,
  };
}

function ctx(tx: PurchaserTx, over: Partial<PurchaserContext> = {}): PurchaserContext {
  return {
    tx,
    purchaserKeyHash: P,
    received: new Map([[RECEIVED, { treeId: TREE, drawingNode: drawing, drawnAt: NOW - 30n * MIN, failed: false }]]),
    trees: new Map([[TREE, { config, plan }]]),
    approvedLocks: new Map([[h("ab", 32), TREE]]),
    agentKeys: () => [SELLER],
    now: NOW,
    ...over,
  };
}
const failed = (r: ReturnType<typeof evaluatePurchaserTx>) => r.gates.filter((g) => !g.passed).map((g) => g.name);

describe("masumi-purchaser lock (ADR 8.1 a)", () => {
  it("allows a lock of exactly the received amount matching the approved Masumi spec", () => {
    const r = evaluatePurchaserTx(ctx(lockTx()));
    expect(r.decision).toBe("allow");
    expect(r.treeId).toBe(TREE);
  });

  it("refuses a lock whose value differs from what P received", () => {
    expect(failed(evaluatePurchaserTx(ctx(lockTx({ lock: { lovelace: 11n * ADA }, change: 5_800_000n }))))).toContain("lock-value");
  });

  it("refuses a lock whose refunds do not go to the tree's buyer_refund", () => {
    expect(failed(evaluatePurchaserTx(ctx(lockTx({ lock: { datum: datum({ buyer_return_address: key(P) }) } }))))).toEqual(["datum"]);
  });

  it("refuses any extra output, an unapproved seller and a pay_by_time already past", () => {
    expect(failed(evaluatePurchaserTx(ctx(lockTx({ extra: [io({ paymentKeyHash: OPERATOR, lovelace: ADA })], change: 3_800_000n }))))).toEqual(["lock-shape"]);
    expect(failed(evaluatePurchaserTx(ctx(lockTx({ lock: { datum: datum({ agent_identifier: `${h("67", 28)}bb` }) } }))))).toEqual(["plan-spec"]);
    expect(failed(evaluatePurchaserTx(ctx(lockTx({ lock: { datum: datum({ pay_by_time: NOW - MIN }) } }))))).toEqual(["deadlines"]);
  });

  it("allows the fixed Masumi template deadlines beyond the drawing node's window (DECISIONS 2026-10-02)", () => {
    const HOUR = 60n * MIN;
    const template = datum({ pay_by_time: NOW + 10n * MIN, submit_result_time: NOW + 24n * HOUR, unlock_time: NOW + 30n * HOUR, external_dispute_unlock_time: NOW + 36n * HOUR });
    expect(drawing.submit_by < NOW + 36n * HOUR).toBe(true);
    expect(evaluatePurchaserTx(ctx(lockTx({ lock: { datum: template } }))).decision).toBe("allow");
  });

  it("refuses a lock funded by anything but a received AddressPayment", () => {
    expect(failed(evaluatePurchaserTx(ctx(lockTx(), { received: new Map() })))).toContain("received-funds");
  });
});

describe("masumi-purchaser refunds (ADR 8.1 b)", () => {
  const LOCK = `${h("ab", 32)}#0`;
  const lockIn = { ...io({ scriptHash: MASUMI, lovelace: 12n * ADA, datum: datum({ state: "ResultSubmitted" }) }), outRef: LOCK };
  const fees = { ...io({ paymentKeyHash: P, lovelace: 5n * ADA }), outRef: OWN };
  function refundTx(redeemer: string, outputs: PurchaserIo[]): PurchaserTx {
    const inputs = [lockIn, fees].sort((a, b) => (a.outRef < b.outRef ? -1 : 1));
    return { bodyHash: h("cd", 32), inputs, unresolvedInputs: 0, outputs, redeemers: [{ purpose: "spend", index: inputs.indexOf(lockIn), data: redeemer }], mints: false, withdrawals: 0, certificates: 0, fee: 300_000n };
  }

  it("allows SetRefundRequested that keeps the lock, and WithdrawRefund to buyer_refund", () => {
    const set = refundTx("d87a80", [io({ scriptHash: MASUMI, lovelace: 12n * ADA, datum: datum({ state: "RefundRequested" }) }), io({ paymentKeyHash: P, lovelace: 4_700_000n })]);
    expect(evaluatePurchaserTx(ctx(set)).decision).toBe("allow");
    const withdraw = refundTx("d87c80", [io({ paymentKeyHash: BUYER, lovelace: 12n * ADA }), io({ paymentKeyHash: P, lovelace: 4_700_000n })]);
    expect(evaluatePurchaserTx(ctx(withdraw)).decision).toBe("allow");
  });

  it("refuses a refund paid anywhere but buyer_refund, other redeemers, and unknown locks", () => {
    const toP = refundTx("d87c80", [io({ paymentKeyHash: P, lovelace: 16_700_000n })]);
    expect(failed(evaluatePurchaserTx(ctx(toP)))).toContain("refund-outputs");
    const withdraw = refundTx("d87980", [io({ paymentKeyHash: BUYER, lovelace: 12n * ADA })]);
    expect(failed(evaluatePurchaserTx(ctx(withdraw)))).toContain("refund-shape");
    const unknown = refundTx("d87c80", [io({ paymentKeyHash: BUYER, lovelace: 12n * ADA })]);
    expect(failed(evaluatePurchaserTx(ctx(unknown, { approvedLocks: new Map() })))).toContain("refund-shape");
  });

  it("reads Plutus constructor indices", () => {
    expect([constrIndex("d87980"), constrIndex("d87a80"), constrIndex("d87c80"), constrIndex("00")]).toEqual([0, 1, 3, null]);
  });
});

describe("masumi-purchaser return of unlocked funds (ADR 8.1 exit)", () => {
  // The leaf's work window is 60 s and the tree's safety margin 5 min, so the return opens 6 min after the Draw.
  function returnTx(outputs: PurchaserIo[], fee = 200_000n): PurchaserTx {
    return {
      bodyHash: h("ef", 32),
      inputs: [
        { ...io({ paymentKeyHash: P, lovelace: 12n * ADA }), outRef: RECEIVED },
        { ...io({ paymentKeyHash: P, lovelace: 5n * ADA }), outRef: OWN },
      ],
      unresolvedInputs: 0,
      outputs,
      redeemers: [],
      mints: false,
      withdrawals: 0,
      certificates: 0,
      fee,
    };
  }
  const back = io({ paymentKeyHash: BUYER, lovelace: 12n * ADA });
  const change = io({ paymentKeyHash: P, lovelace: 4_800_000n });
  const drawnAt = (ms: bigint, failed = false): Partial<PurchaserContext> => ({ received: new Map([[RECEIVED, { treeId: TREE, drawingNode: drawing, drawnAt: ms, failed }]]) });

  it("returns the full amount to buyer_refund after the work window plus margin", () => {
    expect(purchaserReturnDueAt({ drawnAt: NOW - 30n * MIN, plan, config, purchaserKeyHash: P })).toBe(NOW - 30n * MIN + 60_000n + 5n * MIN);
    const r = evaluatePurchaserTx(ctx(returnTx([back, change])));
    expect(r.gates.filter((g) => !g.passed)).toEqual([]);
    expect(r.decision).toBe("allow");
    expect(r.treeId).toBe(TREE);
  });

  it("refuses before the timeout, unless the slot is marked failed", () => {
    expect(failed(evaluatePurchaserTx(ctx(returnTx([back, change]), drawnAt(NOW - MIN))))).toEqual(["return-timing"]);
    expect(evaluatePurchaserTx(ctx(returnTx([back, change]), drawnAt(NOW - MIN, true))).decision).toBe("allow");
    expect(failed(evaluatePurchaserTx(ctx(returnTx([back, change]), drawnAt(null as unknown as bigint))))).toEqual(["return-timing"]);
  });

  it("refuses a partial return, a return elsewhere, extra outputs and change from the received funds", () => {
    expect(failed(evaluatePurchaserTx(ctx(returnTx([io({ paymentKeyHash: BUYER, lovelace: 11n * ADA }), io({ paymentKeyHash: P, lovelace: 5_800_000n })]))))).toEqual(["return-outputs"]);
    expect(failed(evaluatePurchaserTx(ctx(returnTx([io({ paymentKeyHash: OPERATOR, lovelace: 12n * ADA }), change]))))).toEqual(["return-outputs"]);
    expect(failed(evaluatePurchaserTx(ctx(returnTx([back, io({ paymentKeyHash: SELLER, lovelace: ADA }), io({ paymentKeyHash: P, lovelace: 3_800_000n })]))))).toEqual(["return-outputs"]);
    expect(failed(evaluatePurchaserTx(ctx(returnTx([io({ paymentKeyHash: P, lovelace: 16_800_000n })]))))).toEqual(["return-outputs"]);
  });

  it("refuses funds that were not received from a Draw", () => {
    expect(failed(evaluatePurchaserTx(ctx(returnTx([back, change]), { received: new Map() })))).toContain("return-shape");
  });
});
