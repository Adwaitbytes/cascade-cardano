/**
 * Conductor state in Postgres: drafted plans (with their tree once funded) and the hire ledger,
 * so a restarted Conductor resumes its Temporal workflows with nothing lost (A15).
 */
import type { Pool } from "pg";
import type { PlanStore, StoredPlan } from "../api/store.js";
import type { HireLedger, HireLedgerEntry } from "./hire-ledger.js";

const IDENT = /^[a-z_][a-z0-9_]{0,40}$/;

/** bigint-safe JSON for JSONB columns: bigints become `{"$bigint": "123"}` and come back as bigint. */
const encode = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? { $bigint: x.toString() } : x));
const decode = <T>(v: unknown): T =>
  JSON.parse(JSON.stringify(v), (_k, x: unknown) =>
    typeof x === "object" && x !== null && !Array.isArray(x) && Object.keys(x).length === 1 && typeof (x as { $bigint?: unknown }).$bigint === "string" ? BigInt((x as { $bigint: string }).$bigint) : x,
  ) as T;

export async function migrateOrchestratorState(pool: Pool, prefix = "orchestrator"): Promise<void> {
  if (!IDENT.test(prefix)) throw new Error("prefix must be a lowercase SQL identifier");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${prefix}_plans (
      plan_id text PRIMARY KEY,
      tree_id text UNIQUE,
      funded boolean NOT NULL DEFAULT false,
      record jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ${prefix}_hires (
      key text PRIMARY KEY,
      tree_id text NOT NULL,
      node_id text NOT NULL,
      record jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ${prefix}_hires_tree ON ${prefix}_hires (tree_id);
  `);
}

export class PostgresPlanStore implements PlanStore {
  private readonly table: string;
  constructor(
    private readonly pool: Pool,
    prefix = "orchestrator",
  ) {
    if (!IDENT.test(prefix)) throw new Error("prefix must be a lowercase SQL identifier");
    this.table = `${prefix}_plans`;
  }

  async put(plan: StoredPlan): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table} (plan_id, tree_id, funded, record) VALUES ($1, $2, $3, $4)
       ON CONFLICT (plan_id) DO UPDATE SET tree_id = EXCLUDED.tree_id, funded = EXCLUDED.funded, record = EXCLUDED.record, updated_at = now()`,
      [plan.built.plan.plan_id, plan.tree_id, plan.funded, encode(plan)],
    );
  }

  async get(planId: string): Promise<StoredPlan | null> {
    const { rows } = await this.pool.query<{ record: unknown }>(`SELECT record FROM ${this.table} WHERE plan_id = $1`, [planId]);
    return rows[0] === undefined ? null : decode<StoredPlan>(rows[0].record);
  }

  async update(planId: string, mutate: (p: StoredPlan) => StoredPlan): Promise<StoredPlan> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ record: unknown }>(`SELECT record FROM ${this.table} WHERE plan_id = $1 FOR UPDATE`, [planId]);
      if (rows[0] === undefined) throw new Error(`plan ${planId} does not exist`);
      const next = mutate(decode<StoredPlan>(rows[0].record));
      await client.query(`UPDATE ${this.table} SET tree_id = $2, funded = $3, record = $4, updated_at = now() WHERE plan_id = $1`, [planId, next.tree_id, next.funded, encode(next)]);
      await client.query("COMMIT");
      return next;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async assignTree(planId: string, treeId: string): Promise<"assigned" | "tree_funded"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialises concurrent claims on one tree id, including the case where no row holds it yet.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${this.table}:${treeId}`]);
      const { rows } = await client.query<{ plan_id: string; funded: boolean; record: unknown }>(
        `SELECT plan_id, funded, record FROM ${this.table} WHERE (tree_id = $1 AND plan_id <> $2) OR plan_id = $2 FOR UPDATE`,
        [treeId, planId],
      );
      const target = rows.find((r) => r.plan_id === planId);
      if (target === undefined) throw new Error(`plan ${planId} does not exist`);
      const holder = rows.find((r) => r.plan_id !== planId);
      if (holder?.funded === true) {
        await client.query("ROLLBACK");
        return "tree_funded";
      }
      if (holder !== undefined) {
        const released = { ...decode<StoredPlan>(holder.record), tree_id: null };
        await client.query(`UPDATE ${this.table} SET tree_id = NULL, record = $2, updated_at = now() WHERE plan_id = $1`, [holder.plan_id, encode(released)]);
      }
      const next = { ...decode<StoredPlan>(target.record), tree_id: treeId };
      await client.query(`UPDATE ${this.table} SET tree_id = $2, record = $3, updated_at = now() WHERE plan_id = $1`, [planId, treeId, encode(next)]);
      await client.query("COMMIT");
      return "assigned";
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async awaitingFunding(): Promise<string[]> {
    const { rows } = await this.pool.query<{ plan_id: string }>(`SELECT plan_id FROM ${this.table} WHERE NOT funded AND tree_id IS NOT NULL`);
    return rows.map((r) => r.plan_id);
  }

  async byTree(treeId: string): Promise<StoredPlan | null> {
    const { rows } = await this.pool.query<{ record: unknown }>(`SELECT record FROM ${this.table} WHERE tree_id = $1`, [treeId]);
    return rows[0] === undefined ? null : decode<StoredPlan>(rows[0].record);
  }
}

export class PostgresHireLedger implements HireLedger {
  private readonly table: string;
  constructor(
    private readonly pool: Pool,
    prefix = "orchestrator",
  ) {
    if (!IDENT.test(prefix)) throw new Error("prefix must be a lowercase SQL identifier");
    this.table = `${prefix}_hires`;
  }

  // The payment is kept as JSON text: JSONB reorders keys, and a resent PAYMENT-SIGNATURE must be
  // byte-identical (agents and facilitators key paid retries on the exact header).
  async get(key: string): Promise<HireLedgerEntry | null> {
    const { rows } = await this.pool.query<{ record: unknown }>(`SELECT record FROM ${this.table} WHERE key = $1`, [key]);
    if (rows[0] === undefined) return null;
    const { payment_text, ...rest } = decode<Omit<HireLedgerEntry, "payment"> & { payment_text: string | null }>(rows[0].record);
    return { ...rest, payment: payment_text === null ? null : (JSON.parse(payment_text) as HireLedgerEntry["payment"]) };
  }

  async put(entry: HireLedgerEntry): Promise<void> {
    const { payment, ...rest } = entry;
    await this.pool.query(
      `INSERT INTO ${this.table} (key, tree_id, node_id, record) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET record = EXCLUDED.record, node_id = EXCLUDED.node_id, updated_at = now()`,
      [entry.key, entry.tree_id, entry.node_id, encode({ ...rest, payment_text: payment === null ? null : JSON.stringify(payment) })],
    );
  }
}
