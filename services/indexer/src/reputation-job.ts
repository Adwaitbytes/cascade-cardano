/**
 * Recomputes reputation from settled nodes, writes the `reputation` table, and publishes a signed
 * snapshot (Merkle root) that can be anchored on chain, together with its inputs (PRD 12.4).
 *
 * The score is computed only through `reputationFromInputs` over the published inputs, so the
 * anchored root is exactly what anyone gets from chain history plus those inputs:
 * - outcomes: each Settled or Refunded node's own on-chain events;
 * - specs: the spec each node was funded under, found by content (any stored plan whose spec hashes
 *   to the node's on-chain spec_hash);
 * - agents: operator payment key to the current registry asset (allowlisted directory rows, seeded
 *   from deployments/agents.<network>.json). Several current assets on one key resolve to the
 *   greatest asset id, deterministically. Re-registered agents keep their key, so their history
 *   merges into the current asset;
 * - verdicts recorded for these nodes; and the scoring parameters, including `now`.
 */
import { bytesToHex, jcsSha256, specHash, planNodesPreOrder, PlanSchema, type NodeSpec } from "@cascade/shared";
import { coseKeyOf, coseSign1, withTransaction, type Pool, type RoleKey, type SlotConfig, slotToPosixMs } from "@cascade/service-kit";
import { DEFAULT_REPUTATION_PARAMS, reputationFromInputs, snapshotEntry, type NodeOutcome, type ReputationRow, type SnapshotInputs } from "./reputation.js";

interface OutcomeRow {
  node_id: string;
  tree_id: string;
  spec_hash: string;
  operator_vkh: string;
  payee: string;
  fee: string;
  state: "Settled" | "Refunded";
  updated_slot: string;
  buyer_vkh: string;
  config: { buyer_refund?: { stake_credential?: { credential?: { hash?: string } } | null } };
  submitted: boolean;
  fee_paid: string | null;
  settled_via_settle: boolean;
  resolved_worker: string | null;
}

/** Specs by content: spec_hash to spec, across every stored plan. */
async function specsByHash(pool: Pool): Promise<Map<string, NodeSpec>> {
  const out = new Map<string, NodeSpec>();
  const { rows } = await pool.query<{ json: unknown }>("SELECT json FROM plans");
  for (const r of rows) {
    const parsed = PlanSchema.safeParse(r.json);
    if (!parsed.success) continue;
    for (const { node } of planNodesPreOrder(parsed.data.root)) out.set(specHash(node.spec), node.spec);
  }
  return out;
}

/** Everything a snapshot is computed from, read once from the chain mirror and the directory. */
export async function snapshotInputs(pool: Pool, slotConfig: SlotConfig, now: number): Promise<SnapshotInputs> {
  const { rows } = await pool.query<OutcomeRow>(
    `SELECT n.node_id, n.tree_id, n.spec_hash, n.operator_vkh, n.payee, n.fee::text AS fee, n.state, n.updated_slot, t.buyer_vkh, t.config,
            EXISTS (SELECT 1 FROM node_events e WHERE e.node_id = n.node_id AND e.type = 'node.submitted' AND NOT e.rolled_back) AS submitted,
            (SELECT (e.value_delta->>'amount') FROM node_events e WHERE e.node_id = n.node_id AND e.type IN ('node.settled', 'receipt.closed') AND NOT e.rolled_back ORDER BY e.event_id DESC LIMIT 1) AS fee_paid,
            EXISTS (SELECT 1 FROM node_events e WHERE e.node_id = n.node_id AND e.type = 'node.settled' AND NOT e.rolled_back) AS settled_via_settle,
            (SELECT (e.value_delta->>'amount') FROM node_events e WHERE e.node_id = n.node_id AND e.type = 'node.resolved' AND NOT e.rolled_back ORDER BY e.event_id DESC LIMIT 1) AS resolved_worker
       FROM nodes n JOIN trees t ON t.tree_id = n.tree_id
      WHERE n.state IN ('Settled', 'Refunded')
      ORDER BY n.node_id`,
  );
  const nodes: NodeOutcome[] = rows.map((r) => ({
    node_id: r.node_id,
    tree_id: r.tree_id,
    spec_hash: r.spec_hash,
    operator_vkh: r.operator_vkh,
    payee: r.payee,
    buyer_vkh: r.buyer_vkh,
    buyer_stake: r.config.buyer_refund?.stake_credential?.credential?.hash ?? null,
    fee: r.fee,
    state: r.state,
    submitted: r.submitted,
    settled_via_settle: r.settled_via_settle,
    resolved_worker: r.resolved_worker,
    fee_paid: r.fee_paid,
    ended_at: slotToPosixMs(slotConfig, Number(r.updated_slot)),
  }));

  const byHash = await specsByHash(pool);
  const specs = nodes.flatMap((n) => {
    const spec = byHash.get(n.spec_hash);
    return spec === undefined ? [] : [{ node_id: n.node_id, spec_hash: n.spec_hash, spec }];
  });

  const keys = [...new Set(nodes.map((n) => n.operator_vkh))];
  const a = await pool.query<{ payment_vkh: string; agent_asset_id: string; registry_tx: string | null }>(
    `SELECT DISTINCT ON (payment_vkh) payment_vkh, agent_asset_id, registry_tx FROM agents
      WHERE allowlisted AND payment_vkh = ANY($1) ORDER BY payment_vkh, agent_asset_id DESC`,
    [keys],
  );
  const agents = a.rows.map((r) => ({ operator_vkh: r.payment_vkh, agent_asset_id: r.agent_asset_id, registry_asset_tx: r.registry_tx }));

  const v = await pool.query<{ node_id: string; verifier_asset_id: string; verdict: "accept" | "reject"; signature: string }>(
    "SELECT node_id, verifier_asset_id, verdict, signature FROM verdicts WHERE node_id = ANY($1) ORDER BY verdict_id",
    [nodes.map((n) => n.node_id)],
  );
  // The verdicts table stores the COSE_Sign1 only; its key is not recorded separately.
  const verdicts = v.rows.map((r) => ({ node_id: r.node_id, verifier_asset_id: r.verifier_asset_id, verdict: r.verdict, signature: r.signature, key: null }));

  const p = DEFAULT_REPUTATION_PARAMS;
  return {
    specs,
    agents,
    verdicts,
    params: { now, half_life_ms: p.halfLifeMs, v_ref: p.vRef.toString(), diversity_cap: p.diversityCap, prior_weight: p.priorWeight },
    nodes,
  };
}

/**
 * Fingerprint of a snapshot's scored rows with a fixed 4-decimal rounding and without `now`, so the
 * continuous drift of time decay between runs does not count as a change.
 */
export function rowsFingerprint(entries: readonly Record<string, string | number | null>[]): string {
  const coarse = entries.map((e) =>
    Object.fromEntries(Object.entries(e).map(([k, v]) => [k, typeof v === "string" && /^-?\d+\.\d+$/.test(v) ? Number(v).toFixed(4) : v])),
  );
  return bytesToHex(jcsSha256(coarse));
}

/** Minimum time between anchors (one CIP-68 update transaction each). */
export const ANCHOR_MIN_INTERVAL_MS = 30 * 60 * 1000;

/** Anchor only when the rows changed (by fingerprint) and the last anchor is old enough. */
export function shouldAnchor(
  last: { entries: readonly Record<string, string | number | null>[]; created_at: number } | null,
  current: { entries: readonly Record<string, string | number | null>[]; created_at: number },
  minIntervalMs = ANCHOR_MIN_INTERVAL_MS,
): boolean {
  if (last === null) return true;
  if (current.created_at - last.created_at < minIntervalMs) return false;
  return rowsFingerprint(last.entries) !== rowsFingerprint(current.entries);
}

/** The newest snapshot already anchored on chain, if any. */
export async function lastAnchored(pool: Pool): Promise<Snapshot | null> {
  const { rows } = await pool.query<{ body: Snapshot }>("SELECT body FROM reputation_snapshots WHERE tx_id IS NOT NULL ORDER BY created_at DESC LIMIT 1");
  return rows[0]?.body ?? null;
}

export interface Snapshot {
  snapshot_root: string;
  created_at: number;
  entries: Record<string, string | number | null>[];
  key: string;
  signature: string;
}

export async function recomputeReputation(pool: Pool, slotConfig: SlotConfig, oracle: RoleKey | null, now = Date.now()): Promise<{ rows: ReputationRow[]; snapshot: Snapshot | null; inputs: SnapshotInputs }> {
  const inputs = await snapshotInputs(pool, slotConfig, now);
  const { rows, root } = reputationFromInputs(inputs, inputs.nodes);
  let snapshot: Snapshot | null = null;
  if (oracle !== null) {
    const body = { snapshot_root: root, created_at: now, entries: rows.map(snapshotEntry), key: coseKeyOf(oracle) };
    snapshot = { ...body, signature: coseSign1(jcsSha256(body), oracle).signature };
  }
  await withTransaction(pool, async (c) => {
    for (const r of rows) {
      await c.query(
        `INSERT INTO reputation (agent_asset_id, category, delivery_rate, on_time_rate, dispute_loss_rate, verifier_accuracy, volume, buyer_diversity, score, confidence, snapshot_root, nodes_counted, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (agent_asset_id, category) DO UPDATE SET delivery_rate = EXCLUDED.delivery_rate, on_time_rate = EXCLUDED.on_time_rate,
           dispute_loss_rate = EXCLUDED.dispute_loss_rate, verifier_accuracy = EXCLUDED.verifier_accuracy, volume = EXCLUDED.volume,
           buyer_diversity = EXCLUDED.buyer_diversity, score = EXCLUDED.score, confidence = EXCLUDED.confidence,
           snapshot_root = EXCLUDED.snapshot_root, nodes_counted = EXCLUDED.nodes_counted, computed_at = EXCLUDED.computed_at`,
        [r.agent_asset_id, r.category, r.delivery_rate, r.on_time_rate, r.dispute_loss_rate, r.verifier_accuracy, r.volume.toString(), r.buyer_diversity, r.score, r.confidence, root, r.nodes_counted, now],
      );
    }
    if (snapshot !== null) {
      await c.query(
        "INSERT INTO reputation_snapshots (snapshot_root, body, key, signature, created_at, inputs) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (snapshot_root) DO NOTHING",
        [root, JSON.stringify(snapshot), snapshot.key, snapshot.signature, now, JSON.stringify(inputs)],
      );
    }
  });
  return { rows, snapshot, inputs };
}
