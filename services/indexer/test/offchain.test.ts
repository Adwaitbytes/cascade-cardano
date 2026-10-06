/**
 * Off-chain facts the orchestrator reports next to the chain (A5, A8), and the events stream after a
 * rollback. Runs against a throwaway local Postgres: a child is drawn, submits and is challenged on
 * L0, and the root pays a third-party endpoint by an AddressPayment Draw.
 */
import { CascadeEventSchema, decodeNodeDatum, jcsSha256Hex, type NodeDatum } from "@cascade/shared";
import { deriveRoleKey, outRef, withTransaction, type ChainTx } from "@cascade/service-kit";
import { CHILD_ID, LOGIC_CORE, LOGIC_DRAW, TREE_ID, createTestDatabase, keyAddr, type TestDatabase } from "@cascade/service-kit/testing";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { project } from "../src/projector.js";
import { applyProjection, loadConfigs, loadTracked, recordPoint, rollbackTo } from "../src/store.js";
import { SCRIPTS, addressText, keyOut, lifecycle, nodeOut, tx, walletIn, type Step } from "./scenario.js";

const oracle = deriveRoleKey("test test test test test test test test test test test test test test test test test test test test test test test sauce", 15, "local");
const TOKEN = "t0ken";
const CHALLENGER = "c1".repeat(28);
const LOOKUP_API = "a5".repeat(28);
const REASON = { kind: "schema", errors: ["output.rows: expected array"] };
const REASON_HASH = jcsSha256Hex(REASON);
const PAYMENT_RESPONSE = { success: true, transaction: "ab".repeat(32), network: "cardano:preprod", payer: "addr_test1qpayer" };

let db: TestDatabase;

const datumOf = (t: ChainTx, i: number): NodeDatum => decodeNodeDatum(t.outputs[i]?.datum ?? "");

/** FundRoot, Draw, Submit from the lifecycle; then an L0 Challenge of the child and an AddressPayment Draw by the root. */
function scenario(): Step[] {
  const base = lifecycle().slice(0, 3);
  const [, draw, submit] = base.map((s) => s.tx) as [ChainTx, ChainTx, ChainTx];
  const child = datumOf(submit, 0);
  const childRef = outRef(submit.id, 0);
  const challengeInputs = [childRef, walletIn(9)].sort();
  const challenge = tx(
    9,
    challengeInputs,
    [nodeOut({ ...child, state: "Challenged" }), keyOut(CHALLENGER, 5_000_000n)],
    [
      {
        type: "Challenge",
        node_in: BigInt(challengeInputs.indexOf(childRef)),
        node_out: 0n,
        reason_hash: REASON_HASH,
        challenger: CHALLENGER,
        challenger_address: keyAddr(CHALLENGER),
        bond_out: 1n,
        config_ref: 0n,
        parent_ref: null,
      },
    ],
    LOGIC_CORE,
  );
  const root = datumOf(draw, 0);
  const rootRef = outRef(draw.id, 0);
  const payInputs = [rootRef, walletIn(10)].sort();
  const pay = tx(
    10,
    payInputs,
    [nodeOut({ ...root, spent: root.spent + 3_000_000n }), keyOut(LOOKUP_API, 3_000_000n)],
    [
      {
        type: "Draw",
        node_in: BigInt(payInputs.indexOf(rootRef)),
        node_out: 0n,
        config_ref: 0n,
        root_ref: null,
        children: [
          {
            out: 1n,
            external_out: null,
            leaf: { spec_hash: "0a".repeat(32), parent_spec_hash: root.spec_hash, kind: "AddressPayment", max_budget: 3_000_000n, max_fee: 3_000_000n, payee_hash: LOOKUP_API, acceptance_hash: "00".repeat(32) },
            proof: [],
          },
        ],
      },
    ],
    LOGIC_DRAW,
  );
  return [...base, { tx: challenge, slot: 130 }, { tx: pay, slot: 140 }];
}

const STEPS = scenario();
const CHALLENGE_TX = STEPS[3]!.tx.id;
const PAY_TX = STEPS[4]!.tx.id;

async function applyStep(i: number): Promise<void> {
  const step = STEPS[i]!;
  await withTransaction(db.pool, async (c) => {
    const tracked = await loadTracked(c, step.tx.inputs);
    const configs = await loadConfigs(c, [...new Set([...tracked.values()].map((t) => t.treeId))]);
    const block = { slot: step.slot, hash: step.slot.toString(16).padStart(64, "0"), height: step.slot };
    await applyProjection(c, project(step.tx, { scripts: SCRIPTS, tracked, configs, addressText }), block, 0, 1_700_000_000_000 + i);
    await recordPoint(c, block, 100);
  });
}

function api() {
  return createApi({
    pool: db.pool,
    scripts: SCRIPTS,
    oracle,
    log: pino({ level: "silent" }),
    tipHeight: async () => 200,
    tipSlot: async () => 200,
    horizonSlots: 300,
    adminToken: TOKEN,
    decimalsOf: () => 6,
    health: () => ({}),
    views: { slotConfig: { zeroTime: 1_700_000_000_000, zeroSlot: 0, slotLength: 1000 }, indexedSlot: async () => 140, maxExUnits: async () => ({ memory: 17_500_000n, steps: 10_000_000_000n }) },
  });
}

const post = (path: string, body: unknown, token: string | null = TOKEN) =>
  api().request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });

interface EventOut {
  event_id: string;
  type: string;
  node_id: string;
  tx_id: string;
  payload: Record<string, unknown>;
}
const events = async (): Promise<EventOut[]> => ((await (await api().request(`/v1/trees/${TREE_ID}/events?limit=1000`)).json()) as { events: EventOut[] }).events;
const detail = async (nodeId: string): Promise<Record<string, unknown>> => (await (await api().request(`/v1/trees/${TREE_ID}/nodes/${nodeId}`)).json()) as Record<string, unknown>;
const receiptLines = async () =>
  ((await (await api().request(`/v1/trees/${TREE_ID}/receipt`)).json()) as { lines: { node_id: string; kind: string; tx_id: string; payment_response?: unknown }[] }).lines;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

describe("L0 challenge reason (A8)", () => {
  it("accepts a reason before its challenge is indexed, and refuses one whose hash is not the challenge's", async () => {
    for (let i = 0; i < 3; i++) await applyStep(i);
    expect((await post("/v1/admin/challenges", { tree_id: TREE_ID, node_id: CHILD_ID, challenge_tx: CHALLENGE_TX, reason: REASON }, null)).status).toBe(403);
    expect((await post("/v1/admin/challenges", { tree_id: TREE_ID, node_id: CHILD_ID, challenge_tx: "zz", reason: REASON })).status).toBe(400);
    const early = await post("/v1/admin/challenges", { tree_id: TREE_ID, node_id: CHILD_ID, challenge_tx: CHALLENGE_TX, reason: REASON });
    expect(early.status).toBe(202);
    expect(await early.json()).toEqual({ ok: true, reason_hash: REASON_HASH, indexed: false });

    await applyStep(3);
    const wrong = await post("/v1/admin/challenges", { tree_id: TREE_ID, node_id: CHILD_ID, challenge_tx: CHALLENGE_TX, reason: { kind: "schema", errors: ["other"] } });
    expect(wrong.status).toBe(409);
  });

  it("records the L0 reject as a strict node.verified event once the challenge is on chain, exactly once", async () => {
    const again = await post("/v1/admin/challenges", { tree_id: TREE_ID, node_id: CHILD_ID, challenge_tx: CHALLENGE_TX, reason: REASON });
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ ok: true, reason_hash: REASON_HASH, indexed: true });
    const verified = (await events()).filter((e) => e.type === "node.verified");
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({ node_id: CHILD_ID, tx_id: STEPS[1]!.tx.id, payload: { verdict: "reject", verifier: "L0", evidence_hash: REASON_HASH } });
    const raw = (await (await api().request(`/v1/trees/${TREE_ID}/events?limit=1000`)).json()) as { events: unknown[] };
    for (const e of raw.events) expect(CascadeEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
  });

  it("shows the challenger, reason hash and the L0 reason on the node detail", async () => {
    const d = await detail(CHILD_ID);
    expect(d.challenge).toEqual({
      tx_id: CHALLENGE_TX,
      challenger: CHALLENGER,
      reason_hash: REASON_HASH,
      bond_lovelace: "5000000",
      verdict: "reject",
      level: "L0",
      reason: REASON,
    });
    expect((await detail(TREE_ID)).challenge).toBeNull();
  });
});

describe("x402 PAYMENT-RESPONSE of a Draw (A5)", () => {
  const body = { draw_tx: PAY_TX, node_id: TREE_ID, tree_id: TREE_ID, payment_response: PAYMENT_RESPONSE };

  it("requires the admin token and a well-formed body", async () => {
    expect((await post("/v1/admin/results", body, null)).status).toBe(403);
    expect((await post("/v1/admin/results", body, "wrong")).status).toBe(403);
    expect((await post("/v1/admin/results", { ...body, draw_tx: "xyz" })).status).toBe(400);
    expect((await post("/v1/admin/results", { ...body, extra: 1 })).status).toBe(400);
    expect((await post("/v1/admin/results", { ...body, payment_response: null })).status).toBe(400);
  });

  it("stores it idempotently by (draw_tx, node_id) and refuses a different response for the same key", async () => {
    expect((await post("/v1/admin/results", body)).status).toBe(201);
    expect((await post("/v1/admin/results", body)).status).toBe(201);
    expect((await post("/v1/admin/results", { ...body, payment_response: { success: false } })).status).toBe(409);
    expect((await db.pool.query("SELECT 1 FROM x402_results")).rows).toHaveLength(1);
  });

  it("serves it only once the Draw is indexed, on the node detail and the Draw's payment line", async () => {
    expect(JSON.stringify(await detail(TREE_ID))).not.toMatch(/payment[-_]?response/i);
    expect((await receiptLines()).some((l) => l.payment_response !== undefined)).toBe(false);

    await applyStep(4);
    expect((await detail(TREE_ID)).x402_results).toEqual([{ draw_tx: PAY_TX, node_id: TREE_ID, payment_response: PAYMENT_RESPONSE }]);
    expect(JSON.stringify(await detail(CHILD_ID))).not.toMatch(/payment[-_]?response/i);
    const lines = await receiptLines();
    const paid = lines.filter((l) => l.tx_id === PAY_TX && l.kind === "fee");
    expect(paid).toHaveLength(1);
    expect(paid[0]?.payment_response).toEqual(PAYMENT_RESPONSE);
    expect(lines.filter((l) => l.tx_id !== PAY_TX).every((l) => l.payment_response === undefined)).toBe(true);
  });
});

describe("rollback", () => {
  it("drops rolled-back events from the events stream, the L0 verdict and the payment response with them, and restores them on replay", async () => {
    const before = await events();
    await withTransaction(db.pool, (c) => rollbackTo(c, 120, { slot: 120, hash: (120).toString(16).padStart(64, "0"), height: 120 }, Date.now()));

    const after = await events();
    const undone = new Set(before.filter((e) => e.tx_id === CHALLENGE_TX || e.tx_id === PAY_TX || e.type === "node.verified").map((e) => e.event_id));
    expect(undone.size).toBeGreaterThanOrEqual(3);
    expect(after.some((e) => undone.has(e.event_id))).toBe(false);
    expect(after.filter((e) => e.type === "chain.rollback").length).toBeGreaterThan(0);
    expect((await detail(CHILD_ID)).challenge).toBeNull();
    expect(JSON.stringify(await detail(TREE_ID))).not.toMatch(/payment[-_]?response/i);
    expect((await receiptLines()).some((l) => l.payment_response !== undefined)).toBe(false);

    await applyStep(3);
    await applyStep(4);
    const replayed = await events();
    expect(replayed.filter((e) => e.type === "node.verified")).toHaveLength(1);
    expect((await detail(CHILD_ID)).challenge).toMatchObject({ level: "L0", reason: REASON });
    expect((await detail(TREE_ID)).x402_results).toHaveLength(1);
  });
});
