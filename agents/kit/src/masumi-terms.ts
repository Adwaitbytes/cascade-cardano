/**
 * Postgres `MasumiTermsStorage` for `withMasumiOffers` (@cascade/x402): issued Masumi quotes must
 * survive restarts and be shared by every replica, with an atomic read-modify-write per terms digest
 * (x402 Cardano spec 5, logical replay). Records are stored as JSON text so they round-trip exactly.
 */
import type { Pool } from "pg";
import type { MasumiTermsStorage } from "@x402/cardano";

type Terms = NonNullable<Awaited<ReturnType<MasumiTermsStorage["get"]>>>;
type UpdateResult = Awaited<ReturnType<MasumiTermsStorage["updateTerms"]>>;

export class PostgresMasumiTermsStorage implements MasumiTermsStorage {
  constructor(
    private readonly pool: Pool,
    private readonly table = "masumi_terms",
  ) {
    if (!/^[a-z_][a-z0-9_]{0,40}$/.test(table)) throw new Error("table must be a lowercase SQL identifier");
  }

  async migrate(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.table} (terms_digest text PRIMARY KEY, record text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
  }

  async get(termsDigest: string): Promise<Terms | undefined> {
    const { rows } = await this.pool.query<{ record: string }>(`SELECT record FROM ${this.table} WHERE terms_digest = $1`, [termsDigest]);
    return rows[0] === undefined ? undefined : (JSON.parse(rows[0].record) as Terms);
  }

  async updateTerms(termsDigest: string, update: (current: Terms | undefined) => Terms | undefined): Promise<UpdateResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialises writers of this digest across processes, including when no row exists yet.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [termsDigest]);
      const { rows } = await client.query<{ record: string }>(`SELECT record FROM ${this.table} WHERE terms_digest = $1`, [termsDigest]);
      const current = rows[0] === undefined ? undefined : (JSON.parse(rows[0].record) as Terms);
      const next = update(current);
      let status: UpdateResult["status"];
      if (next === undefined) {
        if (current !== undefined) await client.query(`DELETE FROM ${this.table} WHERE terms_digest = $1`, [termsDigest]);
        status = current === undefined ? "unchanged" : "deleted";
      } else if (next === current) {
        status = "unchanged";
      } else {
        await client.query(
          `INSERT INTO ${this.table} (terms_digest, record) VALUES ($1, $2) ON CONFLICT (terms_digest) DO UPDATE SET record = EXCLUDED.record, updated_at = now()`,
          [termsDigest, JSON.stringify(next)],
        );
        status = "updated";
      }
      await client.query("COMMIT");
      return { terms: next, status };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}
