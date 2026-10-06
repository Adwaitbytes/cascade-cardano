/**
 * The public read routes run on Vercel against Neon across regions, so every query is a round trip:
 * the tree list and a tree's events are one query each, tree detail two (three only when an
 * operator is outside the directory), the receipt at most three. Counts the queries each read function sends through its pool.
 */
import { deriveRoleKey, withTransaction } from "@cascade/service-kit";
import { CHILD_ID, CHILD_OPERATOR, OPERATOR, TREE_ID, createTestDatabase, type TestDatabase } from "@cascade/service-kit/testing";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { project } from "../src/projector.js";
import { getReceipt, getTree, getTreeEvents, listTrees } from "../src/read.js";
import { syncPlanSpecs } from "../src/plan-specs.js";
import { applyProjection, loadConfigs, loadTracked, recordPoint } from "../src/store.js";
import { PlanSchema, computePlanRoot, specHash, type NodeSpec } from "@cascade/shared";
import { SCRIPTS, addressText, lifecycle } from "./scenario.js";

let db: TestDatabase;
const oracle = deriveRoleKey("test test test test test test test test test test test test test test test test test test test test test test test sauce", 15, "local");

function counting(pool: Pool): { pool: Pool; queries: () => number } {
  let n = 0;
  const proxy = new Proxy(pool, {
    get(target, key, receiver) {
      if (key === "query") {
        return (...args: Parameters<Pool["query"]>) => {
          n++;
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      }
      const v = Reflect.get(target, key, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { pool: proxy, queries: () => n };
}

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
  // More trees, each with nodes and events, so an N+1 list would show up as extra queries.
  for (const id of ["a1", "a2", "a3"].map((b) => b.repeat(28))) {
    await db.pool.query(
      `INSERT INTO trees (tree_id, buyer_vkh, asset, root_budget, plan_root, config_utxo, state, frozen, created_slot, config, created_tx, updated_slot)
       SELECT $1, buyer_vkh, asset, root_budget, plan_root, config_utxo, state, frozen, created_slot + 1, config, created_tx, updated_slot FROM trees WHERE tree_id = $2`,
      [id, TREE_ID],
    );
    await db.pool.query(
      `INSERT INTO node_events (node_id, tree_id, type, tx_id, slot, block_hash, block_height, value_delta, payload, emitted_at)
       SELECT $1, $1, type, tx_id, slot, block_hash, block_height, value_delta, payload, emitted_at FROM node_events WHERE tree_id = $2`,
      [id, TREE_ID],
    );
  }
});
afterAll(async () => {
  await db.drop();
});

describe("read route query counts", () => {
  it("lists trees in one query", async () => {
    const c = counting(db.pool);
    const r = await listTrees(c.pool, { zeroTime: 0, zeroSlot: 0, slotLength: 1000 }, undefined, "20");
    if (!r.ok) throw new Error(r.error);
    expect((r.body as { trees: unknown[] }).trees).toHaveLength(4);
    expect(c.queries()).toBe(1);
  });

  it("serves tree detail in three queries when an operator is unknown, two once the directory names them", async () => {
    const c = counting(db.pool);
    expect((await getTree(c.pool, TREE_ID)).ok).toBe(true);
    expect(c.queries()).toBe(3);
    await db.pool.query("INSERT INTO agents (agent_asset_id, name, api_url, payment_vkh, allowlisted) VALUES ($1, 'Conductor', 'https://a.example', $2, true), ($3, 'Scribe', 'https://a.example', $4, true)", [
      `${"67".repeat(28)}01`,
      OPERATOR,
      `${"67".repeat(28)}02`,
      CHILD_OPERATOR,
    ]);
    const named = counting(db.pool);
    const r = await getTree(named.pool, TREE_ID);
    if (!r.ok) throw new Error(r.error);
    expect((r.body as { nodes: { agent_name: string | null }[] }).nodes.map((x) => x.agent_name)).toEqual(["Conductor", "Scribe"]);
    expect(named.queries()).toBe(2);
  });

  it("serves a tree's events in one query, without internal ledger flows, and 404s an unknown tree", async () => {
    const c = counting(db.pool);
    const r = await getTreeEvents(c.pool, TREE_ID, undefined, "1000", 0);
    if (!r.ok) throw new Error(r.error);
    const events = (r.body as { events: { payload: Record<string, unknown> }[] }).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => "_flows" in e.payload)).toBe(false);
    expect(c.queries()).toBe(1);
    const none = await getTreeEvents(db.pool, "ab".repeat(28), undefined, undefined, 0);
    expect(none.ok ? 200 : none.status).toBe(404);
  });

  it("serves the signed receipt in at most three queries", async () => {
    const c = counting(db.pool);
    const r = await getReceipt(c.pool, TREE_ID, oracle);
    if (!r.ok) throw new Error(r.error);
    expect((r.body as { balanced: boolean }).balanced).toBe(true);
    expect(c.queries()).toBeLessThanOrEqual(3);
  });

  it("names the goal and spends by category from stored plan summaries, still in one query", async () => {
    const spec = (id: string, category: string, extra: Partial<NodeSpec> = {}): NodeSpec => ({
      version: "1",
      id,
      task: `${id.replaceAll("-", " ")} task`,
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
      ...extra,
    });
    const rootSpec = spec("Compile-a-market-brief", "orchestration", { may_sub_hire: true, max_sub_budget_share_bps: 5000, price: { asset: "lovelace", max_budget: "100000000", max_fee: "10000000" } });
    const childSpec = spec("research", "research");
    const rootNode = {
      spec: rootSpec,
      agents: { primary: { agent_id: `${"67".repeat(28)}01`, quote_id: null, price: "100000000" }, fallbacks: [] },
      children: [{ spec: childSpec, agents: { primary: { agent_id: `${"67".repeat(28)}02`, quote_id: null, price: "30000000" }, fallbacks: [] }, children: [] }],
    };
    const plan = PlanSchema.parse({
      version: "1",
      plan_id: "brief",
      asset: "lovelace",
      limits: { max_depth: 3, max_fanout: 8, max_child_share_bps: 6000, min_challenge_window_ms: 600_000, min_safety_margin_ms: 300_000 },
      root: rootNode,
      totals: { budget: "100000000", fees: "10000000", structural_lovelace: "10000000", reserve: "0" },
      deadlines: { fund_by: 1, submit_by: 2, challenge_until: 3, refund_after: 4, dispute_until: 5 },
      plan_root: computePlanRoot(rootNode),
    });
    await db.pool.query("INSERT INTO plans (plan_id, tree_id, plan_root, json, version) VALUES ('brief', $1, $2, $3, 1)", [TREE_ID, plan.plan_root, JSON.stringify(plan)]);
    await db.pool.query("UPDATE trees SET plan_root = $2 WHERE tree_id = $1", [TREE_ID, plan.plan_root]);
    await db.pool.query("UPDATE nodes SET spec_hash = $2 WHERE node_id = $1", [TREE_ID, specHash(rootSpec)]);
    await db.pool.query("UPDATE nodes SET spec_hash = $2 WHERE node_id = $1", [CHILD_ID, specHash(childSpec)]);
    expect(await syncPlanSpecs(db.pool)).toBe(1);
    expect(await syncPlanSpecs(db.pool)).toBe(0);
    const c = counting(db.pool);
    const r = await listTrees(c.pool, { zeroTime: 0, zeroSlot: 0, slotLength: 1000 }, undefined, "20");
    if (!r.ok) throw new Error(r.error);
    const tree = (r.body as { trees: { tree_id: string; goal: string; paid: string; spend_by_category: Record<string, string> }[] }).trees.find((t) => t.tree_id === TREE_ID);
    expect(tree?.goal).toBe("Compile a market brief task");
    // The lifecycle pays the child 5 ADA (research) and the orchestrator 10 ADA (orchestration).
    expect(tree?.spend_by_category).toEqual({ research: "5000000", orchestration: "10000000" });
    expect(tree?.paid).toBe("15000000");
    expect(c.queries()).toBe(1);
  });

  it("rejects an out-of-range limit", async () => {
    expect((await listTrees(db.pool, { zeroTime: 0, zeroSlot: 0, slotLength: 1000 }, undefined, "500")).ok).toBe(false);
  });
});
