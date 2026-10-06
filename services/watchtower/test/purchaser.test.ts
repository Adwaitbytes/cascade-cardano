/**
 * Purchase-wallet cranks (ADR 0001 8.1): a failed Masumi leaf refunds the buyer without the operator.
 * Selection is pure; the state comes from the indexer's tables exactly as the indexer stores P's
 * payments and locks, and the return time is the signer fence's own `purchaserReturnDueAt`.
 */
import { purchaserReturnDueAt } from "@cascade/policy";
import { PlanSchema, computePlanRoot, encodeTreeConfig, type NodeSpec } from "@cascade/shared";
import { createTestDatabase, treeConfig, type TestDatabase } from "@cascade/service-kit/testing";
import { toWire } from "@cascade/service-kit";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purchaserState, tick } from "../src/loop.js";
import { selectPurchaserCranks, type Crank, type CrankExecutor, type PurchaserLock, type PurchaserPayment } from "../src/selection.js";

const T = 2_000_000_000_000n;
const G = 30_000n;
const P = "52".repeat(28);
const TREE = "77".repeat(28);
const ref = (b: string) => `${b.repeat(32)}#1`;
const select = { now: T, graceMs: G };

const payment = (over: Partial<PurchaserPayment> = {}): PurchaserPayment => ({ outRef: ref("d1"), drawTx: "d1".repeat(32), treeId: TREE, nodeId: TREE, returnDueAt: T - 60_000n, failed: false, ...over });
const lock = (over: Partial<PurchaserLock> = {}): PurchaserLock => ({
  outRef: ref("e1"),
  treeId: TREE,
  nodeId: TREE,
  escrowAddress: "addr_test1wzs4e6wc9ktk0y6sp36s9w5v0e9pyt3d26pp3mx23ce6l4qwu6j6y",
  referenceSignature: "55".repeat(16),
  state: "FundsLocked",
  resultHash: "",
  submitResultTime: T - 60_000n,
  ...over,
});
const kinds = (cs: Crank[]) => cs.map((c) => `${c.kind}:${c.utxoRef.slice(0, 2)}`);

describe("purchase-wallet crank selection", () => {
  it("withdraws the refund of a lock with no result after submit_result_time, straight from FundsLocked or RefundRequested", () => {
    expect(kinds(selectPurchaserCranks([], [lock(), lock({ outRef: ref("e2"), state: "RefundRequested" })], select))).toEqual(["MasumiRefund:e1", "MasumiRefund:e2"]);
    expect(selectPurchaserCranks([], [lock()], select)[0]?.masumi).toEqual({ escrowAddress: lock().escrowAddress, referenceSignature: "55".repeat(16) });
  });

  it("leaves locks with a result, before submit_result_time plus grace, or in dispute", () => {
    expect(selectPurchaserCranks([], [lock({ resultHash: "ab".repeat(32), state: "ResultSubmitted" })], select)).toEqual([]);
    expect(selectPurchaserCranks([], [lock({ submitResultTime: T - G + 1n })], select)).toEqual([]);
    expect(selectPurchaserCranks([], [lock({ state: "Disputed" })], select)).toEqual([]);
    expect(kinds(selectPurchaserCranks([], [lock({ state: "RefundAuthorized", submitResultTime: T + 600_000n })], select))).toEqual(["MasumiRefund:e1"]);
  });

  it("returns an unlocked payment after its return time, or at once when marked failed", () => {
    expect(kinds(selectPurchaserCranks([payment()], [], select))).toEqual(["MasumiReturn:d1"]);
    expect(selectPurchaserCranks([payment({ returnDueAt: T })], [], select)).toEqual([]);
    expect(selectPurchaserCranks([payment({ returnDueAt: null })], [], select)).toEqual([]);
    expect(kinds(selectPurchaserCranks([payment({ returnDueAt: T + 3_600_000n, failed: true })], [], select))).toEqual(["MasumiReturn:d1"]);
    expect(selectPurchaserCranks([payment()], [], select)[0]?.masumi).toEqual({ drawTx: "d1".repeat(32) });
  });
});

describe("purchase-wallet state and cranks from the indexer tables", () => {
  let db: TestDatabase;
  const slotConfig = { zeroTime: Number(T) - 3_600_000, zeroSlot: 0, slotLength: 1000 };
  const spec = (id: string, extra: Partial<NodeSpec>): NodeSpec => ({
    version: "1",
    id,
    task: id,
    category: "masumi",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    acceptance: "AutoAfterWindow",
    rail: "address",
    price: { asset: "lovelace", max_budget: "12000000", max_fee: "0" },
    deadlines: { work_ms: 600_000, compose_ms: 1_000, challenge_window_ms: 20_000, dispute_window_ms: 20_000 },
    may_sub_hire: false,
    max_sub_budget_share_bps: 0,
    verifier: { deterministic: ["schema"], quorum: null, challenge: false, arbitration: false },
    payee_hash: P,
    ...extra,
  });
  const rootNode = {
    spec: spec("root", { rail: "native", acceptance: "BuyerAccept", payee_hash: undefined, may_sub_hire: true, price: { asset: "lovelace", max_budget: "100000000", max_fee: "5000000" } }),
    agents: { primary: { agent_id: `${"67".repeat(28)}00`, quote_id: null, price: "100000000" }, fallbacks: [] },
    children: [{ spec: spec("lisan", {}), agents: { primary: { agent_id: `${"67".repeat(28)}aa`, quote_id: null, price: "12000000" }, fallbacks: [] }, children: [] }],
  };
  const plan = PlanSchema.parse({
    version: "1",
    plan_id: "p",
    asset: "lovelace",
    limits: { max_depth: 3, max_fanout: 8, max_child_share_bps: 6000, min_challenge_window_ms: 600_000, min_safety_margin_ms: 300_000 },
    root: rootNode,
    totals: { budget: "100000000", fees: "5000000", structural_lovelace: "10000000", reserve: "0" },
    deadlines: { fund_by: 1, submit_by: 2, challenge_until: 3, refund_after: 4, dispute_until: 5 },
    plan_root: computePlanRoot(rootNode),
  });
  const cfg = treeConfig({ tree_id: TREE, plan_root: plan.plan_root });
  // Drawn at slot 1200: 40 min before T, so due at Draw + 10 min work + the tree's safety margin.
  const drawSlot = 1200;

  beforeAll(async () => {
    db = await createTestDatabase();
    await db.pool.query(
      `INSERT INTO trees (tree_id, buyer_vkh, asset, root_budget, plan_root, config_utxo, state, frozen, created_slot, config, created_tx, updated_slot)
       VALUES ($1, $2, 'lovelace', 100000000, $3, $4, 'open', false, 1, '{}', $5, 1)`,
      [TREE, "11".repeat(28), plan.plan_root, ref("c0"), "c0".repeat(32)],
    );
    await db.pool.query("INSERT INTO plans (plan_id, plan_root, json, version) VALUES ('p', $1, $2, 1)", [plan.plan_root, JSON.stringify(plan)]);
    await db.pool.query(
      `INSERT INTO node_utxos (out_ref, kind, node_id, tree_id, tx_id, slot, seq, datum, datum_cbor, lovelace, assets) VALUES ($1, 'config', $2, $2, $3, 1, 1, '{}', $4, 2000000, '{}')`,
      [ref("c0"), TREE, "c0".repeat(32), encodeTreeConfig(cfg)],
    );
    await db.pool.query(
      `INSERT INTO node_utxos (out_ref, kind, node_id, tree_id, tx_id, slot, seq, datum, datum_cbor, lovelace, assets, leaf_ref, address)
       VALUES ($1, 'payment', $2, $2, $3, $4, 1, '{}', '', 12000000, '{}', $1, 'addr_test1p')`,
      [ref("d1"), TREE, "d1".repeat(32), drawSlot],
    );
    const lockDatum = { state: "FundsLocked", result_hash: "", submit_result_time: (T - 120_000n).toString(), reference_signature: "55".repeat(16) };
    await db.pool.query(
      `INSERT INTO node_utxos (out_ref, kind, node_id, tree_id, tx_id, slot, seq, datum, datum_cbor, lovelace, assets, leaf_ref, address)
       VALUES ($1, 'masumi_lock', $2, $2, $3, $4, 1, $5, '', 12000000, '{}', $6, 'addr_test1wescrow')`,
      [ref("e1"), TREE, "e1".repeat(32), drawSlot + 60, JSON.stringify(toWire(lockDatum)), ref("d0")],
    );
  });
  afterAll(async () => {
    await db.drop();
  });

  it("computes each payment's return time with the signer fence's rule and reads P's locks", async () => {
    const { payments, locks } = await purchaserState(db.pool, P, slotConfig);
    const drawnAt = BigInt(slotConfig.zeroTime + drawSlot * 1000);
    expect(payments).toEqual([
      { outRef: ref("d1"), drawTx: "d1".repeat(32), treeId: TREE, nodeId: TREE, returnDueAt: purchaserReturnDueAt({ drawnAt, plan, config: cfg, purchaserKeyHash: P }), failed: false },
    ]);
    expect(payments[0]?.returnDueAt).toBe(drawnAt + 600_000n + cfg.min_safety_margin);
    expect(locks).toEqual([
      { outRef: ref("e1"), treeId: TREE, nodeId: TREE, escrowAddress: "addr_test1wescrow", referenceSignature: "55".repeat(16), state: "FundsLocked", resultHash: "", submitResultTime: T - 120_000n },
    ]);
  });

  it("runs each purchase-wallet crank once per UTxO and records a failure for retry", async () => {
    const ran: Crank[] = [];
    const executor: CrankExecutor = {
      supports: () => true,
      async execute(c) {
        ran.push(c);
        if (c.kind === "MasumiReturn") throw new Error("signer refused: return-timing");
        return { txId: "f0".repeat(32) };
      },
    };
    const o = { pool: db.pool, executor, log: pino({ level: "silent" }), chainTime: async () => T, purchaser: { keyHash: P, slotConfig }, now: () => Number(T) };
    await tick(o);
    await tick(o);
    expect(kinds(ran)).toEqual(["MasumiRefund:e1", "MasumiReturn:d1"]);
    const { rows } = await db.pool.query<{ utxo_ref: string; kind: string; status: string }>("SELECT utxo_ref, kind, status FROM watchtower_cranks ORDER BY utxo_ref");
    expect(rows).toEqual([
      { utxo_ref: ref("d1"), kind: "MasumiReturn", status: "failed" },
      { utxo_ref: ref("e1"), kind: "MasumiRefund", status: "submitted" },
    ]);
  });
});
