/**
 * Masumi leaves (ADR 0001 8.1) read from `node_utxos`: the AddressPayment to the purchase wallet P,
 * P's vested_pay lock and its continuations, and the outcome. Type-only imports keep this usable
 * from the light read module.
 */
import type { Pool } from "pg";

type Queryable = Pick<Pool, "query">;

export type MasumiOutcome = "awaiting_lock" | "locked" | "refunded" | "withdrawn";

/** One Masumi leaf (ADR 0001 8.1): the Draw that paid P, P's lock, its identifier and outcome. */
export interface MasumiLeaf {
  node_id: string;
  payment_out_ref: string;
  draw_tx: string;
  value: { lovelace: string; assets: Record<string, string> };
  lock_tx: string | null;
  lock_out_ref: string | null;
  blockchain_identifier: string | null;
  /** vested_pay state of the latest lock output (FundsLocked, RefundRequested, ...). */
  lock_state: string | null;
  outcome: MasumiOutcome;
  outcome_tx: string | null;
}

/** Masumi leaves of a tree, optionally only those drawn by one node, in draw order. */
export async function masumiLeaves(db: Queryable, treeId: string, nodeId?: string): Promise<MasumiLeaf[]> {
  const { rows } = await db.query<{
    node_id: string;
    out_ref: string;
    tx_id: string;
    lovelace: string;
    assets: Record<string, string>;
    first_tx: string | null;
    first_ref: string | null;
    first_id: string | null;
    last_ref: string | null;
    last_state: string | null;
    last_spent: string | null;
    last_terminal: "Refunded" | "Settled" | null;
  }>(
    `SELECT p.node_id, p.out_ref, p.tx_id, p.lovelace::text AS lovelace, p.assets,
            f.tx_id AS first_tx, f.out_ref AS first_ref, f.blockchain_identifier AS first_id,
            l.out_ref AS last_ref, l.datum->>'state' AS last_state, l.spent_tx AS last_spent, l.terminal_state AS last_terminal
       FROM node_utxos p
       LEFT JOIN LATERAL (SELECT tx_id, out_ref, blockchain_identifier FROM node_utxos
                           WHERE kind = 'masumi_lock' AND leaf_ref = p.out_ref ORDER BY slot, seq LIMIT 1) f ON true
       LEFT JOIN LATERAL (SELECT out_ref, datum, spent_tx, terminal_state FROM node_utxos
                           WHERE kind = 'masumi_lock' AND leaf_ref = p.out_ref ORDER BY slot DESC, seq DESC LIMIT 1) l ON true
      WHERE p.kind = 'payment' AND p.tree_id = $1 AND ($2::text IS NULL OR p.node_id = $2)
      ORDER BY p.slot, p.seq`,
    [treeId, nodeId ?? null],
  );
  return rows.map((r) => ({
    node_id: r.node_id,
    payment_out_ref: r.out_ref,
    draw_tx: r.tx_id,
    value: { lovelace: r.lovelace, assets: r.assets },
    lock_tx: r.first_tx,
    lock_out_ref: r.last_ref,
    blockchain_identifier: r.first_id,
    lock_state: r.last_state,
    outcome: r.first_tx === null ? "awaiting_lock" : r.last_terminal === "Refunded" ? "refunded" : r.last_terminal === "Settled" ? "withdrawn" : "locked",
    outcome_tx: r.last_terminal === null ? null : r.last_spent,
  }));
}

/** Out refs of unspent tracked Masumi locks (the poller checks whether they were consumed). */
export async function openMasumiLocks(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ out_ref: string }>("SELECT out_ref FROM node_utxos WHERE kind = 'masumi_lock' AND spent_tx IS NULL");
  return rows.map((r) => r.out_ref);
}
