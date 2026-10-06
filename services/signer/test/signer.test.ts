/**
 * Signer against a throwaway Postgres. Gate wiring tests inject a simulator (unit level); the last
 * test uses the real Yaci Ogmios to prove a failing script evaluation denies at gate 8.
 */
import { CML, Constr } from "@lucid-evolution/lucid";
import {
  actionsToData,
  computePlanRoot,
  encodeNodeDatum,
  encodeTreeConfig,
  jcsSha256,
  PlanSchema,
  planLeafFor,
  specHash,
  toCbor,
  verifyCose1,
  type NodeDatum,
  type NodeSpec,
  type Plan,
} from "@cascade/shared";
import { BlockfrostEvaluator, OgmiosClient, ResilientEvaluator, TokenBucket, chainTxFromCbor, ogmiosEvaluator, deriveRoleKey, loadNetworkConfig, toWire, type RoleKey } from "@cascade/service-kit";
import {
  CHILD_ID,
  CONFIG_HASH,
  LOGIC_CORE,
  LOGIC_DRAW,
  NODE_HASH,
  TREE_ID,
  buildTxCbor,
  childDatum,
  createTestDatabase,
  keyAddr,
  keyAddress,
  rootDatum,
  scriptAddress,
  treeConfig,
  type TestDatabase,
} from "@cascade/service-kit/testing";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Signer, type Simulator } from "../src/signer.js";

const YACI = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const ADA = 1_000_000n;
const SCRIPTS = { node: NODE_HASH, config: CONFIG_HASH, logicCore: LOGIC_CORE, logicDraw: LOGIC_DRAW };
const log = pino({ level: "silent" });

const conductor: RoleKey = deriveRoleKey(YACI, 2, "local");
const logKey: RoleKey = deriveRoleKey(YACI, 21, "local");
const SELLER = "33".repeat(28);
const AGENT = `${"67".repeat(28)}01`;

function spec(id: string, maxBudget: bigint, maxFee: bigint, acceptance: NodeSpec["acceptance"]): NodeSpec {
  return {
    version: "1",
    id,
    task: `task ${id}`,
    category: "research",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    acceptance,
    rail: "native",
    price: { asset: "lovelace", max_budget: maxBudget.toString(), max_fee: maxFee.toString() },
    deadlines: { work_ms: 60_000, compose_ms: 60_000, challenge_window_ms: 600_000, dispute_window_ms: 600_000 },
    may_sub_hire: true,
    max_sub_budget_share_bps: 5000,
    verifier: { deterministic: ["schema"], quorum: null, challenge: true, arbitration: false },
  };
}
const rootSpec = spec("root", 100n * ADA, 10n * ADA, "BuyerAccept");
const childSpec = spec("scout", 30n * ADA, 5n * ADA, "ParentAccept");
const planNode = {
  spec: rootSpec,
  agents: { primary: { agent_id: `${"67".repeat(28)}00`, quote_id: null, price: "100000000" }, fallbacks: [] },
  children: [{ spec: childSpec, agents: { primary: { agent_id: AGENT, quote_id: "q", price: "30000000" }, fallbacks: [] }, children: [] }],
};
const plan: Plan = PlanSchema.parse({
  version: "1",
  plan_id: "p1",
  asset: "lovelace",
  limits: { max_depth: 3, max_fanout: 8, max_child_share_bps: 6000, min_challenge_window_ms: 600_000, min_safety_margin_ms: 300_000 },
  root: planNode,
  totals: { budget: "100000000", fees: "15000000", structural_lovelace: "10000000", reserve: "0" },
  deadlines: { fund_by: 1, submit_by: 2, challenge_until: 3, refund_after: 4, dispute_until: 5 },
  plan_root: computePlanRoot(planNode),
});
const cfg = treeConfig({ plan_root: plan.plan_root });
const root: NodeDatum = rootDatum({ operator: conductor.paymentKeyHash, payee: keyAddr(conductor.paymentKeyHash), spec_hash: specHash(rootSpec), budget: 100n * ADA, fee: 10n * ADA, structural: 10n * ADA });
const ROOT_REF = `${"aa".repeat(32)}#0`;
const WALLET_REF = `${"bb".repeat(32)}#1`;

let db: TestDatabase;
// The Draw fixture's wallet input belongs to the conductor and funds its 5 ADA change and the fee.
const walletInputs = async (refs: string[]) =>
  new Map(refs.filter((r) => r === WALLET_REF).map((r) => [r, { address: conductor.address, lovelace: 6n * ADA, assets: {} }]));
let signer: Signer;
const units = { memory: 3_000_000n, cpu: 900_000_000n };
const sim: Simulator = { evaluate: async () => units };

function drawCbor(childOver: Partial<NodeDatum> = {}, extraOut = false, rootRef = ROOT_REF): string {
  const child = childDatum({ operator: SELLER, payee: keyAddr(SELLER), spec_hash: specHash(childSpec), budget: 30n * ADA, fee: 5n * ADA, structural: 2n * ADA, acceptance: { type: "ParentAccept", key: conductor.paymentKeyHash }, ...childOver });
  const inputs = [rootRef, WALLET_REF].sort();
  const root1 = { ...root, committed: child.budget, children_open: 1n, next_child: 1n, structural: 8n * ADA };
  const actions = [
    {
      type: "Draw" as const,
      node_in: BigInt(inputs.indexOf(rootRef)),
      node_out: 0n,
      config_ref: 0n,
      root_ref: null,
      children: [{ out: 1n, external_out: null, leaf: planLeafFor(childSpec, rootSpec), proof: [] }],
    },
  ];
  return buildTxCbor({
    inputs,
    outputs: [
      { address: scriptAddress(NODE_HASH), lovelace: 78n * ADA, assets: { [`${NODE_HASH}.${TREE_ID}`]: 1n }, datum: encodeNodeDatum(root1) },
      { address: scriptAddress(NODE_HASH), lovelace: child.budget + child.structural, assets: { [`${NODE_HASH}.${CHILD_ID}`]: 1n }, datum: encodeNodeDatum(child) },
      { address: conductor.address, lovelace: 5n * ADA },
      ...(extraOut ? [{ address: keyAddress("99".repeat(28)), lovelace: 2n * ADA }] : []),
    ],
    fee: 400_000n,
    mint: { [`${NODE_HASH}.${CHILD_ID}`]: 1n },
    withdrawals: [{ scriptHash: LOGIC_DRAW, amount: 0n }],
    redeemers: [{ tag: 3, index: 0, data: toCbor(new Constr(0, [NODE_HASH, actionsToData(actions)])) }],
    requiredSigners: [conductor.paymentKeyHash],
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  const q = (sql: string, params: unknown[]) => db.pool.query(sql, params);
  await q(
    `INSERT INTO node_utxos (out_ref, kind, node_id, tree_id, tx_id, slot, seq, datum, datum_cbor, lovelace, assets) VALUES
     ($1, 'node', $2, $2, $3, 10, 0, $4, $5, 110000000, '{}'), ($6, 'config', $2, $2, $3, 10, 1, $7, $8, 2000000, '{}')`,
    [ROOT_REF, TREE_ID, "aa".repeat(32), JSON.stringify(toWire(root)), encodeNodeDatum(root), `${"aa".repeat(32)}#1`, JSON.stringify(toWire(cfg)), encodeTreeConfig(cfg)],
  );
  await q("INSERT INTO plans (plan_id, tree_id, plan_root, json, version, policy) VALUES ($1, $2, $3, $4, 1, $5)", [
    "p1",
    TREE_ID,
    plan.plan_root,
    JSON.stringify(plan),
    JSON.stringify({
      version: "1",
      slippage_bps: 100,
      reputation_floor: { score: 0.3, confidence: 0 },
      allowed_rails: ["native", "masumi"],
      blocklist: [],
      velocity: { window_ms: 3_600_000, per_tree_limit: "50000000", per_agent_limit: "1000000000" },
      ex_units: { memory: "14000000", cpu: "10000000000" },
    }),
  ]);
  await q("INSERT INTO agents (agent_asset_id, name, api_url, payment_vkh, allowlisted) VALUES ($1, 'Scout', 'http://127.0.0.1:1', $2, true)", [AGENT, SELLER]);
  signer = new Signer({ pool: db.pool, scripts: SCRIPTS, keys: new Map([["conductor", conductor]]), logKey, simulator: sim, resolveInputs: walletInputs, abuseList: [], log });
});
afterAll(async () => {
  await db.drop();
});

describe("signer", () => {
  it("signs a plan-conformant Draw and returns a witness that verifies against the body hash", async () => {
    const cbor = drawCbor();
    const r = await signer.sign("conductor", cbor);
    expect(r.decision).toBe("allow");
    if (r.decision !== "allow") return;
    const signed = chainTxFromCbor(r.signedTx);
    expect(signed.id).toBe(chainTxFromCbor(cbor).id);
    expect(signed.vkeyWitnessHashes).toEqual([conductor.paymentKeyHash]);
    const w = CML.Vkeywitness.from_cbor_hex(r.witness);
    expect(w.vkey().verify(Buffer.from(r.txBodyHash, "hex"), w.ed25519_signature())).toBe(true);
  });

  it("writes one signed gate log row per touched node for every decision", async () => {
    const { rows } = await db.pool.query<{ node_id: string; decision: string; signature: string; key: string; body: Record<string, unknown> }>(
      "SELECT node_id, decision, signature, key, body FROM gate_logs ORDER BY log_id",
    );
    expect(rows.map((r) => r.node_id).sort()).toEqual([CHILD_ID, TREE_ID].sort());
    const row = rows[0]!;
    expect(row.decision).toBe("allow");
    expect(verifyCose1({ signature: row.signature, key: row.key }, { payload: jcsSha256(row.body), address: logKey.address }).ok).toBe(true);
    expect(JSON.stringify(row.body)).not.toContain("test test");
  });

  it("denies and logs a Draw over the approved price; no witness is produced", async () => {
    const r = await signer.sign("conductor", drawCbor({ budget: 31n * ADA }));
    expect(r.decision).toBe("deny");
    // Gate 7 also trips: 30 ADA were already drawn in this window by the allowed Draw above.
    expect(r.report?.gates.filter((g) => !g.passed).map((g) => g.gate)).toEqual([2, 7]);
    expect("witness" in r).toBe(false);
    const { rows } = await db.pool.query("SELECT 1 FROM gate_logs WHERE decision = 'deny' AND tx_body_hash = $1", [r.txBodyHash]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("denies an extra output and enforces velocity across signatures", async () => {
    expect((await signer.sign("conductor", drawCbor({}, true))).report?.gates[0]?.passed).toBe(false);
    // 30 ADA already drawn under the allow above; another 30 breaks the 50 ADA per-tree window.
    const again = await signer.sign("conductor", drawCbor({ input_hash: "0f".repeat(32) }));
    expect(again.decision).toBe("deny");
    expect(again.report?.gates.filter((g) => !g.passed).map((g) => g.gate)).toEqual([7]);
  });

  // Regression: the plan root covers specs only, so a second buyer's identical plan shares it. The
  // signer read the newest row for the root, and a local tree funded with a floor of 50 was refused
  // at gate 3 under another tree's floor of 60.
  it("applies this tree's buyer policy when another tree registered the same plan root", async () => {
    const strict = { version: "1", slippage_bps: 100, reputation_floor: { score: 0.9, confidence: 0 }, allowed_rails: ["native", "masumi"], blocklist: [], velocity: { window_ms: 3_600_000, per_tree_limit: "50000000", per_agent_limit: "1000000000" }, ex_units: { memory: "14000000", cpu: "10000000000" } };
    await db.pool.query("INSERT INTO plans (plan_id, tree_id, plan_root, json, version, policy) VALUES ('p-other', $1, $2, $3, 2, $4)", ["ee".repeat(28), plan.plan_root, JSON.stringify(plan), JSON.stringify(strict)]);
    try {
      const r = await signer.sign("conductor", drawCbor({ input_hash: "0e".repeat(32) }));
      expect(r.report?.gates.find((g) => g.gate === 3)?.passed).toBe(true);
    } finally {
      await db.pool.query("DELETE FROM plans WHERE plan_id = 'p-other'");
    }
  });

  it("refuses roles it holds no key for, over HTTP with a bearer token", async () => {
    const app = createApp(signer, db.pool, log, "s3cret");
    expect((await app.request("/v1/sign", { method: "POST", body: JSON.stringify({ role: "conductor", tx_cbor: drawCbor() }) })).status).toBe(403);
    const res = await app.request("/v1/sign", { method: "POST", headers: { authorization: "Bearer s3cret" }, body: JSON.stringify({ role: "treasury", tx_cbor: drawCbor() }) });
    expect(res.status).toBe(404);
    const logs = await app.request(`/v1/gate-logs?tree_id=${TREE_ID}`);
    expect(((await logs.json()) as { logs: unknown[] }).logs.length).toBeGreaterThan(0);
  });

  describe("inputs the indexer has not caught up with", () => {
    const insertRoot = (ref: string, spentTx: string | null) =>
      db.pool.query(
        `INSERT INTO node_utxos (out_ref, kind, node_id, tree_id, tx_id, slot, seq, datum, datum_cbor, lovelace, assets, spent_tx)
         VALUES ($1, 'node', $2, $2, $3, 11, 0, $4, $5, 110000000, '{}', $6)`,
        [ref, TREE_ID, ref.split("#")[0], JSON.stringify(toWire(root)), encodeNodeDatum(root), spentTx],
      );
    const waiting = (onSleep: () => Promise<void> = async () => {}) => {
      const sleeps: number[] = [];
      const s = new Signer({
        pool: db.pool,
        scripts: SCRIPTS,
        keys: new Map([["conductor", conductor]]),
        logKey,
        simulator: sim,
        resolveInputs: walletInputs,
        abuseList: [],
        log,
        indexWaitMs: 3_000,
        sleep: async (ms) => {
          sleeps.push(ms);
          await onSleep();
        },
      });
      return { s, sleeps };
    };

    it("waits for a node output the indexer adds during the wait, then evaluates the gates as usual", async () => {
      const ref = `${"c1".repeat(32)}#0`;
      const { s, sleeps } = waiting(async () => {
        if (sleeps.length === 2) await insertRoot(ref, null);
      });
      const r = await s.sign("conductor", drawCbor({ input_hash: "c2".repeat(32) }, false, ref));
      expect(sleeps).toEqual([1_000, 1_000]);
      expect("code" in r).toBe(false);
      expect(r.report?.gates[0]?.passed).toBe(true);
    });

    it("answers input_not_indexed with no signature and no gate log when the input never appears", async () => {
      const ref = `${"d1".repeat(32)}#0`;
      const { s, sleeps } = waiting();
      const r = await s.sign("conductor", drawCbor({}, false, ref));
      expect(sleeps).toEqual([1_000, 1_000, 1_000]);
      expect(r).toEqual({ decision: "deny", txBodyHash: r.txBodyHash, gateLogIds: [], report: null, error: `input_not_indexed: input ${ref} is not indexed yet`, code: "input_not_indexed" });
      const { rows } = await db.pool.query("SELECT 1 FROM gate_logs WHERE tx_body_hash = $1", [r.txBodyHash]);
      expect(rows).toHaveLength(0);

      const app = createApp(s, db.pool, log, "s3cret");
      const res = await app.request("/v1/sign", { method: "POST", headers: { authorization: "Bearer s3cret" }, body: JSON.stringify({ role: "conductor", tx_cbor: drawCbor({}, false, ref) }) });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        decision: "deny",
        code: "input_not_indexed",
        retryable: true,
        tx_body_hash: r.txBodyHash,
        gate_log_ids: [],
        gates: [],
        reasons: ["input_not_indexed"],
        error: `input_not_indexed: input ${ref} is not indexed yet`,
      });
    });

    it("refuses at gate 1 without waiting when the indexer knows the input's transaction but the node is spent", async () => {
      const ref = `${"e1".repeat(32)}#0`;
      await insertRoot(ref, "e2".repeat(32));
      const { s, sleeps } = waiting();
      const r = await s.sign("conductor", drawCbor({}, false, ref));
      expect(sleeps).toEqual([]);
      expect(r.decision).toBe("deny");
      expect("code" in r).toBe(false);
      expect(r.report?.gates[0]?.passed).toBe(false);
      expect(r.report?.gates[0]?.detail.join(" ")).toMatch(/not a known Cascade node/);
      const app = createApp(s, db.pool, log, "s3cret");
      const res = await app.request("/v1/sign", { method: "POST", headers: { authorization: "Bearer s3cret" }, body: JSON.stringify({ role: "conductor", tx_cbor: drawCbor({}, false, ref) }) });
      expect(res.status).toBe(403);
      expect(sleeps).toEqual([]);
    });
  });

  it("answers evaluator_unavailable (HTTP 503, retryable, no gate log) when no evaluation provider answers", async () => {
    const down = new Signer({
      pool: db.pool,
      scripts: SCRIPTS,
      keys: new Map([["conductor", conductor]]),
      logKey,
      simulator: {
        evaluate: () =>
          new ResilientEvaluator([ogmiosEvaluator("koios", new OgmiosClient("http://koios.test/ogmios", { fetch: (async () => new Response("Too Many Requests", { status: 429 })) as unknown as typeof fetch }))], {
            bucket: new TokenBucket(100, 100),
            sleep: async () => {},
          })
            .evaluate("84")
            .then(() => units),
      },
      resolveInputs: walletInputs,
      abuseList: [],
      log,
    });
    const tx = drawCbor({ input_hash: "5e".repeat(32) });
    const r = await down.sign("conductor", tx);
    expect(r.decision).toBe("deny");
    expect(r).toMatchObject({ gateLogIds: [], report: null, code: "evaluator_unavailable" });
    expect(r.decision === "deny" ? r.error : "").toMatch(/^evaluator_unavailable: .*HTTP 429/);
    const { rows } = await db.pool.query("SELECT 1 FROM gate_logs WHERE tx_body_hash = $1", [r.txBodyHash]);
    expect(rows).toHaveLength(0);
    const res = await createApp(down, db.pool, log, "s3cret").request("/v1/sign", { method: "POST", headers: { authorization: "Bearer s3cret" }, body: JSON.stringify({ role: "conductor", tx_cbor: tx }) });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ decision: "deny", code: "evaluator_unavailable", retryable: true, gate_log_ids: [], reasons: ["evaluator_unavailable"] });
  });

  it("gate 8 through the failover evaluator: a dead provider fails over to the real Ogmios, whose script failure is still a final gate 8 refusal", async () => {
    const ogmios = new OgmiosClient(loadNetworkConfig("local").ogmiosHttp);
    const dead = new BlockfrostEvaluator("http://bf.test", null, { fetch: (async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch });
    const evaluator = new ResilientEvaluator([dead, ogmiosEvaluator("ogmios", ogmios)], { bucket: new TokenBucket(100, 100), sleep: async () => {} });
    const real = new Signer({
      pool: db.pool,
      scripts: SCRIPTS,
      keys: new Map([["conductor", conductor]]),
      logKey,
      simulator: {
        async evaluate(cbor) {
          const r = await evaluator.evaluate(cbor);
          return { memory: r.reduce((s, x) => s + x.budget.memory, 0n), cpu: r.reduce((s, x) => s + x.budget.cpu, 0n) };
        },
      },
      resolveInputs: walletInputs,
      abuseList: [],
      log,
    });
    const r = await real.sign("conductor", drawCbor({ input_hash: "2f".repeat(32) }));
    expect(r.decision).toBe("deny");
    expect("code" in r && r.code !== undefined).toBe(false);
    expect(r.gateLogIds.length).toBeGreaterThan(0);
    expect(r.report?.gates[7]?.passed).toBe(false);
    expect(r.report?.gates[7]?.detail[0]).toMatch(/evaluation failed/);
  });

  it("gate 8 on the real Ogmios: a transaction whose scripts cannot evaluate is denied", async () => {
    const ogmios = new OgmiosClient(loadNetworkConfig("local").ogmiosHttp);
    const real = new Signer({
      pool: db.pool,
      scripts: SCRIPTS,
      keys: new Map([["conductor", conductor]]),
      logKey,
      simulator: {
        async evaluate(cbor) {
          const r = await ogmios.evaluate(cbor);
          return { memory: r.reduce((s, x) => s + x.budget.memory, 0n), cpu: r.reduce((s, x) => s + x.budget.cpu, 0n) };
        },
      },
      resolveInputs: walletInputs,
      abuseList: [],
      log,
    });
    const r = await real.sign("conductor", drawCbor({ input_hash: "1f".repeat(32) }));
    expect(r.decision).toBe("deny");
    const g8 = r.report?.gates[7];
    expect(g8?.passed).toBe(false);
    expect(g8?.detail[0]).toMatch(/evaluation failed/);
  });
});
