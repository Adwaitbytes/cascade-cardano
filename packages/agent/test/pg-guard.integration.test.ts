/**
 * A transient database drop must not kill an agent process. Runs against the local Postgres from
 * infra/docker-compose.local.yml (or CASCADE_TEST_DATABASE_URL); the connection resets are real:
 * the server terminates the backend, or the client socket is destroyed with ECONNRESET.
 */
import type { Socket } from "node:net";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { guardPool, withPgClient, withPgTransaction, type PgErrorSink } from "../src/pg-guard.js";

const url = process.env["CASCADE_TEST_DATABASE_URL"] ?? "postgres://cascade:cascade@127.0.0.1:55432/cascade";
const admin = new pg.Pool({ connectionString: url, max: 1 });

afterAll(async () => {
  await admin.end();
});

function recorder(): { sink: PgErrorSink; seen: { source: string; code: string | undefined }[] } {
  const seen: { source: string; code: string | undefined }[] = [];
  return { seen, sink: (err, source) => seen.push({ source, code: (err as { code?: string }).code }) };
}

const pidOf = async (client: pg.PoolClient): Promise<number> => (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
};

describe("guardPool", () => {
  it("an unguarded client with no listener turns a socket error into a thrown exception", () => {
    const raw = new pg.Client({ connectionString: url });
    expect(() => raw.emit("error", new Error("read ECONNRESET"))).toThrow("read ECONNRESET");
  });

  it("survives the server terminating an idle connection and keeps serving queries", async () => {
    const { sink, seen } = recorder();
    const pool = guardPool(new pg.Pool({ connectionString: url, max: 2 }), sink);
    try {
      const client = await pool.connect();
      const pid = await pidOf(client);
      client.release();
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      await until(() => seen.length > 0);
      expect(seen[0]?.source).toBe("pool");
      const { rows } = await pool.query<{ ok: number }>("SELECT 1 AS ok");
      expect(rows[0]!.ok).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("is idempotent", () => {
    const pool = new pg.Pool({ connectionString: url });
    guardPool(guardPool(pool));
    expect(pool.listenerCount("error")).toBe(1);
    void pool.end();
  });
});

describe("withPgClient", () => {
  it("survives a socket reset on a checked-out client, destroys that client and keeps serving", async () => {
    const { sink, seen } = recorder();
    const pool = guardPool(new pg.Pool({ connectionString: url, max: 1 }), sink);
    let firstPid = 0;
    try {
      await expect(
        withPgClient(
          pool,
          async (client) => {
            firstPid = await pidOf(client);
            const pending = client.query("SELECT pg_sleep(5)");
            const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
            (client as unknown as { connection: { stream: Socket } }).connection.stream.destroy(err);
            await pending;
          },
          sink,
        ),
      ).rejects.toThrow();
      expect(seen.some((s) => s.source === "client" && s.code === "ECONNRESET")).toBe(true);
      const next = await withPgClient(pool, pidOf, sink);
      expect(next).not.toBe(firstPid);
    } finally {
      await pool.end();
    }
  });

  it("removes its listener when the client goes back to the pool", async () => {
    const pool = guardPool(new pg.Pool({ connectionString: url, max: 1 }));
    try {
      let held: pg.PoolClient | undefined;
      await withPgClient(pool, async (client) => {
        held = client;
        expect(client.listenerCount("error")).toBe(1);
      });
      // Only pg-pool's own idle listener remains.
      expect(held?.listenerCount("error")).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("withPgTransaction commits, and rolls back on failure", async () => {
    const pool = guardPool(new pg.Pool({ connectionString: url, max: 1 }));
    const table = `t_pg_guard_${process.pid}`;
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (n int)`);
      await withPgTransaction(pool, (c) => c.query(`INSERT INTO ${table} VALUES (1)`));
      await expect(
        withPgTransaction(pool, async (c) => {
          await c.query(`INSERT INTO ${table} VALUES (2)`);
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      const { rows } = await pool.query<{ n: number }>(`SELECT n FROM ${table}`);
      expect(rows.map((r) => r.n)).toEqual([1]);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
      await pool.end();
    }
  });
});
