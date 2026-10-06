/**
 * Follower against the real Yaci Ogmios (no mocks). Covers the A16 mechanism: after Yaci's snapshot
 * rollback the node restarts and the stored newest points are orphaned. We reproduce that state by
 * rewriting the newest stored points to hashes the chain never had, plus an event recorded at those
 * slots, then restart the follower: it must re-intersect at an older point and undo the orphaned
 * data, emitting chain.rollback.
 */
import type { CascadeEvent } from "@cascade/shared";
import { loadNetworkConfig, OgmiosClient } from "@cascade/service-kit";
import { createTestDatabase, type TestDatabase } from "@cascade/service-kit/testing";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Follower } from "../src/follower.js";
import { SCRIPTS } from "./scenario.js";

const cfg = loadNetworkConfig("local");
const log = pino({ level: "silent" });
let db: TestDatabase;

// The first sync replays the whole local chain from origin; it grows as other suites add blocks.
async function waitFor(pred: () => Promise<boolean>, timeoutMs = 150_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

describe("follower on Yaci", () => {
  // Syncs the whole local chain from origin, which grows as other suites add blocks.
  it("syncs to the tip and treats a stale re-intersection as a rollback", async () => {
    const published: CascadeEvent[] = [];
    const tip = await new OgmiosClient(cfg.ogmiosHttp).tip();
    const f1 = new Follower({ pool: db.pool, ogmiosWs: cfg.ogmiosWs, scripts: SCRIPTS, log, keepPoints: 300, publish: (e) => published.push(...e) });
    f1.start();
    await waitFor(async () => {
      const { rows } = await db.pool.query<{ s: string | null }>("SELECT max(slot) AS s FROM chain_points");
      return rows[0]?.s !== null && Number(rows[0]?.s) >= tip.slot;
    });
    await f1.stop();

    const { rows: newest } = await db.pool.query<{ slot: string }>("SELECT slot FROM chain_points ORDER BY slot DESC LIMIT 12");
    const orphanSlots = newest.slice(0, 12).map((r) => Number(r.slot));
    const oldestOrphan = Math.min(...orphanSlots);
    await db.pool.query("UPDATE chain_points SET block_hash = md5(block_hash) || md5(block_hash || 'x') WHERE slot >= $1", [oldestOrphan]);
    const tree = "7".repeat(56);
    const maxSlot = Math.max(...orphanSlots);
    await db.pool.query(
      `INSERT INTO trees (tree_id, buyer_vkh, asset, root_budget, plan_root, config_utxo, state, created_slot, config, created_tx, updated_slot)
       VALUES ($1, $2, 'lovelace', 0, $3, $4, 'open', $5, '{}', $6, $5)`,
      [tree, "1".repeat(56), "a".repeat(64), `${"b".repeat(64)}#1`, maxSlot, "b".repeat(64)],
    );
    await db.pool.query(
      `INSERT INTO node_events (node_id, tree_id, type, tx_id, slot, block_hash, block_height, value_delta, payload, emitted_at)
       VALUES ($1, $1, 'tree.funded', $2, $3, $4, 1, '{"asset":"lovelace","amount":"5"}', '{}', 0)`,
      [tree, "b".repeat(64), maxSlot, "c".repeat(64)],
    );

    const f2 = new Follower({ pool: db.pool, ogmiosWs: cfg.ogmiosWs, scripts: SCRIPTS, log, keepPoints: 300, publish: (e) => published.push(...e) });
    f2.start();
    await waitFor(async () => published.some((e) => e.type === "chain.rollback"));
    await f2.stop();

    const rb = published.find((e) => e.type === "chain.rollback");
    expect(rb?.tree_id).toBe(tree);
    expect(rb?.type === "chain.rollback" && rb.payload.rollback_to_slot).toBeLessThan(oldestOrphan);
    const ev = await db.pool.query<{ rolled_back: boolean }>("SELECT rolled_back FROM node_events WHERE type = 'tree.funded' AND tree_id = $1", [tree]);
    expect(ev.rows[0]?.rolled_back).toBe(true);
    expect((await db.pool.query("SELECT 1 FROM trees WHERE tree_id = $1", [tree])).rows).toHaveLength(0);
    const bad = await db.pool.query("SELECT 1 FROM chain_points WHERE block_hash LIKE '%x%' OR length(block_hash) <> 64");
    expect(bad.rows).toHaveLength(0);
  }, 180_000);
});
