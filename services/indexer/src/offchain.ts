/**
 * Off-chain facts the orchestrator reports next to the chain mirror: the x402 PAYMENT-RESPONSE a
 * third-party endpoint returned for a Draw that paid it (A5), and the reason document behind a
 * Challenge's on-chain reason_hash (A8). Both are keyed to a transaction and served only while that
 * transaction's events are live, so a rollback hides them and a replay brings them back.
 */
import { jcsSha256Hex } from "@cascade/shared/browser";
import type { Queryable } from "@cascade/service-kit/db";

/** A reason of this kind is the orchestrator's L0 check (output schema and hash) failing. */
const L0_REASON_KIND = "schema";

export interface PaymentResult {
  draw_tx: string;
  node_id: string;
  tree_id: string;
  payment_response: Record<string, unknown> | string;
}

/** First write wins: a retry with the same response is a no-op, a different one is a conflict. */
export async function recordPaymentResponse(db: Queryable, r: PaymentResult, now: number): Promise<"stored" | "conflict"> {
  const response = JSON.stringify(r.payment_response);
  const inserted = await db.query(
    `INSERT INTO x402_results (draw_tx, node_id, tree_id, payment_response, recorded_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (draw_tx, node_id) DO NOTHING RETURNING 1`,
    [r.draw_tx, r.node_id, r.tree_id, response, now],
  );
  if (inserted.rows.length > 0) return "stored";
  const same = await db.query("SELECT 1 FROM x402_results WHERE draw_tx = $1 AND node_id = $2 AND tree_id = $3 AND payment_response = $4::jsonb", [
    r.draw_tx,
    r.node_id,
    r.tree_id,
    response,
  ]);
  return same.rows.length > 0 ? "stored" : "conflict";
}

/** The node's recorded payment responses whose Draw is indexed and not rolled back (a `chain.rollback` event names the undone tx, so it does not count). */
export async function paymentResultsFor(db: Queryable, treeId: string, nodeId: string): Promise<Omit<PaymentResult, "tree_id">[]> {
  const { rows } = await db.query<Omit<PaymentResult, "tree_id">>(
    `SELECT r.draw_tx, r.node_id, r.payment_response FROM x402_results r
      WHERE r.tree_id = $1 AND r.node_id = $2
        AND EXISTS (SELECT 1 FROM node_events e
                     WHERE e.tx_id = r.draw_tx AND e.tree_id = r.tree_id AND NOT e.rolled_back AND e.type <> 'chain.rollback')
      ORDER BY r.recorded_at, r.draw_tx`,
    [treeId, nodeId],
  );
  return rows;
}

/**
 * Attaches each recorded response to the payment line (`fee` or `masumi`) its Draw produced: the line
 * of the same node, or the Draw's only recorded response when the reporter named another node.
 */
export function attachPaymentResponses<L extends { node_id: string; kind: string; tx_id: string; payment_response?: unknown }>(
  lines: L[],
  results: readonly Omit<PaymentResult, "tree_id">[],
): void {
  const byTx = new Map<string, Omit<PaymentResult, "tree_id">[]>();
  for (const r of results) byTx.set(r.draw_tx, [...(byTx.get(r.draw_tx) ?? []), r]);
  for (const line of lines) {
    if (line.kind !== "fee" && line.kind !== "masumi") continue;
    const forTx = byTx.get(line.tx_id);
    if (forTx === undefined) continue;
    const match = forTx.find((r) => r.node_id === line.node_id) ?? (forTx.length === 1 ? forTx[0] : undefined);
    if (match !== undefined) line.payment_response = match.payment_response;
  }
}

export interface ChallengeReason {
  tree_id: string;
  node_id: string;
  challenge_tx: string;
  reason: Record<string, unknown>;
}

export type ChallengeReasonOutcome = { ok: true; reason_hash: string; indexed: boolean; eventIds: number[] } | { ok: false; reason_hash: string; detail: string };

/**
 * Stores a challenge's reason document once its JCS SHA-256 is known, and writes the L0 verdict event
 * when the challenge is already indexed. A reason for a challenge not yet seen is kept and matched
 * when the projector applies it.
 */
export async function recordChallengeReason(db: Queryable, r: ChallengeReason, now: number): Promise<ChallengeReasonOutcome> {
  const reasonHash = jcsSha256Hex(r.reason);
  const { rows } = await db.query<{ event_id: string; reason_hash: string | null }>(
    `SELECT event_id, payload->>'reason_hash' AS reason_hash FROM node_events
      WHERE node_id = $1 AND tree_id = $2 AND tx_id = $3 AND type = 'node.challenged' AND NOT rolled_back
      ORDER BY event_id DESC LIMIT 1`,
    [r.node_id, r.tree_id, r.challenge_tx],
  );
  const challenge = rows[0];
  if (challenge !== undefined && challenge.reason_hash !== reasonHash) {
    return { ok: false, reason_hash: reasonHash, detail: "the reason does not hash to the challenge's on-chain reason_hash" };
  }
  await db.query(
    `INSERT INTO challenge_reasons (node_id, reason_hash, tree_id, challenge_tx, reason, recorded_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (node_id, reason_hash) DO NOTHING`,
    [r.node_id, reasonHash, r.tree_id, r.challenge_tx, JSON.stringify(r.reason), now],
  );
  if (challenge === undefined) return { ok: true, reason_hash: reasonHash, indexed: false, eventIds: [] };
  return { ok: true, reason_hash: reasonHash, indexed: true, eventIds: await emitL0Verdicts(db, [Number(challenge.event_id)], now) };
}

/**
 * For each given live `node.challenged` event whose reason is a stored L0 failure, writes one
 * `node.verified` reject (verifier `L0`, evidence_hash the reason hash). Per PRD 17.3 an off-chain
 * status event names the tx that created the node; it carries the challenge's slot and block, so a
 * rollback of the challenge undoes it too. The partial unique index keeps it to one live event.
 */
export async function emitL0Verdicts(db: Queryable, challengeEventIds: number[], emittedAt: number): Promise<number[]> {
  if (challengeEventIds.length === 0) return [];
  const { rows } = await db.query<{ event_id: string }>(
    `INSERT INTO node_events (node_id, tree_id, type, tx_id, slot, block_hash, block_height, value_delta, payload, emitted_at)
     SELECT e.node_id, e.tree_id, 'node.verified', n.created_tx, e.slot, e.block_hash, e.block_height,
            jsonb_build_object('asset', t.asset, 'amount', '0'),
            jsonb_build_object('verdict', 'reject', 'verifier', 'L0', 'evidence_hash', e.payload->>'reason_hash', '_flows', '[]'::jsonb),
            $2
       FROM node_events e
       JOIN challenge_reasons r ON r.node_id = e.node_id AND r.reason_hash = e.payload->>'reason_hash' AND r.reason->>'kind' = $3
       JOIN nodes n ON n.node_id = e.node_id
       JOIN trees t ON t.tree_id = e.tree_id
      WHERE e.event_id = ANY($1) AND e.type = 'node.challenged' AND NOT e.rolled_back
      ORDER BY e.event_id
     ON CONFLICT (node_id, (payload->>'evidence_hash')) WHERE type = 'node.verified' AND NOT rolled_back DO NOTHING
     RETURNING event_id`,
    [challengeEventIds, emittedAt, L0_REASON_KIND],
  );
  return rows.map((r) => Number(r.event_id));
}

export interface ChallengeView {
  tx_id: string;
  challenger: string;
  reason_hash: string;
  bond_lovelace: string;
  verdict: "reject";
  /** `L0` when the reason is the orchestrator's schema and hash check; null when unknown or another kind. */
  level: "L0" | null;
  /** The reason document whose JCS SHA-256 is `reason_hash`; null until the challenger reports it. */
  reason: Record<string, unknown> | null;
}

/** The node's latest live challenge with its reason, or null. */
export async function challengeFor(db: Queryable, nodeId: string): Promise<ChallengeView | null> {
  const { rows } = await db.query<{ tx_id: string; payload: { reason_hash: string; challenger: string; bond_lovelace: string }; reason: Record<string, unknown> | null }>(
    `SELECT e.tx_id, e.payload, r.reason FROM node_events e
       LEFT JOIN challenge_reasons r ON r.node_id = e.node_id AND r.reason_hash = e.payload->>'reason_hash'
      WHERE e.node_id = $1 AND e.type = 'node.challenged' AND NOT e.rolled_back
      ORDER BY e.event_id DESC LIMIT 1`,
    [nodeId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    tx_id: row.tx_id,
    challenger: row.payload.challenger,
    reason_hash: row.payload.reason_hash,
    bond_lovelace: row.payload.bond_lovelace,
    verdict: "reject",
    level: row.reason?.kind === L0_REASON_KIND ? "L0" : null,
    reason: row.reason,
  };
}
