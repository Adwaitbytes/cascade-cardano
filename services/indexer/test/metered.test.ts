/**
 * Metered channel accounting: a Draw opens a channel for a metered receipt, two provider Redeems
 * continue it, and the node view reports calls, total paid, L1 transactions and remaining deposit.
 */
import { encodeNodeDatum, type NodeDatum } from "@cascade/shared";
import { chainTxFromCbor, encodeChannelDatum, withTransaction, type ChannelDatum } from "@cascade/service-kit";
import { NODE_HASH, TREE_ID, buildTxCbor, childDatum, createTestDatabase, keyAddr, scriptAddress, type TestDatabase } from "@cascade/service-kit/testing";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { project } from "../src/projector.js";
import { addressText, applyProjection, backfillMasumiIdentifiers, loadConfigs, loadTracked } from "../src/store.js";
import { SCRIPTS as BASE, lifecycle } from "./scenario.js";

const CHANNEL = "c7".repeat(28);
const SCRIPTS = { ...BASE, channel: CHANNEL };
const METER = "9a".repeat(28);
let db: TestDatabase;

async function apply(tx: ReturnType<typeof chainTxFromCbor>, slot: number): Promise<void> {
  await withTransaction(db.pool, async (c) => {
    const tracked = await loadTracked(c, tx.inputs);
    const configs = await loadConfigs(c, [TREE_ID]);
    const p = project(tx, { scripts: SCRIPTS, tracked, configs, addressText });
    await applyProjection(c, p, { slot, hash: slot.toString(16).padStart(64, "0"), height: slot }, 0, 0);
  });
}

const channel = (redeemed: bigint): ChannelDatum => ({
  authority: NODE_HASH,
  tree_id: TREE_ID,
  node_id: METER,
  payer_vkey: "11".repeat(32),
  provider: "44".repeat(28),
  provider_address: keyAddr("44".repeat(28)),
  asset: { policy: "", name: "" },
  deposit: 10_000_000n,
  redeemed,
  timeout: 2_000_000_000_000n,
});
const chanOut = (redeemed: bigint) => ({
  address: scriptAddress(CHANNEL),
  lovelace: 12_000_000n - redeemed,
  assets: { [`${NODE_HASH}.6b${METER}`]: 1n },
  datum: encodeChannelDatum(channel(redeemed)),
});

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

describe("metered channels", () => {
  it("reports calls, paid, L1 transactions and remaining deposit from voucher redeems", async () => {
    const [fund] = lifecycle();
    await apply(fund!.tx, 100);
    const receipt: NodeDatum = childDatum({ node_id: METER, kind: "MeteredReceipt", budget: 10_000_000n, fee: 0n, structural: 2_000_000n, external_lovelace: 2_000_000n });
    const open = chainTxFromCbor(
      buildTxCbor({
        inputs: [`${"e1".repeat(32)}#0`],
        outputs: [{ address: scriptAddress(NODE_HASH), lovelace: 2_000_000n, assets: { [`${NODE_HASH}.${METER}`]: 1n }, datum: encodeNodeDatum(receipt) }, chanOut(0n)],
        fee: 300_000n,
      }),
    );
    await apply(open, 110);
    let prev = `${open.id}#1`;
    for (const [i, redeemed] of [300_000n, 700_000n].entries()) {
      const r = chainTxFromCbor(buildTxCbor({ inputs: [prev, `${"e2".repeat(32)}#${i}`], outputs: [chanOut(redeemed), { address: scriptAddress("44".repeat(28)), lovelace: 1_000_000n }], fee: 200_000n }));
      await apply(r, 120 + i * 10);
      prev = `${r.id}#0`;
    }
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
      views: { slotConfig: { zeroTime: 0, zeroSlot: 0, slotLength: 1000 }, indexedSlot: async () => 130, maxExUnits: async () => ({ memory: 1n, steps: 1n }) },
    });
    const detail = (await (await app.request(`/v1/trees/${TREE_ID}/nodes/${METER}`)).json()) as { metered: unknown };
    // No buyer plan is stored for this tree, so the per-call price is unknown and calls is 0.
    expect(detail.metered).toEqual({ calls: 0, paid: { asset: "lovelace", amount: "700000" }, l1_txs: 3, remaining: { asset: "lovelace", amount: "9300000" } });
    const foreign = chainTxFromCbor(buildTxCbor({ inputs: [`${"e3".repeat(32)}#0`], outputs: [{ ...chanOut(0n), datum: encodeChannelDatum({ ...channel(0n), authority: "ff".repeat(28) }) }], fee: 1n }));
    expect(project(foreign, { scripts: SCRIPTS, tracked: new Map(), configs: new Map(), addressText }).createdChannels).toEqual([]);
  });

  it("backfills a Masumi receipt's blockchainIdentifier from its lock output", async () => {
    const RECEIPT = "6e".repeat(28);
    const receipt = childDatum({ node_id: RECEIPT, kind: "MasumiReceipt", budget: 5_000_000n, fee: 0n });
    const open = chainTxFromCbor(
      buildTxCbor({
        inputs: [`${"e4".repeat(32)}#0`],
        outputs: [{ address: scriptAddress(NODE_HASH), lovelace: 2_000_000n, assets: { [`${NODE_HASH}.${RECEIPT}`]: 1n }, datum: encodeNodeDatum(receipt) }],
        fee: 300_000n,
      }),
    );
    await apply(open, 200);
    await db.pool.query("UPDATE nodes SET external_ref = $2 WHERE node_id = $1", [RECEIPT, `${"e5".repeat(32)}#1`]);
    const seen: string[] = [];
    const filled = await backfillMasumiIdentifiers(
      db.pool,
      async (ref) => (seen.push(ref), { address: "addr_test1x", lovelace: 1n, assets: {}, datum: "d87980", datumHash: null, hasScriptRef: false, size: null }),
      () => "ab12",
    );
    expect(filled).toBe(1);
    expect(seen).toEqual([`${"e5".repeat(32)}#1`]);
    const row = await db.pool.query<{ masumi_identifier: string }>("SELECT masumi_identifier FROM nodes WHERE node_id = $1", [RECEIPT]);
    expect(row.rows[0]?.masumi_identifier).toBe("ab12");
  });
});
