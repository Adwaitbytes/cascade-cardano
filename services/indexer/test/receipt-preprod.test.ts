/**
 * Invariant 1 on a real tree: replays preprod tree be6854... (fund, draw, child refund, submit,
 * accept, close) from Blockfrost into a throwaway database and checks the served receipt the way the
 * explorer does: for an ADA tree, deposits (budget plus structural ADA in) must equal payouts plus
 * refunds plus protocol fees plus structural ADA returned, to the lovelace.
 */
import { BlockfrostClient, chainTxFromBlockfrost, deriveRoleKey, loadEnv, loadNetworkConfig, withTransaction, type CascadeScripts } from "@cascade/service-kit";
import { createTestDatabase, type TestDatabase } from "@cascade/service-kit/testing";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { applyBlockTxs } from "../src/follower.js";
import { recordPoint } from "../src/store.js";

const TREE = "be685438765292c4d7c58e40635599e64a0f17dfad46024889101b62";
const TXS = [
  "765179237c07ad5e346262e4750e85be7ab9f743e6fdb0b5353aa6fd2fa8136f",
  "794030135ce80d352e3fd3cc53e44662e787a7f521903519efbca34476abf7ae",
  "c24c683d0f1ba61f2ca3da9d0e550f89e2b56d6a5c79203d8acc3bb20d23a01f",
  "f8b1a8ac3b7c43c122f24657218eac0eaa09d24af0d6575a623fb86defb0fb56",
  "e5c03a113678c234e9d632f54eda3b697eda6dcc3e0bb99dba77c837e2b35c42",
  "98ca6753611c627b85051cddcc3ab922d9142e0684161f7249692e1079c5f89e",
];

loadEnv();
const cfg = loadNetworkConfig("preprod");
let db: TestDatabase;

beforeAll(async () => {
  if (cfg.blockfrostUrl === null || cfg.blockfrostProjectId === null) throw new Error("prerequisite: BLOCKFROST_PROJECT_ID_PREPROD must be set in .env for the preprod receipt replay");
  if (cfg.scripts.node === null) throw new Error("prerequisite: deployments/preprod.json must name the cascade_node hash");
  db = await createTestDatabase();
  const scripts: CascadeScripts = { ...cfg.scripts, node: cfg.scripts.node };
  const bf = new BlockfrostClient(cfg.blockfrostUrl, cfg.blockfrostProjectId);
  for (const id of TXS) {
    const t = await chainTxFromBlockfrost(bf, id);
    if (t === null) throw new Error(`preprod tx ${id} not found`);
    const block = await bf.blockAt(t.height);
    if (block === null) throw new Error(`block ${t.height} not found`);
    const ref = { slot: block.slot, hash: block.hash, height: block.height };
    await withTransaction(db.pool, async (c) => {
      await applyBlockTxs(c, [t.tx], ref, scripts, 0);
      await recordPoint(c, ref, 100);
    });
  }
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

describe("receipt reconciliation on preprod tree be6854", () => {
  it("balances deposits against payouts, refunds, fees and structural ADA returned, to the lovelace", async () => {
    const app = createApi({
      pool: db.pool,
      scripts: null,
      oracle: deriveRoleKey("test test test test test test test test test test test test test test test test test test test test test test test sauce", 15, "local"),
      log: pino({ level: "silent" }),
      tipHeight: async () => 0,
      tipSlot: async () => 0,
      horizonSlots: 0,
      adminToken: null,
      decimalsOf: () => 6,
      health: () => ({}),
      views: { slotConfig: { zeroTime: 0, zeroSlot: 0, slotLength: 1000 }, indexedSlot: async () => 0, maxExUnits: async () => ({ memory: 1n, steps: 1n }) },
    });
    const r = (await (await app.request(`/v1/trees/${TREE}/receipt`)).json()) as {
      deposits: { asset: string; amount: string };
      payouts: { amount: string };
      refunds: { amount: string };
      fees: { amount: string };
      structural_returned_lovelace: string;
      balanced: boolean;
    };
    expect(r.deposits.asset).toBe("lovelace");
    // 30 ADA budget plus 9.49972 ADA structural (root reserve plus config min-ADA) went in.
    expect(r.deposits.amount).toBe("39499720");
    const accounted = BigInt(r.payouts.amount) + BigInt(r.refunds.amount) + BigInt(r.fees.amount) + BigInt(r.structural_returned_lovelace);
    expect(BigInt(r.deposits.amount) - accounted).toBe(0n);
    expect(r.balanced).toBe(true);
  });
});
