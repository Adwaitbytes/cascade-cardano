/**
 * PRD 12.4 (A17): every reputation snapshot publishes its inputs, and `reputationFromInputs` over
 * chain outcomes plus those inputs reproduces the anchored root exactly. Agent identity is the
 * current registry asset for the operator's key, so a re-registered agent's history merges.
 */
import { PlanSchema, computePlanRoot, specHash, verifyCose1, jcsSha256, type NodeSpec } from "@cascade/shared";
import { deriveRoleKey, withTransaction } from "@cascade/service-kit";
import { CHILD_ID, CHILD_OPERATOR, OPERATOR, TREE_ID, createTestDatabase, type TestDatabase } from "@cascade/service-kit/testing";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { project } from "../src/projector.js";
import { reputationFromInputs, type NodeOutcome, type SnapshotInputs } from "../src/read.js";
import { recomputeReputation, rowsFingerprint, shouldAnchor } from "../src/reputation-job.js";
import { applyProjection, loadConfigs, loadTracked, recordPoint } from "../src/store.js";
import { SCRIPTS, addressText, lifecycle } from "./scenario.js";

const oracle = deriveRoleKey("test test test test test test test test test test test test test test test test test test test test test test test sauce", 15, "local");
const OLD = `${"67".repeat(28)}000000`;
const CURRENT = `${"67".repeat(28)}000001`;
const slotConfig = { zeroTime: 1_700_000_000_000, zeroSlot: 0, slotLength: 1000 };

const spec = (id: string, category: string): NodeSpec => ({
  version: "1",
  id,
  task: id,
  category,
  input_schema: { type: "object" },
  output_schema: { type: "object" },
  acceptance: "BuyerAccept",
  rail: "native",
  price: { asset: "lovelace", max_budget: "30000000", max_fee: "5000000" },
  deadlines: { work_ms: 60_000, compose_ms: 1_000, challenge_window_ms: 20_000, dispute_window_ms: 20_000 },
  may_sub_hire: false,
  max_sub_budget_share_bps: 0,
  verifier: { deterministic: ["schema"], quorum: null, challenge: false, arbitration: false },
});

describe("reputationFromInputs (pure)", () => {
  const outcome = (over: Partial<NodeOutcome>): NodeOutcome => ({
    node_id: "aa".repeat(28),
    tree_id: "bb".repeat(28),
    spec_hash: specHash(spec("w", "research")),
    operator_vkh: "23".repeat(28),
    payee: "addr_test1vq3z6j7q",
    buyer_vkh: "11".repeat(28),
    buyer_stake: null,
    fee: "5000000",
    state: "Settled",
    submitted: true,
    settled_via_settle: true,
    resolved_worker: null,
    fee_paid: "5000000",
    ended_at: 1_700_000_000_000,
    ...over,
  });
  const params = { now: 1_700_000_100_000, half_life_ms: 30 * 24 * 3600 * 1000, v_ref: "1000000000", diversity_cap: 0.6, prior_weight: 5 };

  it("scores a key's whole history under its current registry asset", () => {
    const outcomes = [outcome({}), outcome({ node_id: "ab".repeat(28), buyer_vkh: "12".repeat(28) })];
    const inputs = {
      specs: outcomes.map((o) => ({ node_id: o.node_id, spec_hash: o.spec_hash, spec: spec("w", "research") })),
      agents: [{ operator_vkh: "23".repeat(28), agent_asset_id: CURRENT, registry_asset_tx: null }],
      verdicts: [],
      params,
    };
    const { rows, problems } = reputationFromInputs(inputs, outcomes);
    expect(problems).toEqual([]);
    expect(rows.map((r) => [r.agent_asset_id, r.category, r.nodes_counted])).toEqual([[CURRENT, "research", 2]]);
  });

  it("reports a spec that does not hash to the node's spec_hash and scores it as general", () => {
    const o = outcome({});
    const { rows, problems } = reputationFromInputs({ specs: [{ node_id: o.node_id, spec_hash: o.spec_hash, spec: spec("w", "tampered") }], agents: [], verdicts: [], params }, [o]);
    expect(problems).toHaveLength(1);
    expect(rows[0]?.category).toBe("general");
  });

  it("changes the root when any input changes (the parameters included)", () => {
    const o = outcome({});
    const base = { specs: [], agents: [], verdicts: [], params };
    expect(reputationFromInputs(base, [o]).root).not.toBe(reputationFromInputs({ ...base, params: { ...params, now: params.now + 86_400_000 } }, [o]).root);
  });
});

describe("published snapshot inputs reproduce the anchored root", () => {
  let db: TestDatabase;
  const rootSpec = spec("root", "orchestration");
  const childSpec = spec("child", "research");

  beforeAll(async () => {
    db = await createTestDatabase();
    for (const [i, step] of lifecycle().entries()) {
      await withTransaction(db.pool, async (c) => {
        const tracked = await loadTracked(c, step.tx.inputs);
        const configs = await loadConfigs(c, [...new Set([...tracked.values()].map((t) => t.treeId))]);
        const block = { slot: step.slot, hash: step.slot.toString(16).padStart(64, "0"), height: step.slot };
        await applyProjection(c, project(step.tx, { scripts: SCRIPTS, tracked, configs, addressText }), block, 0, i);
        await recordPoint(c, block, 100);
      });
    }
    // The nodes' on-chain spec hashes are these specs' hashes; the plan that holds them belongs to
    // another tree, so only content addressing (not the tree's own plan) finds them.
    await db.pool.query("UPDATE nodes SET spec_hash = $2 WHERE node_id = $1", [TREE_ID, specHash({ ...rootSpec, may_sub_hire: true, max_sub_budget_share_bps: 5000, price: { asset: "lovelace", max_budget: "100000000", max_fee: "10000000" } })]);
    await db.pool.query("UPDATE nodes SET spec_hash = $2 WHERE node_id = $1", [CHILD_ID, specHash(childSpec)]);
    const rootNode = {
      spec: { ...rootSpec, may_sub_hire: true, max_sub_budget_share_bps: 5000, price: { asset: "lovelace", max_budget: "100000000", max_fee: "10000000" } },
      agents: { primary: { agent_id: OLD, quote_id: null, price: "100000000" }, fallbacks: [] },
      children: [{ spec: childSpec, agents: { primary: { agent_id: OLD, quote_id: null, price: "30000000" }, fallbacks: [] }, children: [] }],
    };
    const plan = PlanSchema.parse({
      version: "1",
      plan_id: "other",
      asset: "lovelace",
      limits: { max_depth: 3, max_fanout: 8, max_child_share_bps: 6000, min_challenge_window_ms: 600_000, min_safety_margin_ms: 300_000 },
      root: rootNode,
      totals: { budget: "100000000", fees: "10000000", structural_lovelace: "10000000", reserve: "0" },
      deadlines: { fund_by: 1, submit_by: 2, challenge_until: 3, refund_after: 4, dispute_until: 5 },
      plan_root: computePlanRoot(rootNode),
    });
    await db.pool.query("INSERT INTO plans (plan_id, tree_id, plan_root, json, version) VALUES ('other', $1, $2, $3, 1)", ["cc".repeat(28), "dd".repeat(32), JSON.stringify(plan)]);
    // Scribe re-registered: the old asset is delisted, the current one carries its key.
    await db.pool.query(
      `INSERT INTO agents (agent_asset_id, name, api_url, payment_vkh, allowlisted, registry_tx) VALUES
        ($1, 'Scribe (old)', 'https://a.example', $3, false, NULL),
        ($2, 'Scribe', 'https://a.example', $3, true, $4)`,
      [OLD, CURRENT, CHILD_OPERATOR, "ee".repeat(32)],
    );
  });
  afterAll(async () => {
    await db.drop();
  });

  it("serves the inputs and the pure function over them gives the stored root", async () => {
    const { snapshot } = await recomputeReputation(db.pool, slotConfig, oracle, 1_700_000_500_000);
    if (snapshot === null) throw new Error("no snapshot");
    const { signature, ...body } = snapshot;
    expect(verifyCose1({ signature, key: snapshot.key }, { payload: jcsSha256(body), address: oracle.address }).ok).toBe(true);

    const app = createApi({
      pool: db.pool,
      scripts: SCRIPTS,
      oracle,
      log: pino({ level: "silent" }),
      tipHeight: async () => 0,
      tipSlot: async () => 0,
      horizonSlots: 0,
      adminToken: null,
      decimalsOf: () => 6,
      health: () => ({}),
      views: { slotConfig, indexedSlot: async () => 0, maxExUnits: async () => ({ memory: 1n, steps: 1n }) },
    });
    const res = await app.request(`/v1/reputation/snapshot/${snapshot.snapshot_root}/inputs`);
    expect(res.status).toBe(200);
    const inputs = (await res.json()) as SnapshotInputs;

    // Independent recompute: the published outcomes stand in for chain-derived ones here; they are
    // also checked against the chain mirror below.
    const { root, rows, problems } = reputationFromInputs(inputs, inputs.nodes);
    expect(problems).toEqual([]);
    expect(root).toBe(snapshot.snapshot_root);
    expect(inputs.agents).toEqual([{ operator_vkh: CHILD_OPERATOR, agent_asset_id: CURRENT, registry_asset_tx: "ee".repeat(32) }]);
    expect(rows.map((r) => [r.agent_asset_id, r.category])).toEqual(
      [
        [CURRENT, "research"],
        [OPERATOR, "orchestration"],
      ].sort((a, b) => (`${a[0]}${a[1]}` < `${b[0]}${b[1]}` ? -1 : 1)),
    );
    for (const s of inputs.specs) {
      const onChain = await db.pool.query<{ spec_hash: string }>("SELECT datum->>'spec_hash' AS spec_hash FROM node_utxos WHERE node_id = $1 AND kind = 'node' LIMIT 1", [s.node_id]);
      expect(specHash(s.spec)).toBe(s.spec_hash);
      expect(onChain.rows).toHaveLength(1);
    }
    expect((await app.request(`/v1/reputation/snapshot/${"00".repeat(32)}/inputs`)).status).toBe(404);
  });
});

describe("anchoring only on a change in the scored rows", () => {
  const entry = (score: string) => ({ agent_asset_id: CURRENT, category: "research", score, confidence: "0.200000", delivery_rate: "1.000000", on_time_rate: "1.000000", dispute_loss_rate: "0.000000", verifier_accuracy: null, volume: "5000000", buyer_diversity: 2 });
  const HALF_HOUR = 30 * 60 * 1000;

  it("anchors the first snapshot", () => {
    expect(shouldAnchor(null, { entries: [entry("0.512345")], created_at: 0 })).toBe(true);
  });

  it("ignores decay drift below the fixed rounding, however much time passed", () => {
    expect(shouldAnchor({ entries: [entry("0.512345")], created_at: 0 }, { entries: [entry("0.512349")], created_at: 10 * HALF_HOUR })).toBe(false);
    expect(rowsFingerprint([entry("0.512345")])).toBe(rowsFingerprint([entry("0.512349")]));
  });

  it("anchors a real change, but not within 30 minutes of the last anchor", () => {
    const last = { entries: [entry("0.512345")], created_at: 0 };
    expect(shouldAnchor(last, { entries: [entry("0.612345")], created_at: HALF_HOUR - 1 })).toBe(false);
    expect(shouldAnchor(last, { entries: [entry("0.612345")], created_at: HALF_HOUR })).toBe(true);
    expect(shouldAnchor(last, { entries: [entry("0.512345"), { ...entry("0.4"), category: "writing" }], created_at: HALF_HOUR })).toBe(true);
  });
});
