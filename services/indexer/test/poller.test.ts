/**
 * The Blockfrost poller (preprod mode) against Yaci Store's Blockfrost-compatible API must produce
 * the same trees, nodes and events as the Ogmios chain-sync follower over the same real chain
 * history. The test seeds its own history first (a tree funded and topped up on the devnet's
 * recorded deployment, redeployed first when contracts/plutus.json changed) and fails with a
 * prerequisite message when the deployment is missing.
 * Both paths start at the block before the seed: replaying the devnet from origin grows by a block
 * a second and, under parallel suites, ran past Yaci Store's request timeouts.
 */
import { BlockfrostClient, loadNetworkConfig, type CascadeScripts } from "@cascade/service-kit";
import { assertYaciStoreFresh, createTestDatabase, healYaciStore, type TestDatabase } from "@cascade/service-kit/testing";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Follower } from "../src/follower.js";
import { BlockfrostPoller } from "../src/poller.js";
import { ensureLocalDeployment, seedTree } from "./seed.js";

const cfg = loadNetworkConfig("local");
const log = pino({ level: "silent" });
/** Read after ensureLocalDeployment: a redeploy changes every hash. */
let SCRIPTS: CascadeScripts;
const bf = new BlockfrostClient(cfg.blockfrostUrl ?? "", null);
let a: TestDatabase;
let b: TestDatabase;
let seeded: { treeId: string; txIds: string[] };

// A wedged Yaci Store takes a restart and a catch-up (about a minute) on top of the seed.
beforeAll(async () => {
  await healYaciStore(cfg.ogmiosHttp, cfg.blockfrostUrl);
  await assertYaciStoreFresh(cfg.ogmiosHttp, cfg.blockfrostUrl);
  await ensureLocalDeployment();
  const deployed = loadNetworkConfig("local").scripts;
  if (deployed.node === null) throw new Error("prerequisite: the local deployment names no cascade_node hash");
  SCRIPTS = { ...deployed, node: deployed.node };
  [a, b] = await Promise.all([createTestDatabase(), createTestDatabase()]);
  seeded = await seedTree();
}, 900_000);
afterAll(async () => {
  await Promise.all([a.drop(), b.drop()]);
});

/** State of one tree as of a fixed slot, so blocks other agents add later cannot change it. */
async function snapshot(db: TestDatabase, treeId: string, maxSlot: number) {
  const nodes = await db.pool.query(
    `SELECT DISTINCT ON (node_id) node_id, out_ref, datum FROM node_utxos
      WHERE tree_id = $1 AND kind = 'node' AND slot <= $2 ORDER BY node_id, slot DESC, seq DESC`,
    [treeId, maxSlot],
  );
  const trees = await db.pool.query("SELECT tree_id, plan_root, created_slot FROM trees WHERE tree_id = $1", [treeId]);
  const events = await db.pool.query(
    "SELECT type, node_id, tx_id, slot, value_delta, payload FROM node_events WHERE tree_id = $1 AND NOT rolled_back AND slot <= $2 ORDER BY slot, event_id",
    [treeId, maxSlot],
  );
  return { nodes: nodes.rows, trees: trees.rows, events: events.rows };
}

describe("Blockfrost poller", () => {
  // Replays the whole local chain history through Blockfrost-shaped calls, so it gets more time.
  it("matches the chain-sync follower on the same chain history", async () => {
    // One fixed block, captured once: both paths are compared up to it and only for the seeded tree,
    // so blocks other agents add while the test runs cannot change the result.
    const last = seeded.txIds.at(-1) ?? "";
    let indexed = false;
    for (let i = 0; i < 120 && !indexed; i++) {
      indexed = (await bf.get<{ block_height: number }>(`/txs/${last}`)) !== null;
      if (!indexed) await new Promise((r) => setTimeout(r, 500));
    }
    expect(indexed, "Yaci Store indexed the seed transactions").toBe(true);
    const fixed = await bf.latestBlock();
    const first = await bf.get<{ block_height: number }>(`/txs/${seeded.txIds[0] ?? ""}`);
    const start = first === null ? null : await bf.blockAt(first.block_height - 1);
    if (start === null) throw new Error("the block before the first seed transaction is not in Yaci Store");
    for (const db of [a, b]) {
      await db.pool.query("INSERT INTO chain_points (slot, block_hash, block_height) VALUES ($1, $2, $3)", [start.slot, start.hash, start.height]);
    }
    const poller = new BlockfrostPoller({ pool: b.pool, bf, scripts: SCRIPTS, log, publish: () => undefined, depth: 0, intervalMs: 1_000, startHeight: start.height });
    await poller.pollOnce(fixed.height);

    const follower = new Follower({ pool: a.pool, ogmiosWs: cfg.ogmiosWs, scripts: SCRIPTS, log, keepPoints: 300, publish: () => undefined });
    follower.start();
    let synced = false;
    for (let i = 0; i < 480 && !synced; i++) {
      const { rows } = await a.pool.query<{ s: string | null }>("SELECT max(slot) AS s FROM chain_points");
      synced = rows[0]?.s != null && Number(rows[0].s) >= fixed.slot;
      if (!synced) await new Promise((r) => setTimeout(r, 250));
    }
    await follower.stop();
    expect(synced, "chain-sync reached the fixed block").toBe(true);
    const oldest = await a.pool.query<{ s: string }>("SELECT min(slot) AS s FROM chain_points");
    expect(Number(oldest.rows[0]?.s), "chain-sync intersected at the start block, not origin").toBe(start.slot);

    const viaSync = await snapshot(a, seeded.treeId, fixed.slot);
    const viaPoll = await snapshot(b, seeded.treeId, fixed.slot);
    expect(viaPoll.trees).toHaveLength(1);
    expect(viaPoll.events.map((e: { tx_id: string }) => e.tx_id)).toEqual(expect.arrayContaining(seeded.txIds));
    expect(viaPoll).toEqual(viaSync);
  }, 180_000);

  it("undoes a stored block that the chain no longer has", async () => {
    const { rows } = await b.pool.query<{ slot: string }>("SELECT slot FROM node_events WHERE NOT rolled_back ORDER BY slot DESC LIMIT 1");
    const lastEventSlot = Number(rows[0]?.slot ?? 0);
    const point = await b.pool.query<{ h: string }>("SELECT block_height AS h FROM chain_points WHERE slot = $1", [lastEventSlot]);
    const lastEventHeight = Number(point.rows[0]?.h);
    expect(Number.isInteger(lastEventHeight), "the newest event's block is a stored chain point").toBe(true);
    // The poller only applies blocks DEPTH below the tip. The first test can finish within a few
    // blocks of the seed, so wait until the newest event's block is that deep before re-applying it.
    const DEPTH = 3;
    let deep = false;
    for (let i = 0; i < 120 && !deep; i++) {
      deep = (await bf.latestBlock()).height >= lastEventHeight + DEPTH;
      if (!deep) await new Promise((r) => setTimeout(r, 500));
    }
    expect(deep, `the devnet tip passed block ${lastEventHeight} by ${DEPTH}`).toBe(true);
    // Pretend the block of the newest event, and everything after it, was replaced by a fork.
    await b.pool.query("UPDATE chain_points SET block_hash = md5(block_hash) || md5(block_hash || 'fork') WHERE slot >= $1", [lastEventSlot]);
    const poller = new BlockfrostPoller({ pool: b.pool, bf, scripts: SCRIPTS, log, publish: () => undefined, depth: DEPTH });
    await poller.pollOnce();
    const rb = await b.pool.query("SELECT 1 FROM node_events WHERE type = 'chain.rollback'");
    expect(rb.rows.length).toBeGreaterThan(0);
    // After undoing, the poller re-applied the real blocks: the newest event is live again.
    const again = await b.pool.query("SELECT 1 FROM node_events WHERE slot = $1 AND NOT rolled_back AND type <> 'chain.rollback'", [lastEventSlot]);
    expect(again.rows.length).toBeGreaterThan(0);
  });
});
