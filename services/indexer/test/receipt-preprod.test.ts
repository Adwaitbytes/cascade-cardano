/**
 * Invariant 1 on a real tree: replays preprod tree ade682..., the main tree of the 2026-10-06 redeemer
 * showcase on the tagged deployment in deployments/preprod.json (demo/out/redeemers.json), from
 * Blockfrost into a throwaway database and checks the served receipt the way the explorer does. The
 * tree exercises fund, top-up, freeze, native and receipt draws, settle, challenge, escalate,
 * resolve, refund, both receipt closes and the root close. For an ADA tree, deposits (budget plus
 * structural ADA in) must equal payouts plus refunds plus protocol fees plus structural ADA returned,
 * to the lovelace. The tree must be one made with the script hashes in deployments/preprod.json:
 * after a redeploy, point TREE and TXS at a closed tree of the new deployment.
 */
import { BlockfrostClient, chainTxFromBlockfrost, deriveRoleKey, loadEnv, loadNetworkConfig, withTransaction, type CascadeScripts } from "@cascade/service-kit";
import { createTestDatabase, type TestDatabase } from "@cascade/service-kit/testing";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { applyBlockTxs } from "../src/follower.js";
import { recordPoint } from "../src/store.js";

const TREE = "ade682cb5f8e007cb68584a35f8696b78f36d4c32b29fdda7cfad206";
/** Every transaction of the tree, in chain order (block heights 5260531 to 5260565). */
const TXS = [
  "a4d28ac98a371dd43eadf8cef3ca2c6f417dd07bc05e90a2ce48d5c402708cdf", // FundRoot
  "ee128e5a67ea46d4f64e13a256b7d112bba069723eb4d1978b69d9d750f8c54a", // TopUp
  "a5cb0366affa6e4bd45d41b1f6eec9f5a6b925d07da98af065b8786d47b5370a", // Freeze
  "d96f602ad290cdb85cc3435d555adbc35419f6d150af397533a04a2a582e0e40", // Unfreeze
  "21514966fb1f80d33ee8037c6f74b33e9a3add9ff9ccf5d9744ebba9ed28eec9", // Draw (three native children)
  "fb9bab1e94b957010bf332c4ade622d16add47911e5e7ac4be96e0f2a70918ae", // Draw (Metered and Masumi receipts)
  "ae62495eb1dde7be1ef1ff444efe1e25cd69638f2831984e5bf86496d36decfd", // Submit (Scout)
  "e3d8013ea393b1487aaebd72aa2204ddf26ff56bd39ffcb94014e03ce6a8eb47", // Accept (Scout)
  "da37ee899e391eb1d515bc187f04b7a6ae2c177d094c13ca4a51fe3ea95aae4f", // SettleChild (Scout)
  "760fdb8d2a4b6676753434c0e662db8cd5018a68c101e16e04866a0f6d3b4c3c", // Submit (Pricer)
  "d784c83542101a7ce7947fd82ff5389f65822dce11abdf918e8b03dda53bc480", // Challenge (Pricer)
  "3a45f8f2af4c0ca6a4e1adfec716a487a403f24ae1374bda8023807dbd1746bb", // Escalate (Pricer)
  "baf314d8b9d6f363ca021bef105fab3d2008cf0febb4837fc001c02adbc742f2", // Resolve (Pricer)
  "1db9f31149273c8096ef33708e50deadd3a5757bde58fe3916ad5685deebec48", // CloseReceipt (Metered)
  "fb8280c71a523c5d423af87edc355f191feea126ba1e1722d514e66a279d6472", // Refund (Flaky Lisan)
  "a789a7acd6338b3d8e95b10a3858c23baa63b19d6541b8430c8cee55be61da90", // Masumi vested_pay refund
  "2f419757cafdfaa2e6da23968d2bc55dcc0c9428db2fe16c9098df744e270182", // CloseReceipt (Masumi)
  "7edb32759e285e2375e71cf8723339f5e632f7620e5027c3e75ea6392de79bbd", // Submit (root)
  "931fe08706418ace7330b1c9218b55a1f1897b2d3debdb9ce40e0b012be75636", // Accept (root)
  "69720f3162300f9b04febd20723a5f3d51135504c3b5d62f404fcc1b9dbc9df0", // CloseRoot
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

describe("receipt reconciliation on preprod tree ade682", () => {
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
    // 21 ADA budget (20 at fund, 1 top-up) plus 27.33163 ADA structural (24 ADA root reserve plus
    // the config output's 3.33163 ADA min-ADA, both read from the FundRoot outputs) went in.
    expect(r.deposits.amount).toBe("48331630");
    const accounted = BigInt(r.payouts.amount) + BigInt(r.refunds.amount) + BigInt(r.fees.amount) + BigInt(r.structural_returned_lovelace);
    expect(BigInt(r.deposits.amount) - accounted).toBe(0n);
    expect(r.balanced).toBe(true);
  });
});
