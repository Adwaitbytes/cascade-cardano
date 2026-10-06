/**
 * The masumi-purchaser role through the signer and a throwaway Postgres: the Draw's AddressPayment
 * to P is found from indexer events, the lock is signed and logged, a later refund on that lock is
 * signed, and anything else is refused and logged.
 */
import { computePlanRoot, encodeMasumiDatum, encodeNodeDatum, encodeTreeConfig, jcsSha256, PlanSchema, verifyCose1, type NodeSpec, type PlutusAddress } from "@cascade/shared";
import { chainTxFromCbor, deriveRoleKey, toWire, type ResolvedOutput } from "@cascade/service-kit";
import { TREE_ID, buildTxCbor, createTestDatabase, keyAddress, rootDatum, scriptAddress, treeConfig, type TestDatabase } from "@cascade/service-kit/testing";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { PURCHASER_ROLE, Signer, type SignerOptions } from "../src/signer.js";

const YACI = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const ADA = 1_000_000n;
const MIN = 60_000n;
const P = deriveRoleKey(YACI, 19, "local");
const logKey = deriveRoleKey(YACI, 21, "local");
const BUYER = "11".repeat(28);
const SELLER = "5e".repeat(28);
const MASUMI = "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad";
const AGENT = `${"67".repeat(28)}aa`;
const key = (k: string): PlutusAddress => ({ payment_credential: { type: "VerificationKey", hash: k }, stake_credential: null });
const DRAW_TX = "d1".repeat(32);
const RECEIVED = `${DRAW_TX}#2`;
const OWN = `${"e1".repeat(32)}#0`;
const NOW = Date.now();

const spec = (id: string, extra: Partial<NodeSpec>): NodeSpec => ({
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
  payee_hash: P.paymentKeyHash,
  ...extra,
});
const rootNode = {
  spec: spec("root", { rail: "native", acceptance: "BuyerAccept", payee_hash: undefined, may_sub_hire: true, price: { asset: "lovelace", max_budget: "100000000", max_fee: "5000000" } }),
  agents: { primary: { agent_id: `${"67".repeat(28)}00`, quote_id: null, price: "100000000" }, fallbacks: [] },
  children: [{ spec: spec("lisan", {}), agents: { primary: { agent_id: AGENT, quote_id: null, price: "12000000" }, fallbacks: [] }, children: [] }],
};
const plan = PlanSchema.parse({
  version: "1",
  plan_id: "masumi-plan",
  asset: "lovelace",
  limits: { max_depth: 3, max_fanout: 8, max_child_share_bps: 6000, min_challenge_window_ms: 600_000, min_safety_margin_ms: 300_000 },
  root: rootNode,
  totals: { budget: "100000000", fees: "5000000", structural_lovelace: "10000000", reserve: "0" },
  deadlines: { fund_by: 1, submit_by: 2, challenge_until: 3, refund_after: 4, dispute_until: 5 },
  plan_root: computePlanRoot(rootNode),
});
const cfg = treeConfig({ plan_root: plan.plan_root, buyer_refund: key(BUYER), masumi_script_hash: MASUMI });
const root = rootDatum({ submit_by: BigInt(NOW) + 600n * MIN, challenge_until: BigInt(NOW) + 610n * MIN, refund_after: BigInt(NOW) + 600n * MIN, dispute_until: BigInt(NOW) + 620n * MIN });
const datum = (over: Record<string, unknown> = {}) =>
  encodeMasumiDatum({
    buyer: key(P.paymentKeyHash),
    buyer_return_address: key(BUYER),
    seller: key(SELLER),
    seller_return_address: null,
    reference_key: "a10101",
    reference_signature: "55".repeat(16),
    seller_nonce: "33".repeat(32),
    buyer_nonce: "",
    agent_identifier: AGENT,
    collateral_return_lovelace: 0n,
    input_hash: "44".repeat(32),
    result_hash: "",
    pay_by_time: BigInt(NOW) + 10n * MIN,
    submit_result_time: BigInt(NOW) + 30n * MIN,
    unlock_time: BigInt(NOW) + 50n * MIN,
    external_dispute_unlock_time: BigInt(NOW) + 70n * MIN,
    seller_cooldown_time: 0n,
    buyer_cooldown_time: 0n,
    state: "FundsLocked",
    ...over,
  } as Parameters<typeof encodeMasumiDatum>[0]);

let db: TestDatabase;
let signer: Signer;
let options: SignerOptions;
const chain = new Map<string, ResolvedOutput>([
  [RECEIVED, { address: P.address, lovelace: 12n * ADA, assets: {}, datum: null }],
  [OWN, { address: P.address, lovelace: 5n * ADA, assets: {}, datum: null }],
]);

beforeAll(async () => {
  db = await createTestDatabase();
  await db.pool.query(
    `INSERT INTO node_utxos (out_ref, kind, node_id, tree_id, tx_id, slot, seq, datum, datum_cbor, lovelace, assets) VALUES
     ($1, 'node', $2, $2, $3, 10, 0, $4, $5, 1, '{}'), ($6, 'config', $2, $2, $3, 10, 1, $7, $8, 1, '{}')`,
    [`${DRAW_TX}#0`, TREE_ID, DRAW_TX, JSON.stringify(toWire(root)), encodeNodeDatum(root), `${"aa".repeat(32)}#1`, JSON.stringify(toWire(cfg)), encodeTreeConfig(cfg)],
  );
  await db.pool.query(
    `INSERT INTO node_events (node_id, tree_id, type, tx_id, slot, block_hash, block_height, value_delta, payload, emitted_at)
     VALUES ($1, $1, 'node.settled', $2, 10, $3, 10, '{"asset":"lovelace","amount":"12000000"}', $4, 0)`,
    [TREE_ID, DRAW_TX, "bb".repeat(32), JSON.stringify({ fee_paid: "12000000", returned_to_parent: "0", _flows: [{ kind: "fee", node_id: TREE_ID, to: P.address, asset: "lovelace", amount: "12000000" }] })],
  );
  await db.pool.query("INSERT INTO plans (plan_id, plan_root, json, version) VALUES ($1, $2, $3, 1)", [plan.plan_id, plan.plan_root, JSON.stringify(plan)]);
  await db.pool.query("INSERT INTO agents (agent_asset_id, name, api_url, payment_vkh, allowlisted) VALUES ($1, 'Lisan', 'http://127.0.0.1:1', $2, true)", [AGENT, SELLER]);
  await db.pool.query(
    `INSERT INTO node_utxos (out_ref, kind, node_id, tree_id, tx_id, slot, seq, datum, datum_cbor, lovelace, assets, leaf_ref, address)
     VALUES ($1, 'payment', $2, $2, $3, 10, 2, '{}', '', 12000000, '{}', $1, $4)`,
    [RECEIVED, TREE_ID, DRAW_TX, P.address],
  );
  options = {
    pool: db.pool,
    scripts: { node: "5a".repeat(28), config: null, logicCore: null, logicDraw: null },
    keys: new Map([[PURCHASER_ROLE, P]]),
    logKey,
    simulator: { evaluate: async () => ({ memory: 0n, cpu: 0n }) },
    resolveInputs: async (refs) => new Map(refs.filter((r) => chain.has(r)).map((r) => [r, chain.get(r) as ResolvedOutput])),
    abuseList: [],
    log: pino({ level: "silent" }),
  };
  signer = new Signer(options);
});
afterAll(async () => {
  await db.drop();
});

const lockCbor = (lockLovelace = 12n * ADA, lockDatum = datum()) =>
  buildTxCbor({
    inputs: [RECEIVED, OWN],
    outputs: [
      { address: scriptAddress(MASUMI), lovelace: lockLovelace, datum: lockDatum },
      { address: P.address, lovelace: 4_800_000n + 12n * ADA - lockLovelace },
    ],
    fee: 200_000n,
    ttl: 10_000n,
  });

describe("masumi-purchaser in the signer (ADR 0001 8.1)", () => {
  let lockTx = "";

  it("signs a plan-bound lock of the received amount and logs it", async () => {
    const r = await signer.sign(PURCHASER_ROLE, lockCbor());
    expect(r.report?.gates.filter((g) => !g.passed)).toEqual([]);
    expect(r.decision).toBe("allow");
    lockTx = r.txBodyHash;
    const { rows } = await db.pool.query<{ decision: string; tree_id: string; signature: string; key: string; body: Record<string, unknown> }>(
      "SELECT decision, tree_id, signature, key, body FROM gate_logs WHERE tx_body_hash = $1",
      [lockTx],
    );
    expect(rows[0]).toMatchObject({ decision: "allow", tree_id: TREE_ID });
    expect(verifyCose1({ signature: rows[0]!.signature, key: rows[0]!.key }, { payload: jcsSha256(rows[0]!.body), address: logKey.address }).ok).toBe(true);
  });

  it("refuses a lock whose refunds would not reach buyer_refund, and logs the refusal", async () => {
    const r = await signer.sign(PURCHASER_ROLE, lockCbor(12n * ADA, datum({ buyer_return_address: key(P.paymentKeyHash) })));
    expect(r.decision).toBe("deny");
    expect(r.report?.gates.filter((g) => !g.passed).map((g) => g.name)).toEqual(["datum"]);
    const { rows } = await db.pool.query("SELECT 1 FROM gate_logs WHERE tx_body_hash = $1 AND decision = 'deny'", [r.txBodyHash]);
    expect(rows).toHaveLength(1);
  });

  it("signs WithdrawRefund on the approved lock only when the refund goes to buyer_refund", async () => {
    const LOCK = `${lockTx}#0`;
    chain.set(LOCK, { address: scriptAddress(MASUMI), lovelace: 12n * ADA, assets: {}, datum: datum({ state: "RefundAuthorized" }) });
    const refund = (to: string) => {
      const inputs = [LOCK, OWN].sort();
      return buildTxCbor({
        inputs,
        outputs: [{ address: to, lovelace: 12n * ADA }, { address: P.address, lovelace: 4_700_000n }],
        fee: 300_000n,
        redeemers: [{ tag: 0, index: inputs.indexOf(LOCK), data: "d87c80" }],
      });
    };
    expect((await signer.sign(PURCHASER_ROLE, refund(keyAddress(BUYER)))).decision).toBe("allow");
    const bad = await signer.sign(PURCHASER_ROLE, refund(keyAddress(SELLER)));
    expect(bad.decision).toBe("deny");
    expect(chainTxFromCbor(lockCbor()).id).toBe(lockTx);
  });
});

describe("masumi-purchaser return of unlocked funds (ADR 0001 8.1 exit)", () => {
  // The Draw is at slot 10. The leaf's work window is 60 s plus the tree's safety margin.
  const returnCbor = () =>
    buildTxCbor({ inputs: [RECEIVED, OWN], outputs: [{ address: keyAddress(BUYER), lovelace: 12n * ADA }, { address: P.address, lovelace: 4_800_000n }], fee: 200_000n });
  const signerWith = (zeroTime: number): Signer =>
    new Signer({ ...options, slotConfig: { zeroTime, zeroSlot: 0, slotLength: 1000 } });

  it("returns the received amount to buyer_refund once the Draw is older than the work window plus margin", async () => {
    const r = await signerWith(NOW - 3_600_000).sign(PURCHASER_ROLE, returnCbor());
    expect(r.report?.gates.filter((g) => !g.passed)).toEqual([]);
    expect(r.decision).toBe("allow");
    const { rows } = await db.pool.query("SELECT decision FROM gate_logs WHERE tx_body_hash = $1", [r.txBodyHash]);
    expect(rows).toEqual([{ decision: "allow" }]);
  });

  it("refuses a fresh Draw's return until the slot is marked failed through the API", async () => {
    const fresh = signerWith(NOW);
    const before = await fresh.sign(PURCHASER_ROLE, returnCbor());
    expect(before.decision).toBe("deny");
    expect(before.report?.reasons).toEqual(["return-timing"]);
    const app = createApp(fresh, db.pool, pino({ level: "silent" }), "t0ken");
    const mark = (ref: string, auth = "Bearer t0ken") =>
      app.request("/v1/masumi/failed", { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify({ payment_out_ref: ref, reason: "seller never started" }) });
    expect((await mark(RECEIVED, "Bearer wrong")).status).toBe(403);
    expect((await mark(`${"ee".repeat(32)}#0`)).status).toBe(404);
    expect((await mark(RECEIVED)).status).toBe(200);
    const after = await fresh.sign(PURCHASER_ROLE, returnCbor());
    expect(after.decision).toBe("allow");
    const logs = await db.pool.query<{ decision: string }>("SELECT decision FROM gate_logs WHERE tx_body_hash = $1 ORDER BY log_id", [after.txBodyHash]);
    expect(logs.rows.map((x) => x.decision)).toEqual(["allow", "deny", "allow"]);
  });

  it("refuses a return that pays anyone but buyer_refund", async () => {
    const elsewhere = buildTxCbor({ inputs: [RECEIVED, OWN], outputs: [{ address: keyAddress(SELLER), lovelace: 12n * ADA }, { address: P.address, lovelace: 4_800_000n }], fee: 200_000n });
    const r = await signerWith(NOW - 3_600_000).sign(PURCHASER_ROLE, elsewhere);
    expect(r.decision).toBe("deny");
    expect(r.report?.reasons).toEqual(["return-outputs"]);
  });
});
