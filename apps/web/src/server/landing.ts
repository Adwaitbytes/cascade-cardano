/**
 * `GET /v1/landing`: the landing page's network picture, read straight from the indexer tables
 * over every tree (the tree list route stops at the newest 100). Four aggregate queries plus one
 * tree read per job shown; the result is held for 30 s per instance.
 */
import * as read from "@cascade/indexer/read";
import { AmountSchema } from "@cascade/shared/browser";
import type pg from "pg";
import { TreeSchema } from "@/lib/api/schemas";
import { buildLanding, pickJobTrees, type AgentRow, type LandingData, type TreeRow } from "@/lib/landing/data";

const HOLD_MS = 30_000;
let held: { at: number; data: LandingData } | null = null;

interface SlotConfig {
  zeroTime: number;
  zeroSlot: number;
  slotLength: number;
}

/** Flows the projector stores on each event (`payload._flows`), restricted to value that left the tree. */
const FLOWS = `
  SELECT e.tree_id, x->>'kind' AS kind, x->>'node_id' AS node_id, x->>'to' AS payee, (x->>'amount')::numeric AS amount
    FROM node_events e
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload->'_flows') = 'array' THEN e.payload->'_flows' ELSE '[]'::jsonb END) x
   WHERE NOT e.rolled_back AND x->>'kind' IN ('fee', 'masumi', 'refund', 'structural_returned')`;

async function treeRows(pool: pg.Pool, slots: SlotConfig): Promise<TreeRow[]> {
  const { rows } = await pool.query<{
    tree_id: string;
    asset: string;
    root_budget: string;
    state: TreeRow["state"];
    created_slot: string;
    goal: string;
    node_count: number;
    paid: string;
    returned: string;
    structural_returned: string;
    payouts: number;
    settled_nodes: number;
    closed_receipts: number;
  }>(
    `WITH f AS (${FLOWS}),
     ft AS (
       SELECT tree_id,
              coalesce(sum(amount) FILTER (WHERE kind IN ('fee', 'masumi')), 0)::text AS paid,
              coalesce(sum(amount) FILTER (WHERE kind = 'refund'), 0)::text AS returned,
              coalesce(sum(amount) FILTER (WHERE kind = 'structural_returned'), 0)::text AS structural_returned,
              count(*) FILTER (WHERE kind IN ('fee', 'masumi') AND amount > 0)::int AS payouts
         FROM f GROUP BY tree_id
     ),
     ev AS (
       SELECT tree_id,
              count(DISTINCT node_id) FILTER (WHERE type = 'node.settled')::int AS settled_nodes,
              count(DISTINCT node_id) FILTER (WHERE type = 'receipt.closed')::int AS closed_receipts
         FROM node_events WHERE NOT rolled_back GROUP BY tree_id
     ),
     nc AS (SELECT tree_id, count(*)::int AS node_count FROM nodes GROUP BY tree_id)
     SELECT t.tree_id, t.asset, t.root_budget::text AS root_budget, t.state, t.created_slot::text AS created_slot,
            coalesce((SELECT s.task FROM plan_specs s WHERE s.plan_root = t.plan_root AND s.is_root LIMIT 1), '') AS goal,
            coalesce(nc.node_count, 0) AS node_count,
            coalesce(ft.paid, '0') AS paid, coalesce(ft.returned, '0') AS returned,
            coalesce(ft.structural_returned, '0') AS structural_returned, coalesce(ft.payouts, 0) AS payouts,
            coalesce(ev.settled_nodes, 0) AS settled_nodes, coalesce(ev.closed_receipts, 0) AS closed_receipts
       FROM trees t
       LEFT JOIN ft ON ft.tree_id = t.tree_id
       LEFT JOIN ev ON ev.tree_id = t.tree_id
       LEFT JOIN nc ON nc.tree_id = t.tree_id`,
  );
  return rows.map((r) => ({
    tree_id: r.tree_id,
    goal: r.goal,
    state: r.state,
    asset: r.asset,
    root_budget: r.root_budget,
    created_at: slots.zeroTime + (Number(r.created_slot) - slots.zeroSlot) * slots.slotLength,
    node_count: r.node_count,
    paid: r.paid,
    returned: r.returned,
    structural_returned: r.structural_returned,
    payouts: r.payouts,
    settled_nodes: r.settled_nodes,
    closed_receipts: r.closed_receipts,
  }));
}

async function networkCounts(pool: pg.Pool): Promise<{ txs: number; agentsPaid: number }> {
  const { rows } = await pool.query<{ txs: number; agents_paid: number }>(
    `SELECT (SELECT count(DISTINCT tx_id)::int FROM node_events WHERE NOT rolled_back) AS txs,
            (SELECT count(DISTINCT payee)::int FROM (${FLOWS}) f WHERE kind IN ('fee', 'masumi') AND amount > 0 AND payee NOT LIKE 'channel:%') AS agents_paid`,
  );
  return { txs: rows[0]?.txs ?? 0, agentsPaid: rows[0]?.agents_paid ?? 0 };
}

async function paidByNode(pool: pg.Pool, treeIds: readonly string[]): Promise<Map<string, bigint>> {
  if (treeIds.length === 0) return new Map();
  const { rows } = await pool.query<{ node_id: string; paid: string }>(
    `SELECT f.node_id, sum(f.amount)::text AS paid FROM (${FLOWS}) f
      WHERE f.tree_id = ANY($1::text[]) AND f.kind IN ('fee', 'masumi') GROUP BY f.node_id`,
    [treeIds],
  );
  return new Map(rows.map((r) => [r.node_id, BigInt(r.paid)]));
}

/** Directory agents with the price their cascade.json lists, and reputation as the directory route ranks it. */
async function agentRows(pool: pg.Pool): Promise<AgentRow[]> {
  const { rows } = await pool.query<{
    agent_asset_id: string;
    name: string;
    categories: string[];
    capabilities: { pricing?: { asset?: unknown; amount?: unknown }; categories?: unknown };
    score: number | null;
    confidence: number | null;
  }>(
    `SELECT a.agent_asset_id, a.name, a.categories, a.capabilities, r.score, r.confidence
       FROM agents a
       LEFT JOIN LATERAL (
         SELECT score, confidence FROM reputation
          WHERE agent_asset_id IN (a.agent_asset_id, a.payment_vkh) ORDER BY confidence DESC LIMIT 1) r ON true
      WHERE a.allowlisted AND a.last_seen > 0`,
  );
  return rows.map((r) => {
    const pricing = r.capabilities.pricing;
    const amount = AmountSchema.safeParse(pricing?.amount);
    const fallback = Array.isArray(r.capabilities.categories) ? r.capabilities.categories.filter((c): c is string => typeof c === "string") : [];
    return {
      agent_asset_id: r.agent_asset_id,
      name: r.name,
      categories: r.categories.length > 0 ? r.categories : fallback,
      price: amount.success && typeof pricing?.asset === "string" ? { asset: pricing.asset, amount: amount.data } : null,
      reputation: { score: r.score ?? 0.5, confidence: r.confidence ?? 0 },
    };
  });
}

export async function landing(pool: pg.Pool, slots: SlotConfig): Promise<read.ReadResult> {
  if (held !== null && Date.now() - held.at < HOLD_MS) return { ok: true, body: held.data };
  const [trees, counts, agents] = await Promise.all([treeRows(pool, slots), networkCounts(pool), agentRows(pool)]);
  const picked = pickJobTrees(trees);
  const ids = picked.map((t) => t.tree_id);
  const [paid, ...reads] = await Promise.all([paidByNode(pool, ids), ...ids.map((id) => read.getTree(pool, id))]);
  const jobTrees = reads.flatMap((r) => {
    if (!r.ok) return [];
    const tree = TreeSchema.safeParse(r.body);
    return tree.success ? [{ tree: tree.data, paidByNode: paid }] : [];
  });
  const data = buildLanding({ source: "live", generated_at: Date.now(), complete: true, trees, jobTrees, agents, txs: counts.txs, agentsPaid: counts.agentsPaid });
  held = { at: Date.now(), data };
  return { ok: true, body: data };
}
