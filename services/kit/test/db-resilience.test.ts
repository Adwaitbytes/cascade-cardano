/**
 * The indexer died on 2026-10-07 when Neon reset a connection held inside a transaction: pg
 * emitted 'error' on a checked-out client nobody listened on. These resets are real, against a
 * throwaway database on the local Postgres.
 */
import type { Socket } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClient, withTransaction } from "../src/db.js";
import { createTestDatabase, type TestDatabase } from "../src/testing/db.js";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

const pidOf = async (c: pg.PoolClient): Promise<number> => (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;

describe("createPool", () => {
  it("survives the server terminating an idle connection", async () => {
    const pid = await withClient(db.pool, pidOf);
    const admin = new pg.Client({ connectionString: db.url });
    await admin.connect();
    try {
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    } finally {
      await admin.end();
    }
    await new Promise((r) => setTimeout(r, 200));
    const { rows } = await db.pool.query<{ ok: number }>("SELECT 1 AS ok");
    expect(rows[0]!.ok).toBe(1);
  });
});

describe("withTransaction", () => {
  it("survives a socket reset on the held client and destroys that client", async () => {
    let firstPid = 0;
    await expect(
      withTransaction(db.pool, async (client) => {
        firstPid = await pidOf(client);
        const pending = client.query("SELECT pg_sleep(5)");
        const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
        (client as unknown as { connection: { stream: Socket } }).connection.stream.destroy(err);
        await pending;
      }),
    ).rejects.toThrow();
    const pids = await Promise.all([withClient(db.pool, pidOf), withClient(db.pool, pidOf)]);
    expect(pids).not.toContain(firstPid);
  });
});
