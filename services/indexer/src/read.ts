/**
 * Pure read module (`@cascade/indexer/read`): every public GET route of the indexer as a function of
 * a pg Pool that returns exactly the REST response body. No side effects at import and no Lucid, so
 * Next.js server routes (the public explorer on Vercel reading Neon) can call it directly.
 */
import type { CascadeEvent } from "@cascade/shared/browser";
import type { CoseSigner } from "@cascade/service-kit/cose";
import type { Pool } from "pg";
import { z } from "zod";
import { masumiLeaves } from "./leaves.js";
import { attachPaymentResponses, type PaymentResult } from "./offchain.js";
import type { Flow } from "./projector.js";
import { reconcile, signReceipt, type FlowRecord } from "./receipt.js";
import { agentsForNodes, badRequest, found, missing, parsePlan, plannedAgents, type NodeAgent, type ReadResult } from "./views.js";
import { toCascadeEvent, type EventRow } from "./wire.js";

export { getNodeDetail, getOpsStatus, getProviderWork, listDisputes, listTrees, meteredFor, actionOfEvent, type ReadResult, type ViewDeps } from "./views.js";
export { toCascadeEvent, type EventRow } from "./wire.js";
export { reconcile, signReceipt, type Receipt, type UnsignedReceipt } from "./receipt.js";
// PRD 12.4: the scoring as pure functions, so a recompute from chain imports exactly this code.
export {
  DEFAULT_REPUTATION_PARAMS,
  computeReputation,
  reputationFromInputs,
  snapshotEntry,
  snapshotLeaf,
  snapshotProof,
  snapshotRoot,
  type NodeOutcome,
  type ReputationRow,
  type SnapshotInputs,
} from "./reputation.js";

const HEX28 = /^[0-9a-f]{56}$/;
const AGENT_ID = /^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/;

interface TreeRow {
  tree_id: string;
  buyer_vkh: string;
  asset: string;
  root_budget: string;
  plan_root: string;
  config_utxo: string;
  state: "open" | "closed" | "cancelled";
  frozen: boolean;
  created_slot: string;
  closed_slot: string | null;
  config: Record<string, unknown>;
}

interface NodeDbRow {
  node_id: string;
  tree_id: string;
  parent_id: string | null;
  depth: number;
  kind: string;
  operator_vkh: string;
  payee: string;
  agent_asset_id: string | null;
  budget: string;
  fee: string;
  committed: string;
  spent: string | null;
  children_open: number;
  spec_hash: string;
  input_hash: string;
  result_hash: string | null;
  acceptance: { type: string; key?: string; keys?: string[]; k?: string };
  submit_by: string;
  challenge_until: string;
  refund_after: string;
  dispute_until: string;
  state: string;
  current_utxo: string | null;
  external_ref: string | null;
  tx_ids: string[] | null;
}

function nodeJson(r: NodeDbRow) {
  const acc: Record<string, unknown> = { type: r.acceptance.type };
  if (r.acceptance.key !== undefined) acc.key = r.acceptance.key;
  if (r.acceptance.keys !== undefined) acc.keys = r.acceptance.keys;
  if (r.acceptance.k !== undefined) acc.k = Number(r.acceptance.k);
  return {
    node_id: r.node_id,
    tree_id: r.tree_id,
    parent_id: r.parent_id,
    depth: r.depth,
    kind: r.kind,
    operator_vkh: r.operator_vkh,
    payee: r.payee,
    agent_asset_id: r.agent_asset_id,
    budget: r.budget,
    fee: r.fee,
    committed: r.committed,
    // ADR 0001 1.5: value that left the tree from this node; held = budget - committed - spent.
    spent: r.spent ?? "0",
    children_open: r.children_open,
    spec_hash: r.spec_hash,
    input_hash: r.input_hash,
    result_hash: r.result_hash,
    acceptance: acc,
    submit_by: Number(r.submit_by),
    challenge_until: Number(r.challenge_until),
    refund_after: Number(r.refund_after),
    dispute_until: Number(r.dispute_until),
    state: r.state,
    current_utxo: r.current_utxo,
    external_ref: r.external_ref,
    tx_ids: r.tx_ids ?? [],
  };
}


/** The TreeConfig fields a reader needs, from the stored decoded datum (amounts and ms as numbers). */
function configJson(c: Record<string, unknown>, asset: string) {
  const num = (k: string): number => Number(c[k] ?? 0);
  const arbiters = Array.isArray(c.arbiters) ? c.arbiters.filter((a): a is string => typeof a === "string") : [];
  return {
    asset,
    plan_root: typeof c.plan_root === "string" ? c.plan_root : "",
    buyer: typeof c.buyer === "string" ? c.buyer : "",
    arbiters,
    arbiter_threshold: num("arbiter_threshold"),
    max_depth: num("max_depth"),
    max_fanout: num("max_fanout"),
    max_child_share_bps: num("max_child_share_bps"),
    min_challenge_window: num("min_challenge_window"),
    min_safety_margin: num("min_safety_margin"),
    min_dispute_window: num("min_dispute_window"),
    allowed_leaf_kinds: Array.isArray(c.allowed_leaf_kinds) ? c.allowed_leaf_kinds : [],
    protocol_fee_bps: num("protocol_fee_bps"),
    challenge_bond: String(c.challenge_bond ?? "0"),
    slash_wronged_bps: num("slash_wronged_bps"),
  };
}


const AgentQuery = z.object({
  category: z.string().min(1).max(64).optional(),
  min_rep: z.coerce.number().min(0).max(1).optional(),
  rail: z.enum(["native", "masumi", "metered"]).optional(),
});

/** Tree detail in three queries: the tree with its latest plan, its nodes with ordered tx ids, and their agents. */
export async function getTree(pool: Pool, treeId: string): Promise<ReadResult> {
  if (!HEX28.test(treeId)) return badRequest("tree_id must be 28-byte hex");
  const t = await pool.query<TreeRow & { plan_json: unknown; plan_agents: { agent_asset_id: string; name: string }[] | null }>(
    `WITH tt AS (
       SELECT t.*, (SELECT p.json FROM plans p WHERE p.plan_root = t.plan_root ORDER BY p.version DESC LIMIT 1) AS plan_json
         FROM trees t WHERE t.tree_id = $1)
     SELECT tt.tree_id, tt.buyer_vkh, tt.asset, tt.root_budget, tt.plan_root, tt.config_utxo, tt.state, tt.frozen, tt.created_slot, tt.closed_slot, tt.config, tt.plan_json,
            (SELECT json_agg(json_build_object('agent_asset_id', a.agent_asset_id, 'name', a.name)) FROM agents a
              WHERE tt.plan_json IS NOT NULL
                AND a.agent_asset_id IN (SELECT jsonb_path_query(tt.plan_json, 'strict $.**.primary.agent_id') #>> '{}')) AS plan_agents
       FROM tt`,
    [treeId],
  );
  const tree = t.rows[0];
  if (tree === undefined) return missing("unknown tree");
  // tx_ids oldest first: a transaction has one slot, so each node's own UTxO history orders them.
  const n = await pool.query<NodeDbRow & { operator_agent: NodeAgent | null }>(
    `SELECT n.*,
            (SELECT json_build_object('agent_asset_id', a.agent_asset_id, 'name', a.name) FROM agents a WHERE a.payment_vkh = n.operator_vkh
              ORDER BY a.allowlisted DESC, a.last_seen DESC NULLS LAST, a.agent_asset_id LIMIT 1) AS operator_agent,
            (SELECT array_agg(x.tx ORDER BY x.slot, x.tx) FROM (
         SELECT y.tx, min(y.slot) AS slot FROM (
           SELECT u.tx_id AS tx, u.slot FROM node_utxos u WHERE u.node_id = n.node_id
           UNION ALL SELECT u.spent_tx, u.spent_slot FROM node_utxos u WHERE u.node_id = n.node_id AND u.spent_tx IS NOT NULL) y
         GROUP BY y.tx) x) AS tx_ids
       FROM nodes n WHERE n.tree_id = $1 ORDER BY n.depth, n.created_slot, n.node_id`,
    [treeId],
  );
  // The plan's primary agent, else the operator's directory entry; only nodes still unnamed (an
  // operator outside the directory) cost a third query, by payee key.
  const plan = parsePlan(tree.plan_json);
  const planned = plannedAgents(plan, tree.plan_agents ?? []);
  const agents = new Map<string, NodeAgent>();
  for (const r of n.rows) {
    const a = planned.get(r.spec_hash) ?? r.operator_agent;
    if (a !== null && a !== undefined) agents.set(r.node_id, a);
  }
  const unnamed = n.rows.filter((r) => !agents.has(r.node_id));
  if (unnamed.length > 0) for (const [id, a] of await agentsForNodes(pool, null, unnamed)) agents.set(id, a);
  return found({
    tree_id: tree.tree_id,
    buyer_vkh: tree.buyer_vkh,
    asset: tree.asset,
    root_budget: tree.root_budget,
    plan_root: tree.plan_root,
    config_utxo: tree.config_utxo,
    state: tree.state,
    frozen: tree.frozen,
    created_slot: Number(tree.created_slot),
    closed_slot: tree.closed_slot === null ? null : Number(tree.closed_slot),
    config: configJson(tree.config, tree.asset),
    nodes: n.rows.map((r) => {
      const agent = agents.get(r.node_id);
      return { ...nodeJson(r), agent_asset_id: r.agent_asset_id ?? agent?.agent_asset_id ?? null, agent_name: agent?.name ?? null };
    }),
  });
}

export async function getTreeEvents(pool: Pool, treeId: string, sinceRaw: string | undefined, limitRaw: string | undefined, tipHeight: number): Promise<ReadResult> {
  const d = { pool };
  {
    if (!HEX28.test(treeId)) return badRequest("tree_id must be 28-byte hex");
    if (sinceRaw !== undefined && !/^\d{1,18}$/.test(sinceRaw)) return badRequest("since must be an event_id");
    if (limitRaw !== undefined && (!/^\d{1,4}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 1000)) {
      return badRequest("limit must be 1..1000");
    }
    const limit = limitRaw === undefined ? 200 : Number(limitRaw);
    // One indexed query: the tree's existence and its events after `since`, without the internal
    // ledger flows (they never leave the indexer; the receipt carries the reconciliation).
    const { rows: joined } = await d.pool.query<EventRow | { event_id: null }>(
      `SELECT e.event_id, e.node_id, e.tree_id, e.type, e.tx_id, e.slot, e.block_height, e.value_delta, e.payload, e.rolled_back, e.emitted_at
         FROM trees t
         LEFT JOIN LATERAL (
           SELECT event_id, node_id, tree_id, type, tx_id, slot, block_height, value_delta, payload - '_flows' AS payload, rolled_back, emitted_at
             FROM node_events WHERE tree_id = t.tree_id AND event_id > $2 AND NOT rolled_back ORDER BY event_id LIMIT $3) e ON true
        WHERE t.tree_id = $1
        ORDER BY e.event_id`,
      [treeId, sinceRaw === undefined ? 0 : Number(sinceRaw), limit],
    );
    if (joined.length === 0) return missing("unknown tree");
    const rows = joined.filter((r): r is EventRow => r.event_id !== null);
    const tip = tipHeight;
    const events: CascadeEvent[] = rows.map((r) => toCascadeEvent(r, tip));
    return found({ events, next: rows.length === limit ? (rows.at(-1)?.event_id ?? null) : null });
  }
}

/** Receipt signed with the indexer oracle key (any COSE signer; no Lucid needed). */
export async function getReceipt(pool: Pool, treeId: string, oracle: CoseSigner | null): Promise<ReadResult> {
  const d = { pool, oracle };
  {
    if (!HEX28.test(treeId)) return badRequest("tree_id must be 28-byte hex");
    const t = await d.pool.query<{ asset: string; state: string; masumi_ids: Record<string, string> | null; x402: Omit<PaymentResult, "tree_id">[] | null }>(
      `SELECT t.asset, t.state,
              (SELECT json_object_agg(n.node_id, n.masumi_identifier) FROM nodes n WHERE n.tree_id = t.tree_id AND n.masumi_identifier IS NOT NULL) AS masumi_ids,
              (SELECT json_agg(json_build_object('draw_tx', r.draw_tx, 'node_id', r.node_id, 'payment_response', r.payment_response) ORDER BY r.recorded_at, r.draw_tx)
                 FROM x402_results r WHERE r.tree_id = t.tree_id) AS x402
         FROM trees t WHERE t.tree_id = $1`,
      [treeId],
    );
    const tree = t.rows[0];
    if (tree === undefined) return missing("unknown tree");
    if (d.oracle === null) return { ok: false, status: 503, error: "unavailable", detail: "the indexer oracle key is not configured" };
    const { rows } = await d.pool.query<EventRow>(
      "SELECT event_id, node_id, tree_id, type, tx_id, slot, block_height, value_delta, payload, rolled_back, emitted_at FROM node_events WHERE tree_id = $1 AND NOT rolled_back ORDER BY event_id",
      [treeId],
    );
    const flows: FlowRecord[] = [];
    for (const r of rows) {
      const raw = r.payload._flows;
      if (!Array.isArray(raw)) continue;
      for (const f of raw as { kind: Flow["kind"]; node_id: string; to: string; asset: string; amount: string; blockchain_identifier?: string; out_ref?: string }[]) {
        flows.push({ txId: r.tx_id, flow: { ...f, amount: BigInt(f.amount) } });
      }
    }
    const { receipt } = reconcile({ treeId, asset: tree.asset, closed: tree.state !== "open", flows });
    // Locks closed before identifiers were recorded on the flow: take the one stored on the node.
    const idOf = new Map(Object.entries(tree.masumi_ids ?? {}));
    for (const line of receipt.lines) {
      const id = idOf.get(line.node_id);
      if (line.to.startsWith("masumi:") && line.blockchain_identifier === undefined && id !== undefined) line.blockchain_identifier = id;
    }
    // ADR 0001 8.1: one line per Masumi leaf links the Draw, P's lock, the identifier and the outcome.
    const hasLeaves = receipt.lines.some((l) => l.kind === "masumi");
    const leaves = new Map((hasLeaves ? await masumiLeaves(d.pool, treeId) : []).map((l) => [l.payment_out_ref, l]));
    for (const line of receipt.lines) {
      const leaf = line.payment_out_ref === undefined ? undefined : leaves.get(line.payment_out_ref);
      if (line.kind !== "masumi" || leaf === undefined) continue;
      line.lock_tx = leaf.lock_tx;
      if (leaf.blockchain_identifier !== null) line.blockchain_identifier = leaf.blockchain_identifier;
      line.outcome = leaf.outcome;
      line.outcome_tx = leaf.outcome_tx;
    }
    // A5: the endpoint's PAYMENT-RESPONSE on the payment line of the Draw that paid it. Lines exist
    // only for live events, so a rolled-back Draw carries none.
    attachPaymentResponses(receipt.lines, tree.x402 ?? []);
    return found(signReceipt(receipt, d.oracle));
  }
}

export async function searchAgents(pool: Pool, query: Record<string, string | undefined>): Promise<ReadResult> {
  const q = AgentQuery.safeParse(query);
  if (!q.success) return badRequest(q.error.issues[0]?.message ?? "invalid query");
  const { category, min_rep, rail } = q.data;
  const { rows } = await pool.query<{
    agent_asset_id: string;
    name: string;
    api_url: string;
    categories: string[];
    rails: string[];
    availability: string;
    score: number | null;
    confidence: number | null;
  }>(
    `SELECT a.agent_asset_id, a.name, a.api_url, a.categories, a.rails, a.availability,
            r.score, r.confidence
       FROM agents a
       LEFT JOIN LATERAL (
         SELECT score, confidence FROM reputation
          WHERE agent_asset_id IN (a.agent_asset_id, a.payment_vkh) AND ($1::text IS NULL OR category = $1)
          ORDER BY confidence DESC LIMIT 1) r ON true
      WHERE a.allowlisted AND a.last_seen > 0
        AND ($1::text IS NULL OR $1 = ANY(a.categories))
        AND ($2::text IS NULL OR $2 = ANY(a.rails))
      ORDER BY r.score DESC NULLS LAST, a.name
      LIMIT 200`,
    [category ?? null, rail ?? null],
  );
  const agents = rows
    .map((r) => ({
      agent_asset_id: r.agent_asset_id,
      name: r.name,
      api_url: r.api_url,
      categories: r.categories,
      rails: r.rails.filter((x) => x === "native" || x === "masumi" || x === "metered"),
      availability: r.availability,
      reputation: { score: r.score ?? 0.5, confidence: r.confidence ?? 0 },
    }))
    .filter((a) => min_rep === undefined || a.reputation.score >= min_rep);
  return found({ agents });
}

export async function getAgent(pool: Pool, id: string): Promise<ReadResult> {
  const d = { pool };
  {
    if (!AGENT_ID.test(id)) return badRequest("asset_id must be a registry asset id");
    const a = await d.pool.query<{
      agent_asset_id: string;
      name: string;
      api_url: string;
      payment_vkh: string;
      categories: string[];
      rails: string[];
      capabilities: Record<string, unknown>;
      availability: string;
      last_seen: string;
    }>("SELECT agent_asset_id, name, api_url, payment_vkh, categories, rails, capabilities, availability, last_seen FROM agents WHERE agent_asset_id = $1 AND allowlisted", [id]);
    const agent = a.rows[0];
    if (agent === undefined) return missing("unknown agent");
    const reps = await d.pool.query<{
      category: string;
      delivery_rate: number;
      on_time_rate: number;
      dispute_loss_rate: number;
      verifier_accuracy: number | null;
      volume: string;
      buyer_diversity: number;
      score: number;
      confidence: number;
    }>("SELECT * FROM reputation WHERE agent_asset_id IN ($1, $2) ORDER BY confidence DESC", [agent.agent_asset_id, agent.payment_vkh]);
    const signals: Record<string, Record<string, number>> = {};
    for (const r of reps.rows) {
      signals[r.category] = {
        delivery_rate: r.delivery_rate,
        on_time_rate: r.on_time_rate,
        dispute_loss_rate: r.dispute_loss_rate,
        ...(r.verifier_accuracy === null ? {} : { verifier_accuracy: r.verifier_accuracy }),
        volume: Number(r.volume),
        buyer_diversity: r.buyer_diversity,
        score: r.score,
        confidence: r.confidence,
      };
    }
    const best = reps.rows[0];
    return found({
      agent_asset_id: agent.agent_asset_id,
      name: agent.name,
      api_url: agent.api_url,
      categories: agent.categories,
      rails: agent.rails.filter((x) => x === "native" || x === "masumi" || x === "metered"),
      availability: agent.availability,
      reputation: { score: best?.score ?? 0.5, confidence: best?.confidence ?? 0 },
      payment_vkh: agent.payment_vkh,
      capabilities: agent.capabilities,
      signals,
      last_seen: Number(agent.last_seen),
    });
  }
}

/** `origin` builds `download_url`; `referenceUnit` is the CIP-68 reference NFT that carries the root. */
export async function getLatestSnapshot(pool: Pool, origin: string, referenceUnit?: string): Promise<ReadResult> {
  const d = { pool };
  {
    const { rows } = await d.pool.query<{ snapshot_root: string; tx_id: string; slot: string; created_at: string }>(
      "SELECT snapshot_root, tx_id, slot, created_at FROM reputation_snapshots WHERE tx_id IS NOT NULL AND slot IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    );
    const s = rows[0];
    if (s === undefined) return missing("no anchored snapshot yet");
    return found({
      snapshot_root: s.snapshot_root,
      tx_id: s.tx_id,
      slot: Number(s.slot),
      download_url: `${origin}/v1/reputation/snapshot/${s.snapshot_root}`,
      created_at: Number(s.created_at),
      // CIP-68 reference NFT whose inline datum carries the current root (PRD 12.4).
      ...(referenceUnit === undefined ? {} : { reference_unit: referenceUnit }),
    });
  }
}

/** What snapshot `root` was computed from (PRD 12.4); null for snapshots made before inputs were published. */
export async function getSnapshotInputs(pool: Pool, root: string): Promise<ReadResult> {
  if (!/^[0-9a-f]{64}$/.test(root)) return badRequest("root must be 32-byte hex");
  const { rows } = await pool.query<{ inputs: unknown }>("SELECT inputs FROM reputation_snapshots WHERE snapshot_root = $1", [root]);
  if (rows[0] === undefined) return missing("unknown snapshot");
  if (rows[0].inputs === null) return missing("this snapshot predates published inputs");
  return found(rows[0].inputs);
}

export async function getSnapshot(pool: Pool, root: string): Promise<ReadResult> {
  const d = { pool };
  {
    if (!/^[0-9a-f]{64}$/.test(root)) return badRequest("root must be 32-byte hex");
    const { rows } = await d.pool.query<{ body: unknown }>("SELECT body FROM reputation_snapshots WHERE snapshot_root = $1", [root]);
    if (rows[0] === undefined) return missing("unknown snapshot");
    return found(rows[0].body);
  }
}

