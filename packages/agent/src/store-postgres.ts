/**
 * Postgres job store. One row per job keyed by `(agent_id, job_id)`, the full record as JSONB,
 * and indexed columns for the lookups the server needs. Updates run inside a transaction with
 * `SELECT ... FOR UPDATE`, so two processes serving the same agent cannot interleave a status change.
 */
import type { Pool, PoolClient } from "pg";
import type { Quote } from "@cascade/shared/browser";
import { DuplicateJobError, JobNotFoundError, type JobStore } from "./store.js";
import type { JobStatus } from "./status.js";
import type { JobRecord } from "./types.js";

const IDENT_RE = /^[a-z_][a-z0-9_]{0,40}$/;

export interface PostgresJobStoreOptions {
  pool: Pool;
  /** Registry asset id (or any stable name) that scopes rows when several agents share a database. */
  agentId: string;
  /** Table name prefix; letters, digits and underscores only. */
  tablePrefix?: string;
}

export class PostgresJobStore implements JobStore {
  private readonly pool: Pool;
  private readonly agentId: string;
  private readonly jobs: string;
  private readonly quotes: string;

  constructor(options: PostgresJobStoreOptions) {
    const prefix = options.tablePrefix ?? "cascade_agent";
    if (!IDENT_RE.test(prefix)) throw new Error("tablePrefix must be a lowercase SQL identifier");
    this.pool = options.pool;
    this.agentId = options.agentId;
    this.jobs = `${prefix}_jobs`;
    this.quotes = `${prefix}_quotes`;
  }

  /**
   * Several agents sharing one database migrate at boot. `CREATE ... IF NOT EXISTS` alone races on
   * the pg_type catalog row, so the DDL runs in one transaction behind an advisory lock keyed on the table name.
   */
  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [this.jobs]);
      await this.createTables(client);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  private async createTables(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${this.jobs} (
        agent_id text NOT NULL,
        job_id text NOT NULL,
        status text NOT NULL,
        payment_key text,
        tree_id text,
        node_id text,
        record jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (agent_id, job_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ${this.jobs}_payment_key ON ${this.jobs} (agent_id, payment_key) WHERE payment_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS ${this.jobs}_node ON ${this.jobs} (agent_id, tree_id, node_id);
      CREATE INDEX IF NOT EXISTS ${this.jobs}_status ON ${this.jobs} (agent_id, status);
      CREATE TABLE IF NOT EXISTS ${this.quotes} (
        agent_id text NOT NULL,
        quote_id text NOT NULL,
        quote jsonb NOT NULL,
        PRIMARY KEY (agent_id, quote_id)
      );
    `);
  }

  async create(job: JobRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO ${this.jobs} (agent_id, job_id, status, payment_key, tree_id, node_id, record) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [this.agentId, job.job_id, job.status, job.payment.payment_key, job.node?.tree_id ?? null, job.node?.node_id ?? null, JSON.stringify(job)],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new DuplicateJobError(job.payment.payment_key ?? job.job_id);
      throw e;
    }
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const { rows } = await this.pool.query<{ record: JobRecord }>(`SELECT record FROM ${this.jobs} WHERE agent_id = $1 AND job_id = $2`, [this.agentId, jobId]);
    return rows[0]?.record ?? null;
  }

  async update(jobId: string, mutate: (job: JobRecord) => JobRecord): Promise<JobRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const next = await this.updateIn(client, jobId, mutate);
      await client.query("COMMIT");
      return next;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  private async updateIn(client: PoolClient, jobId: string, mutate: (job: JobRecord) => JobRecord): Promise<JobRecord> {
    const { rows } = await client.query<{ record: JobRecord }>(`SELECT record FROM ${this.jobs} WHERE agent_id = $1 AND job_id = $2 FOR UPDATE`, [
      this.agentId,
      jobId,
    ]);
    const current = rows[0]?.record;
    if (current === undefined) throw new JobNotFoundError(jobId);
    const next = mutate(current);
    await client.query(
      `UPDATE ${this.jobs} SET status = $3, payment_key = $4, tree_id = $5, node_id = $6, record = $7, updated_at = now() WHERE agent_id = $1 AND job_id = $2`,
      [this.agentId, jobId, next.status, next.payment.payment_key, next.node?.tree_id ?? null, next.node?.node_id ?? null, JSON.stringify(next)],
    );
    return next;
  }

  async findByPaymentKey(paymentKey: string): Promise<JobRecord | null> {
    const { rows } = await this.pool.query<{ record: JobRecord }>(`SELECT record FROM ${this.jobs} WHERE agent_id = $1 AND payment_key = $2`, [
      this.agentId,
      paymentKey,
    ]);
    return rows[0]?.record ?? null;
  }

  async findByNode(treeId: string, nodeId: string): Promise<JobRecord | null> {
    const { rows } = await this.pool.query<{ record: JobRecord }>(
      `SELECT record FROM ${this.jobs} WHERE agent_id = $1 AND tree_id = $2 AND node_id = $3 ORDER BY updated_at DESC LIMIT 1`,
      [this.agentId, treeId, nodeId],
    );
    return rows[0]?.record ?? null;
  }

  async listByStatus(statuses: readonly JobStatus[]): Promise<JobRecord[]> {
    const { rows } = await this.pool.query<{ record: JobRecord }>(`SELECT record FROM ${this.jobs} WHERE agent_id = $1 AND status = ANY($2)`, [
      this.agentId,
      [...statuses],
    ]);
    return rows.map((r) => r.record);
  }

  async putQuote(quote: Quote): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.quotes} (agent_id, quote_id, quote) VALUES ($1, $2, $3) ON CONFLICT (agent_id, quote_id) DO UPDATE SET quote = EXCLUDED.quote`,
      [this.agentId, quote.quote_id, JSON.stringify(quote)],
    );
  }

  async getQuote(quoteId: string): Promise<Quote | null> {
    const { rows } = await this.pool.query<{ quote: Quote }>(`SELECT quote FROM ${this.quotes} WHERE agent_id = $1 AND quote_id = $2`, [this.agentId, quoteId]);
    return rows[0]?.quote ?? null;
  }
}
