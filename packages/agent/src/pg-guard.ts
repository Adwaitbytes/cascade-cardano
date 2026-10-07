/**
 * A pg client whose socket dies emits 'error'; with no listener Node turns that into an uncaught
 * exception and the whole process exits. pg-pool forwards idle-client errors to the pool, and a
 * checked-out client emits on itself, so both need a listener. A transient database drop (Neon
 * resetting idle TLS connections) must cost one failed query at most, never the process.
 */
import type { Pool, PoolClient } from "pg";

export type PgErrorSink = (err: Error, source: "pool" | "client") => void;

/** One JSON line on stderr with the error code and message only: no connection string, no query text. */
export const logPgError: PgErrorSink = (err, source) => {
  const code = (err as { code?: unknown }).code;
  process.stderr.write(
    `${JSON.stringify({ level: "warn", time: new Date().toISOString(), msg: "postgres connection error; the pool replaces the client", source, code: typeof code === "string" ? code : undefined, error: err.message })}\n`,
  );
};

const guarded = new WeakSet<Pool>();

/** Attaches one 'error' listener to the pool (idempotent) and returns it. */
export function guardPool<P extends Pool>(pool: P, sink: PgErrorSink = logPgError): P {
  if (guarded.has(pool)) return pool;
  guarded.add(pool);
  pool.on("error", (err) => sink(err, "pool"));
  return pool;
}

/**
 * Checks out a client for `fn`, listening for socket errors while it is held. A client that
 * errored is released with the error so the pool destroys it instead of handing it out again.
 */
export async function withPgClient<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>, sink: PgErrorSink = logPgError): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  const onError = (err: Error): void => {
    broken = err;
    sink(err, "client");
  };
  client.on("error", onError);
  try {
    return await fn(client);
  } finally {
    client.off("error", onError);
    client.release(broken ?? false);
  }
}

/** BEGIN, `fn`, COMMIT on a guarded client; ROLLBACK on failure (skipped when the socket is gone). */
export function withPgTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>, sink: PgErrorSink = logPgError): Promise<T> {
  return withPgClient(
    pool,
    async (client) => {
      await client.query("BEGIN");
      try {
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
    },
    sink,
  );
}
