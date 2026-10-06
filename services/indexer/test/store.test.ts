/**
 * Store integration against the local Postgres (a throwaway database per run): apply the full
 * lifecycle block by block, serve it through the REST API, then roll back and check exact undo.
 */
import { CascadeEventSchema, verifyCose1, jcsSha256 } from "@cascade/shared";
import { deriveRoleKey, withTransaction } from "@cascade/service-kit";
import { CHILD_ID, CHILD_OPERATOR, OPERATOR, TREE_ID, createTestDatabase, type TestDatabase } from "@cascade/service-kit/testing";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { project } from "../src/projector.js";
import { applyProjection, eventsByIds, loadConfigs, loadTracked, recordPoint, rollbackTo, toCascadeEvent } from "../src/store.js";
import { SCRIPTS, addressText, lifecycle } from "./scenario.js";

const YACI_MNEMONIC = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const oracle = deriveRoleKey(YACI_MNEMONIC, 15, "local");
const log = pino({ level: "silent" });

let db: TestDatabase;

async function applyStep(i: number): Promise<number[]> {
  const step = lifecycle()[i]!;
  return withTransaction(db.pool, async (c) => {
    const tracked = await loadTracked(c, step.tx.inputs);
    const configs = await loadConfigs(c, [...new Set([...tracked.values()].map((t) => t.treeId))]);
    const p = project(step.tx, { scripts: SCRIPTS, tracked, configs, addressText });
    const block = { slot: step.slot, hash: step.slot.toString(16).padStart(64, "0"), height: step.slot };
    const ids = await applyProjection(c, p, block, 0, 1_700_000_000_000 + i);
    await recordPoint(c, block, 100);
    return ids;
  });
}

function api() {
  return createApi({
    pool: db.pool,
    scripts: SCRIPTS,
    oracle,
    log,
    tipHeight: async () => 200,
    tipSlot: async () => 200,
    horizonSlots: 300,
    adminToken: "t0ken",
    decimalsOf: () => 6,
    health: () => ({}),
    views: { slotConfig: { zeroTime: 1_700_000_000_000, zeroSlot: 0, slotLength: 1000 }, indexedSlot: async () => 170, maxExUnits: async () => ({ memory: 17_500_000n, steps: 10_000_000_000n }) },
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

describe("indexer store", () => {
  it("applies the lifecycle and serves strict PRD 17.3 events", async () => {
    const all: number[] = [];
    for (let i = 0; i < 8; i++) all.push(...(await applyStep(i)));
    const rows = await eventsByIds(db.pool, all);
    const events = rows.map((r) => toCascadeEvent(r, 200));
    for (const e of events) expect(CascadeEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
    expect(events.map((e) => e.type)).toEqual([
      "tree.funded",
      "node.drawn",
      "node.submitted",
      "node.accepted",
      "node.settled",
      "node.submitted",
      "node.accepted",
      "node.settled",
      "tree.closed",
    ]);
    expect(events[0]?.confirmations).toBe(100);
  });

  it("serves the tree, events and a signed balanced receipt", async () => {
    const app = api();
    const tree = (await (await app.request(`/v1/trees/${TREE_ID}`)).json()) as { state: string; root_budget: string; nodes: { node_id: string; state: string; tx_ids: string[] }[] };
    expect(tree.state).toBe("closed");
    expect(tree.root_budget).toBe("100000000");
    expect((tree as unknown as { config: Record<string, unknown> }).config).toMatchObject({ min_dispute_window: 300_000, arbiters: [], arbiter_threshold: 0, asset: "lovelace", plan_root: "ab".repeat(32) });
    expect((tree as unknown as { nodes: { spent: string }[] }).nodes.map((n) => n.spent)).toEqual(["5000000", "0"]);
    expect(tree.nodes.map((n) => [n.node_id, n.state])).toEqual([
      [TREE_ID, "Settled"],
      [CHILD_ID, "Settled"],
    ]);
    expect(tree.nodes[1]?.tx_ids).toHaveLength(4);

    const page = (await (await app.request(`/v1/trees/${TREE_ID}/events?since=0&limit=3`)).json()) as { events: { event_id: string }[]; next: string | null };
    expect(page.events).toHaveLength(3);
    expect(page.next).toBe(page.events[2]?.event_id);

    const res = await app.request(`/v1/trees/${TREE_ID}/receipt`);
    expect(res.status).toBe(200);
    const receipt = (await res.json()) as Record<string, unknown> & { balanced: boolean; deposits: { amount: string }; signature: string; key: string };
    expect(receipt.balanced).toBe(true);
    // ADA tree: 100 ADA budget plus 12 ADA structural (root reserve and config min-ADA).
    expect(receipt.deposits.amount).toBe("112000000");
    const { signature, ...body } = receipt;
    expect(verifyCose1({ signature, key: receipt.key }, { payload: jcsSha256(body), address: oracle.address }).ok).toBe(true);
  });

  it("names each node's agent from the directory by operator key, preferring allowlisted rows", async () => {
    const add = (id: string, name: string, vkh: string, allowlisted: boolean) =>
      db.pool.query("INSERT INTO agents (agent_asset_id, name, api_url, payment_vkh, allowlisted) VALUES ($1, $2, 'https://a.example', $3, $4)", [id, name, vkh, allowlisted]);
    await add(`${"67".repeat(28)}01`, "Conductor", OPERATOR, true);
    await add(`${"67".repeat(28)}02`, "Scribe (old)", CHILD_OPERATOR, false);
    await add(`${"67".repeat(28)}03`, "Scribe", CHILD_OPERATOR, true);
    const app = api();
    const tree = (await (await app.request(`/v1/trees/${TREE_ID}`)).json()) as { nodes: { node_id: string; agent_name: string | null; agent_asset_id: string | null }[] };
    expect(Object.fromEntries(tree.nodes.map((n) => [n.node_id, [n.agent_name, n.agent_asset_id]]))).toEqual({
      [TREE_ID]: ["Conductor", `${"67".repeat(28)}01`],
      [CHILD_ID]: ["Scribe", `${"67".repeat(28)}03`],
    });
    const detail = (await (await app.request(`/v1/trees/${TREE_ID}/nodes/${CHILD_ID}`)).json()) as { agent_name: string | null };
    expect(detail.agent_name).toBe("Scribe");
    await db.pool.query("DELETE FROM agents WHERE agent_asset_id LIKE $1", [`${"67".repeat(28)}0%`]);
  });

  it("serves the web app's pending views exactly as apps/web parses them", async () => {
    // The web app's own zod schemas are the contract; the path is kept out of this package's type graph.
    const webSchemas = "../../../apps/web/src/lib/api/schemas.js";
    interface Parser<T> {
      parse(v: unknown): T;
    }
    const web = (await import(webSchemas)) as {
      NodeDetailSchema: Parser<{ txs: { action: string }[] }>;
      TreeListSchema: Parser<{ trees: Record<string, unknown>[] }>;
      DisputeListSchema: Parser<unknown>;
      OpsStatusSchema: Parser<{ indexer: { indexed_slot: number } }>;
      ProviderWorkSchema: Parser<{ earnings: { jobs_settled: number; paid: { amount: string } } }>;
    };
    const app = api();
    await db.pool.query("INSERT INTO agents (agent_asset_id, name, api_url, payment_vkh, allowlisted, last_seen) VALUES ($1, 'Scout', 'http://127.0.0.1:1', $2, true, 1)", [
      `${"67".repeat(28)}01`,
      "23".repeat(28),
    ]);
    const detail = await (await app.request(`/v1/trees/${TREE_ID}/nodes/${CHILD_ID}`)).json();
    const d = web.NodeDetailSchema.parse(detail);
    expect(d.txs.map((t) => t.action)).toEqual(["Draw", "Submit", "Accept", "SettleChild"]);
    const list = web.TreeListSchema.parse(await (await app.request("/v1/trees")).json());
    expect(list.trees[0]).toMatchObject({ tree_id: TREE_ID, paid: "15000000", refunded: "85000000", node_count: 2, state: "closed" });
    web.DisputeListSchema.parse(await (await app.request("/v1/disputes")).json());
    const ops = web.OpsStatusSchema.parse(await (await app.request("/v1/ops/status")).json());
    expect(ops.indexer.indexed_slot).toBe(170);
    const work = web.ProviderWorkSchema.parse(await (await app.request(`/v1/agents/${"67".repeat(28)}01/work`)).json());
    expect(work.earnings.jobs_settled).toBe(1);
    expect(work.earnings.paid.amount).toBe("5000000");
    expect((await app.request(`/v1/trees?buyer=not-an-address`)).status).toBe(400);
  });

  it("shows failed cranks on the ops page as short plain causes, including rows stored before causes existed", async () => {
    const raw = `Error: {"contents":{"contents":{"contents":{"era":"ShelleyBasedEraConway","error":["ConwayUtxowFailure (UtxoFailure (InsufficientCollateral (DeltaCoin (-1)) (Coin 2)))"]}}}}`;
    await db.pool.query(
      `INSERT INTO watchtower_cranks (utxo_ref, kind, node_id, tree_id, status, attempts, last_error, updated_at) VALUES
         ($1, 'SettleChild', $3, $4, 'failed', 1, 'Cannot read properties of undefined (reading ''address'')', 2),
         ($2, 'Refund', $3, $4, 'failed', 1, $5, 1)`,
      [`${"e1".repeat(32)}#0`, `${"e2".repeat(32)}#0`, CHILD_ID, TREE_ID, raw],
    );
    const ops = (await (await api().request("/v1/ops/status")).json()) as { failed_txs: { action: string; error: string }[] };
    expect(ops.failed_txs.slice(0, 2)).toEqual([
      { action: "SettleChild", tx_id: null, error: "node UTxO not at the chain provider: already spent by another transaction, or not indexed yet", at: 2 },
      { action: "Refund", tx_id: null, error: "fee wallet view was stale: an input was already spent; retrying", at: 1 },
    ]);
    await db.pool.query("DELETE FROM watchtower_cranks WHERE utxo_ref IN ($1, $2)", [`${"e1".repeat(32)}#0`, `${"e2".repeat(32)}#0`]);
  });

  it("rejects malformed ids and unknown trees", async () => {
    const app = api();
    expect((await app.request("/v1/trees/xyz")).status).toBe(400);
    expect((await app.request(`/v1/trees/${"0".repeat(56)}`)).status).toBe(404);
    expect((await app.request(`/v1/trees/${TREE_ID}/events?limit=0`)).status).toBe(400);
  });

  it("rolls back exactly: undone events are flagged and nodes return to their earlier state", async () => {
    // Roll back to after the Accept of the child (slot 130): settle, root submit/accept and close vanish.
    const r = await withTransaction(db.pool, (c) => rollbackTo(c, 130, { slot: 130, hash: "82".padStart(64, "0"), height: 130 }, Date.now()));
    expect(r.undone.map((u) => u.slot)).toEqual([140, 150, 160, 170, 170]);
    const tree = await db.pool.query<{ state: string; closed_slot: string | null }>("SELECT state, closed_slot FROM trees WHERE tree_id = $1", [TREE_ID]);
    expect(tree.rows[0]).toEqual({ state: "open", closed_slot: null });
    const nodes = await db.pool.query<{ node_id: string; state: string; committed: string; current_utxo: string | null }>(
      "SELECT node_id, state, committed, current_utxo FROM nodes ORDER BY depth",
    );
    expect(nodes.rows.map((n) => [n.node_id, n.state, n.committed])).toEqual([
      [TREE_ID, "Funded", "30000000"],
      [CHILD_ID, "Accepted", "0"],
    ]);
    expect(nodes.rows.every((n) => n.current_utxo !== null)).toBe(true);

    const rb = (await eventsByIds(db.pool, r.rollbackEvents)).map((e) => toCascadeEvent(e, 200));
    for (const e of rb) expect(CascadeEventSchema.safeParse(e).success).toBe(true);
    expect(rb.every((e) => e.type === "chain.rollback")).toBe(true);
    const undoneIds = rb.flatMap((e) => (e.type === "chain.rollback" ? e.payload.undone_event_ids : []));
    expect(undoneIds).toHaveLength(5);

    // Replaying the same blocks after the rollback yields the same final state.
    for (let i = 4; i < 8; i++) await applyStep(i);
    const again = await db.pool.query<{ state: string }>("SELECT state FROM trees WHERE tree_id = $1", [TREE_ID]);
    expect(again.rows[0]?.state).toBe("closed");
    const receipt = (await (await api().request(`/v1/trees/${TREE_ID}/receipt`)).json()) as { balanced: boolean };
    expect(receipt.balanced).toBe(true);
  });

  it("rolls back to origin, removing the tree entirely", async () => {
    await withTransaction(db.pool, (c) => rollbackTo(c, null, { slot: 0, hash: "", height: 0 }, Date.now()));
    expect((await db.pool.query("SELECT 1 FROM trees")).rows).toHaveLength(0);
    expect((await db.pool.query("SELECT 1 FROM nodes")).rows).toHaveLength(0);
    expect((await db.pool.query("SELECT 1 FROM node_events WHERE NOT rolled_back AND type <> 'chain.rollback'")).rows).toHaveLength(0);
  });
});
