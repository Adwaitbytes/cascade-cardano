/**
 * A TopUp is a second `tree.funded` and must carry the same strict PRD 17.3 payload as the funding
 * (plan_root, config_utxo), or the explorer rejects the tree. The node's tx list still names it
 * TopUp. Rows stored before the fix are backfilled by migration 13.
 */
import { CascadeEventSchema, encodeTreeConfig } from "@cascade/shared";
import { MIGRATIONS, outRef, withTransaction } from "@cascade/service-kit";
import { CONFIG_HASH, LOGIC_CORE, NODE_HASH, TREE_ID, createTestDatabase, rootDatum, scriptAddress, treeConfig, type TestDatabase } from "@cascade/service-kit/testing";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { applyBlockTxs } from "../src/follower.js";
import { eventsByIds, recordPoint, toCascadeEvent } from "../src/store.js";
import { SCRIPTS, nodeOut, tx, walletIn } from "./scenario.js";

const ADA = 1_000_000n;
const cfg = treeConfig();
const root0 = rootDatum({ budget: 100n * ADA, fee: 10n * ADA, structural: 10n * ADA });
const configOut = { address: scriptAddress(CONFIG_HASH), lovelace: 2n * ADA, assets: { [`${NODE_HASH}.63${TREE_ID}`]: 1n }, datum: encodeTreeConfig(cfg), datumHash: null, hasScriptRef: false, size: null };
const fund = tx(1, [walletIn(1)], [nodeOut(root0), configOut], [{ type: "FundRoot", seed: { transaction_id: "f".repeat(64), output_index: 0n }, root_out: 0n, config_out: 1n }], LOGIC_CORE, {
  [`${NODE_HASH}.${TREE_ID}`]: 1n,
  [`${NODE_HASH}.63${TREE_ID}`]: 1n,
});
const topInputs = [outRef(fund.id, 0), walletIn(2)].sort();
const topUp = tx(2, topInputs, [nodeOut({ ...root0, budget: 105n * ADA })], [{ type: "TopUp", node_in: BigInt(topInputs.indexOf(outRef(fund.id, 0))), node_out: 0n, amount: 5n * ADA }], LOGIC_CORE);

let db: TestDatabase;
const block = (slot: number) => ({ slot, hash: slot.toString(16).padStart(64, "0"), height: slot });
async function apply(t: typeof fund, slot: number): Promise<number[]> {
  return withTransaction(db.pool, async (c) => {
    const ids = await applyBlockTxs(c, [t], block(slot), SCRIPTS, 0);
    await recordPoint(c, block(slot), 100);
    return ids;
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

describe("tree.funded on TopUp", () => {
  it("carries plan_root and config_utxo like the funding event and parses strictly", async () => {
    const ids = [...(await apply(fund, 100)), ...(await apply(topUp, 110))];
    const events = (await eventsByIds(db.pool, ids)).map((r) => toCascadeEvent(r, 200)).filter((e) => e.type === "tree.funded");
    expect(events).toHaveLength(2);
    for (const e of events) expect(CascadeEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
    expect(events.map((e) => e.payload)).toEqual([
      { plan_root: cfg.plan_root, config_utxo: outRef(fund.id, 1) },
      { plan_root: cfg.plan_root, config_utxo: outRef(fund.id, 1) },
    ]);
    expect(events.map((e) => e.value.amount)).toEqual([(100n * ADA).toString(), (5n * ADA).toString()]);
  });

  it("still labels the top-up transaction TopUp in node detail", async () => {
    const app = createApi({
      pool: db.pool,
      scripts: SCRIPTS,
      oracle: null,
      log: pino({ level: "silent" }),
      tipHeight: async () => 200,
      tipSlot: async () => 200,
      horizonSlots: 300,
      adminToken: null,
      decimalsOf: () => 6,
      health: () => ({}),
      views: { slotConfig: { zeroTime: 0, zeroSlot: 0, slotLength: 1000 }, indexedSlot: async () => 110, maxExUnits: async () => ({ memory: 1n, steps: 1n }) },
    });
    const detail = (await (await app.request(`/v1/trees/${TREE_ID}/nodes/${TREE_ID}`)).json()) as { txs: { tx_id: string; action: string }[] };
    expect(Object.fromEntries(detail.txs.map((t) => [t.tx_id, t.action]))).toEqual({ [fund.id]: "FundRoot", [topUp.id]: "TopUp" });
  });

  it("backfills rows stored with the old {top_up: true} payload (migration 13)", async () => {
    await db.pool.query("UPDATE node_events SET payload = jsonb_build_object('top_up', true, '_flows', payload->'_flows') WHERE tx_id = $1 AND type = 'tree.funded'", [topUp.id]);
    const backfill = MIGRATIONS.find((x) => x.id === 13);
    if (backfill === undefined) throw new Error("migration 13 is missing");
    await db.pool.query(backfill.sql);
    const { rows } = await db.pool.query<{ payload: Record<string, unknown> }>("SELECT payload FROM node_events WHERE tx_id = $1 AND type = 'tree.funded'", [topUp.id]);
    expect(rows[0]?.payload).toMatchObject({ plan_root: cfg.plan_root, config_utxo: outRef(fund.id, 1) });
    expect(rows[0]?.payload).not.toHaveProperty("top_up");
    expect(rows[0]?.payload).toHaveProperty("_flows");
  });
});
