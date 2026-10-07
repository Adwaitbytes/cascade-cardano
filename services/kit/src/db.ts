/**
 * Postgres access: a pool, a transaction helper and a small migration runner. Migrations run under
 * a session advisory lock, so several services starting at once apply each migration exactly once.
 * Every query is parameterised.
 */
import pg from "pg";
import type { Logger } from "./logger.js";
import { MIGRATIONS, type Migration } from "./migrations.js";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

// Postgres int8 and numeric arrive as strings; amounts are converted with BigInt() at the edge.
// Transaction-scoped; differs from the old session-lock key so a leaked session lock cannot block it.
const MIGRATION_LOCK_KEY = 0x0c45cadf;

/** Code and message only: a pg error never carries the connection string, and query text stays out of logs. */
function logConnectionError(log: Logger | undefined, source: "pool" | "client", err: Error): void {
  const code = (err as { code?: unknown }).code;
  log?.warn({ source, code: typeof code === "string" ? code : undefined, error: err.message }, "postgres connection error; the pool replaces the client");
}

export function createPool(connectionString: string, max = 10, log?: Logger): Pool {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, keepAlive: true });
  // An idle client error must not crash the process; the pool replaces the client.
  pool.on("error", (err) => logConnectionError(log, "pool", err));
  return pool;
}

/**
 * Checks out a client with an 'error' listener for as long as it is held. pg-pool only listens on
 * idle clients; a socket reset (Neon dropping a TLS connection) on a checked-out client otherwise
 * surfaces as an unhandled 'error' event and kills the process. A client that errored is released
 * with the error so the pool destroys it.
 */
export async function withClient<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>, log?: Logger): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  const onError = (err: Error): void => {
    broken = err;
    logConnectionError(log, "client", err);
  };
  client.on("error", onError);
  try {
    return await fn(client);
  } finally {
    client.off("error", onError);
    client.release(broken ?? false);
  }
}

export function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>, log?: Logger): Promise<T> {
  return withClient(pool, (client) => transaction(client, fn), log);
}

async function transaction<T>(client: PoolClient, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

/**
 * Applies pending migrations in one transaction under a transaction-scoped advisory lock. A
 * session lock would leak through a transaction-pooling endpoint (Neon's `-pooler`, PgBouncer) when
 * a process is killed mid-migration and block every later start; a transaction lock cannot.
 */
export function migrate(pool: Pool, log?: Logger, migrations: readonly Migration[] = MIGRATIONS): Promise<number[]> {
  return withClient(pool, (client) => migrateOn(client, migrations, log), log);
}

async function migrateOn(client: PoolClient, migrations: readonly Migration[], log?: Logger): Promise<number[]> {
  const applied: number[] = [];
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ id: number }>("SELECT id FROM schema_migrations");
    const done = new Set(rows.map((r) => r.id));
    for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
      if (done.has(m.id)) continue;
      try {
        await client.query(m.sql);
      } catch (e) {
        throw new Error(`migration ${m.id} ${m.name} failed: ${(e as Error).message}`);
      }
      await client.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [m.id, m.name]);
      applied.push(m.id);
    }
    await client.query("COMMIT");
    for (const id of applied) log?.info({ migration: id, name: migrations.find((m) => m.id === id)?.name }, "applied migration");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
  return applied;
}

/** Parses a Postgres numeric/int8 string into a bigint. */
export function big(value: string | number | bigint | null): bigint {
  if (value === null) throw new TypeError("unexpected null amount");
  return typeof value === "bigint" ? value : BigInt(value);
}
