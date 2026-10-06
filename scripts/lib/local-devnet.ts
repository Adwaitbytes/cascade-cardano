// Devnet identity for the local stack. A Yaci reset replays the same genesis, so the first faucet
// top-ups produce the same tx hashes and a wallet's seed UTxO derives the same tree_id as a tree from
// the previous devnet. Any local database row written against an earlier devnet (Conductor plans,
// indexer trees, agent jobs, facilitator claims, watchtower cranks) is then stale and collides.
// The local Postgres records which devnet its rows belong to; when that differs from the running
// devnet, local-stack.ts empties every local table before the stack starts.

/** Name of the one-row table in the local Postgres that records the devnet its rows belong to. */
export const DEVNET_MARKER_TABLE = "cascade_local_devnet";

/** Tables kept on reset: the migration ledger (schemas stay in place) and the marker itself. */
export const RESET_KEEP_TABLES: readonly string[] = ["schema_migrations", DEVNET_MARKER_TABLE];

/**
 * Identifies one devnet run: the genesis start time plus the hash of block 1. Block 1's hash
 * changes with the start time, and still separates two runs that report the same start time.
 */
export function devnetId(startTime: number, block1Hash: string): string {
  if (!Number.isSafeInteger(startTime) || startTime <= 0) throw new Error(`invalid devnet start time ${startTime}`);
  if (!/^[0-9a-f]{64}$/.test(block1Hash)) throw new Error(`invalid block 1 hash ${JSON.stringify(block1Hash)}`);
  return `${startTime}:${block1Hash}`;
}

/** The local databases are stale unless they record exactly the running devnet. */
export function localDbIsStale(recorded: string | undefined, current: string): boolean {
  return recorded !== current;
}

const MARKER_DDL = `CREATE TABLE IF NOT EXISTS ${DEVNET_MARKER_TABLE} (id integer PRIMARY KEY CHECK (id = 1), devnet text NOT NULL, reset_at timestamptz NOT NULL DEFAULT now());`;

/** SQL that empties every local table except RESET_KEEP_TABLES and records `current` as the devnet. */
export function resetSql(current: string): string {
  const keep = RESET_KEEP_TABLES.map((t) => `'${t}'`).join(", ");
  const id = current.replace(/'/g, "''");
  return [
    "BEGIN;",
    MARKER_DDL,
    "DO $$ DECLARE t text; BEGIN",
    "  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') INTO t FROM pg_tables",
    `  WHERE schemaname = 'public' AND tablename NOT IN (${keep});`,
    "  IF t IS NOT NULL THEN EXECUTE 'TRUNCATE ' || t || ' RESTART IDENTITY CASCADE'; END IF;",
    "END $$;",
    `INSERT INTO ${DEVNET_MARKER_TABLE} (id, devnet) VALUES (1, '${id}') ON CONFLICT (id) DO UPDATE SET devnet = EXCLUDED.devnet, reset_at = now();`,
    "COMMIT;",
  ].join("\n");
}

/** SQL that prints the recorded devnet id, or nothing when no devnet is recorded yet. */
export const READ_MARKER_SQL = `${MARKER_DDL}\nSELECT devnet FROM ${DEVNET_MARKER_TABLE} WHERE id = 1;`;
