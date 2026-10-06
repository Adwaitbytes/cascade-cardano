import { createTestDatabase, type TestDatabase } from "@cascade/service-kit/testing";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tick } from "../src/loop.js";
import { selectCranks, selectDisputeAlerts, type Crank, type CrankExecutor, type LiveNode } from "../src/selection.js";

const T = 2_000_000_000_000n;
const G = 30_000n;
const id = (b: string) => b.repeat(28);
const ref = (b: string) => `${b.repeat(32)}#0`;

function node(over: Partial<LiveNode>): LiveNode {
  return {
    nodeId: id("22"),
    treeId: id("11"),
    parentId: id("11"),
    kind: "Native",
    state: "Funded",
    childrenOpen: 0,
    submitBy: T,
    challengeUntil: T + 600_000n,
    refundAfter: T,
    disputeUntil: T + 1_200_000n,
    currentUtxo: ref("22"),
    ...over,
  };
}
const root = (over: Partial<LiveNode> = {}) => node({ nodeId: id("11"), parentId: null, childrenOpen: 1, submitBy: T + 5_000_000n, refundAfter: T + 5_000_000n, challengeUntil: T + 5_600_000n, disputeUntil: T + 6_000_000n, currentUtxo: ref("11"), ...over });
const kinds = (cs: Crank[]) => cs.map((c) => `${c.kind}:${c.nodeId.slice(0, 2)}`);

describe("crank selection (PRD 11.5)", () => {
  it("refunds a silent child only after refund_after plus grace", () => {
    expect(selectCranks([root(), node({})], { now: T + G, graceMs: G })).toEqual([]);
    expect(kinds(selectCranks([root(), node({})], { now: T + G + 1n, graceMs: G }))).toEqual(["Refund:22"]);
  });

  it("never refunds a node with open children or one that submitted", () => {
    expect(selectCranks([root(), node({ childrenOpen: 1 })], { now: T * 2n, graceMs: G }).filter((c) => c.nodeId === id("22"))).toEqual([]);
    const submitted = selectCranks([root(), node({ state: "Submitted" })], { now: T + 100_000n, graceMs: G });
    expect(submitted).toEqual([]);
  });

  it("settles an Accepted child at once and a Submitted child after its challenge window", () => {
    expect(kinds(selectCranks([root(), node({ state: "Accepted" })], { now: T, graceMs: G }))).toEqual(["SettleChild:22"]);
    expect(selectCranks([root(), node({ state: "Submitted" })], { now: T + 600_000n, graceMs: G })).toEqual([]);
    expect(kinds(selectCranks([root(), node({ state: "Submitted" })], { now: T + 700_000n, graceMs: G }))).toEqual(["SettleChild:22"]);
  });

  it("deadline-accepts a lapsed child whose parent cannot settle yet", () => {
    const busyParent = root({ state: "Submitted" });
    expect(kinds(selectCranks([busyParent, node({ state: "Submitted" })], { now: T + 700_000n, graceMs: G }))).toEqual(["Accept:22"]);
  });

  it("closes the root after its window, resolves stale disputes and closes late receipts", () => {
    expect(kinds(selectCranks([root({ state: "Submitted", childrenOpen: 0 })], { now: T + 5_700_000n, graceMs: G }))).toEqual(["CloseRoot:11"]);
    expect(kinds(selectCranks([root(), node({ state: "Challenged" })], { now: T + 1_300_000n, graceMs: G }))).toEqual(["Resolve:22"]);
    expect(kinds(selectCranks([root(), node({ kind: "MasumiReceipt" })], { now: T + 1_300_000n, graceMs: G }))).toEqual(["CloseReceipt:22"]);
  });

  it("alerts on Disputed nodes inside the window before dispute_until, not before or after", () => {
    const n = node({ state: "Disputed" });
    const W = 300_000n;
    expect(selectDisputeAlerts([n], n.disputeUntil - W - 1n, W)).toEqual([]);
    expect(selectDisputeAlerts([n], n.disputeUntil - 1_000n, W).map((a) => a.msLeft)).toEqual([1_000n]);
    expect(selectDisputeAlerts([n], n.disputeUntil + 1n, W)).toEqual([]);
    expect(selectDisputeAlerts([node({ state: "Challenged" })], n.disputeUntil - 1_000n, W)).toEqual([]);
  });

  it("orders cranks by deadline", () => {
    const a = node({ nodeId: id("aa"), currentUtxo: ref("aa"), refundAfter: T + 10n });
    const b = node({ nodeId: id("bb"), currentUtxo: ref("bb"), refundAfter: T });
    expect(kinds(selectCranks([root(), a, b], { now: T * 2n, graceMs: G }))).toEqual(["Refund:bb", "Refund:aa"]);
  });
});

describe("watchtower loop", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    await db.pool.query(
      `INSERT INTO trees (tree_id, buyer_vkh, asset, root_budget, plan_root, config_utxo, state, created_slot, config, created_tx, updated_slot)
       VALUES ($1, $2, 'lovelace', 0, $3, $4, 'open', 1, '{}', $5, 1)`,
      [id("11"), id("99"), "ab".repeat(32), ref("cf"), "ab".repeat(32)],
    );
    const ins = (n: LiveNode) =>
      db.pool.query(
        `INSERT INTO nodes (node_id, tree_id, parent_id, depth, kind, operator_vkh, payee, budget, fee, committed, children_open, spec_hash, input_hash, acceptance,
           submit_by, challenge_until, refund_after, dispute_until, state, current_utxo, next_child, structural, external_lovelace, created_tx, created_slot, last_tx, updated_slot)
         VALUES ($1, $2, $3, 1, $4, $5, 'addr_test1x', 1, 0, 0, $6, $7, $7, '{"type":"AutoAfterWindow"}', $8, $9, $10, $11, $12, $13, 0, 0, 0, $7, 1, $7, 1)`,
        [n.nodeId, n.treeId, n.parentId, n.kind, id("22"), n.childrenOpen, "ab".repeat(32), n.submitBy.toString(), n.challengeUntil.toString(), n.refundAfter.toString(), n.disputeUntil.toString(), n.state, n.currentUtxo],
      );
    await ins(root());
    await ins(node({}));
  });
  afterAll(async () => {
    await db.drop();
  });

  it("runs a crank once per UTxO, retries a failure later, and records unsupported kinds", async () => {
    const calls: Crank[] = [];
    let fail = true;
    const executor: CrankExecutor = {
      supports: (k) => k !== "CloseReceipt",
      async execute(c) {
        calls.push(c);
        if (fail) throw new Error("provider down");
        return { txId: "ef".repeat(32) };
      },
    };
    const log = pino({ level: "silent" });
    let clock = 1_000_000;
    const opts = { pool: db.pool, executor, log, chainTime: async () => T + 60_000n, now: () => clock, retryAfterMs: 60_000 };
    const first = await tick(opts);
    expect(first.ran.map((r) => r.error)).toEqual(["provider down"]);
    await tick(opts);
    expect(calls).toHaveLength(1);
    clock += 61_000;
    fail = false;
    const third = await tick(opts);
    expect(third.ran.map((r) => r.txId)).toEqual(["ef".repeat(32)]);
    clock += 120_000;
    await tick(opts);
    expect(calls).toHaveLength(2);
    const row = await db.pool.query<{ status: string; attempts: number }>("SELECT status, attempts FROM watchtower_cranks WHERE utxo_ref = $1", [ref("22")]);
    expect(row.rows[0]).toEqual({ status: "submitted", attempts: 2 });
  });

  it("runs a crank recorded as unsupported once an executor can", async () => {
    await db.pool.query("UPDATE nodes SET state = 'Funded', current_utxo = $2 WHERE node_id = $1", [id("22"), ref("25")]);
    const base = { pool: db.pool, log: pino({ level: "silent" }), chainTime: async () => T + 60_000n, now: () => 5_000_000 };
    await tick({ ...base, executor: null });
    const calls: Crank[] = [];
    await tick({ ...base, executor: { supports: () => true, execute: async (c) => (calls.push(c), { txId: "cd".repeat(32) }) } });
    expect(calls.map((c) => c.utxoRef)).toEqual([ref("25")]);
  });

  it("takes over a crank a killed watchtower left 'building', but not a fresh one", async () => {
    await db.pool.query("UPDATE nodes SET state = 'Funded', current_utxo = $2 WHERE node_id = $1", [id("22"), ref("24")]);
    await db.pool.query("INSERT INTO watchtower_cranks (utxo_ref, kind, node_id, tree_id, status, attempts, updated_at) VALUES ($1, 'Refund', $2, $3, 'building', 1, $4)", [ref("24"), id("22"), id("11"), 1_000]);
    const calls: Crank[] = [];
    const executor: CrankExecutor = { supports: () => true, execute: async (c) => (calls.push(c), { txId: "ab".repeat(32) }) };
    const base = { pool: db.pool, executor, log: pino({ level: "silent" }), chainTime: async () => T + 60_000n };
    await tick({ ...base, now: () => 1_000 + 60_000 });
    expect(calls).toHaveLength(0);
    await tick({ ...base, now: () => 1_000 + 400_000 });
    expect(calls.map((c) => c.utxoRef)).toEqual([ref("24")]);
  });

  it("leaves a crank unclaimed while the executor is not ready, and a stale wallet view costs no attempt", async () => {
    await db.pool.query("UPDATE nodes SET state = 'Funded', current_utxo = $2 WHERE node_id = $1", [id("22"), ref("26")]);
    const log = pino({ level: "silent" });
    let ready = false;
    const calls: Crank[] = [];
    const executor: CrankExecutor = {
      supports: () => true,
      ready: async () => ready,
      async execute(c) {
        calls.push(c);
        throw new Error('EvaluateTransaction fails: {"CannotCreateEvaluationContext":{"reason":"Unknown transaction input (missing from UTxO set): cb6c#1"}}');
      },
    };
    let clock = 9_000_000;
    const opts = { pool: db.pool, executor, log, chainTime: async () => T + 60_000n, now: () => clock, retryAfterMs: 60_000, maxAttempts: 3 };
    await tick(opts);
    expect(calls).toHaveLength(0);
    expect((await db.pool.query("SELECT 1 FROM watchtower_cranks WHERE utxo_ref = $1", [ref("26")])).rows).toHaveLength(0);
    ready = true;
    for (let i = 0; i < 4; i++) {
      await tick(opts);
      clock += 61_000;
    }
    expect(calls).toHaveLength(4);
    const row = await db.pool.query<{ status: string; attempts: number }>("SELECT status, attempts FROM watchtower_cranks WHERE utxo_ref = $1", [ref("26")]);
    expect(row.rows[0]).toEqual({ status: "failed", attempts: 0 });
  });

  it("records a short plain cause for the ops page, and a node already spent elsewhere costs no attempt", async () => {
    await db.pool.query("UPDATE nodes SET state = 'Funded', current_utxo = $2 WHERE node_id = $1", [id("22"), ref("27")]);
    const lines: string[] = [];
    const log = pino({ level: "warn" }, { write: (l: string) => lines.push(l) });
    const executor: CrankExecutor = {
      supports: () => true,
      execute: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'address')");
      },
    };
    const { ran } = await tick({ pool: db.pool, executor, log, chainTime: async () => T + 60_000n, now: () => 20_000_000 });
    const cause = "node UTxO not at the chain provider: already spent by another transaction, or not indexed yet";
    expect(ran.map((r) => r.error)).toEqual([cause]);
    const row = await db.pool.query<{ status: string; attempts: number; last_error: string }>("SELECT status, attempts, last_error FROM watchtower_cranks WHERE utxo_ref = $1", [ref("27")]);
    expect(row.rows[0]).toEqual({ status: "failed", attempts: 0, last_error: cause });
    // The raw message stays in the log beside the cause.
    expect(lines.some((l) => l.includes("reading 'address'") && l.includes(cause))).toBe(true);
  });

  it("raises one dispute alert per Disputed node state", async () => {
    await db.pool.query("UPDATE nodes SET state = 'Disputed', current_utxo = $2 WHERE node_id = $1", [id("22"), ref("23")]);
    const lines: string[] = [];
    const log = pino({ level: "warn" }, { write: (l: string) => lines.push(l) });
    const opts = { pool: db.pool, executor: null, log, chainTime: async () => T + 1_200_000n - 60_000n, disputeAlertMs: 120_000n };
    expect((await tick(opts)).alerts.map((a) => a.nodeId)).toEqual([id("22")]);
    await tick(opts);
    expect(lines.filter((l) => l.includes("dispute_deadline"))).toHaveLength(1);
    const rows = await db.pool.query<{ ms_left: string }>("SELECT ms_left FROM dispute_alerts WHERE node_id = $1", [id("22")]);
    expect(rows.rows).toEqual([{ ms_left: "60000" }]);
  });
});
