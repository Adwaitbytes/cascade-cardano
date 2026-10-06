/**
 * Shared settlement claims in Postgres (`x402_claims`, PRD 8.4, T13). One row per canonical tx id;
 * for `masumi` the `terms_digest` is unique, so the first tx id binds the digest for good (x402
 * spec section 5). Any facilitator instance that sees a retry finds the claim and resumes
 * observation instead of broadcasting again.
 */
import type { Pool } from "@cascade/service-kit";

export type ClaimResult = "fresh" | "in-flight" | "submitted" | "confirmed" | "rejected" | "terms-conflict";

export interface ClaimInput {
  txId: string;
  ownerToken: string;
  termsDigest: string | null;
  network: string;
  requirements: unknown;
}

export class PgClaimStore {
  constructor(private readonly pool: Pool) {}

  async claim(c: ClaimInput): Promise<ClaimResult> {
    const ins = await this.pool.query(
      `INSERT INTO x402_claims (terms_digest, tx_id, status, requirements, owner_token, network)
       VALUES ($1, $2, 'in-flight', $3, $4, $5) ON CONFLICT DO NOTHING RETURNING tx_id`,
      [c.termsDigest, c.txId, JSON.stringify(c.requirements), c.ownerToken, c.network],
    );
    if (ins.rows.length === 1) return "fresh";
    const byTx = await this.pool.query<{ status: ClaimResult; terms_digest: string | null }>("SELECT status, terms_digest FROM x402_claims WHERE tx_id = $1", [c.txId]);
    const row = byTx.rows[0];
    if (row !== undefined) {
      if (c.termsDigest !== null && row.terms_digest !== null && row.terms_digest !== c.termsDigest) return "terms-conflict";
      return row.status;
    }
    // No row for this tx: the terms digest is bound to another transaction.
    return "terms-conflict";
  }

  async setStatus(txId: string, ownerToken: string, status: "submitted" | "rejected", payer?: string): Promise<void> {
    await this.pool.query(
      "UPDATE x402_claims SET status = $3, payer = COALESCE($4, payer), updated_at = now() WHERE tx_id = $1 AND owner_token = $2",
      [txId, ownerToken, status, payer === undefined || payer === "" ? null : payer],
    );
  }

  async markConfirmed(txId: string, confirmations: number, payer?: string): Promise<void> {
    await this.pool.query(
      `UPDATE x402_claims SET status = 'confirmed', settled_at = COALESCE(settled_at, now()), confirmations = GREATEST(COALESCE(confirmations, 0), $2),
         payer = COALESCE(payer, $3), updated_at = now() WHERE tx_id = $1`,
      [txId, confirmations, payer === undefined || payer === "" ? null : payer],
    );
  }

  /** The stored settlement for a tx, for retries after its inputs are spent. */
  async get(txId: string): Promise<{ status: ClaimResult; payer: string | null; confirmations: number | null } | null> {
    const { rows } = await this.pool.query<{ status: ClaimResult; payer: string | null; confirmations: number | null }>(
      "SELECT status, payer, confirmations FROM x402_claims WHERE tx_id = $1",
      [txId],
    );
    return rows[0] ?? null;
  }

  /** Releases a claim when no submission happened. Masumi digests stay bound (spec section 5). */
  async release(txId: string, ownerToken: string, keepBinding: boolean): Promise<void> {
    if (keepBinding) await this.setStatus(txId, ownerToken, "rejected");
    else await this.pool.query("DELETE FROM x402_claims WHERE tx_id = $1 AND owner_token = $2", [txId, ownerToken]);
  }
}
