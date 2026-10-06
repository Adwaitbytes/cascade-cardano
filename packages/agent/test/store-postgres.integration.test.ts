/**
 * Runs against the local Postgres from infra/docker-compose.local.yml (or CASCADE_TEST_DATABASE_URL).
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresJobStore } from "../src/store-postgres.js";
import { DuplicateJobError, JobNotFoundError } from "../src/store.js";
import { makeAgent, paymentHeader, TREE_ID, NODE_ID } from "./helpers.js";
import type { PaymentRequired } from "../src/payment.js";

const url = process.env["CASCADE_TEST_DATABASE_URL"] ?? "postgres://cascade:cascade@127.0.0.1:55432/cascade";
const pool = new pg.Pool({ connectionString: url, max: 4 });
const prefix = `t_agent_${process.pid}`;

beforeAll(async () => {
  await pool.query("SELECT 1");
});

afterAll(async () => {
  await pool.query(`DROP TABLE IF EXISTS ${prefix}_jobs, ${prefix}_quotes, ${prefix}_race_jobs, ${prefix}_race_quotes`);
  await pool.end();
});

describe("PostgresJobStore", () => {
  it("migrates concurrently on a fresh database without a duplicate-key error", async () => {
    const racePool = new pg.Pool({ connectionString: url, max: 8 });
    try {
      const stores = Array.from({ length: 8 }, (_, i) => new PostgresJobStore({ pool: racePool, agentId: `race-${i}`, tablePrefix: `${prefix}_race` }));
      await Promise.all(stores.map((s) => s.migrate()));
      const { rows } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM pg_tables WHERE tablename = ANY($1)", [[`${prefix}_race_jobs`, `${prefix}_race_quotes`]]);
      expect(Number(rows[0]!.n)).toBe(2);
    } finally {
      await racePool.end();
    }
  });

  it("serves a paid job end to end and survives a restart", async () => {
    const store = new PostgresJobStore({ pool, agentId: "agent-a", tablePrefix: prefix });
    await store.migrate();
    const { agent } = makeAgent({ store });
    const body = { identifier_from_purchaser: "pg-buyer", input_data: { topic: "juice" } };
    const post = (headers: Record<string, string> = {}) =>
      agent.fetch(new Request("https://agent.test/jobs", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    const required = (await (await post()).json()) as PaymentRequired;
    const header = paymentHeader(required.accepts[0]!);
    const paid = await post({ "PAYMENT-SIGNATURE": header });
    expect(paid.status).toBe(200);
    const { job_id } = (await paid.json()) as { job_id: string };
    await agent.runner.whenDone(job_id);

    const reopened = new PostgresJobStore({ pool, agentId: "agent-a", tablePrefix: prefix });
    const job = await reopened.get(job_id);
    expect(job?.status).toBe("completed");
    expect(job?.result).toEqual({ summary: "About juice" });
    expect((await reopened.findByNode(TREE_ID, NODE_ID))?.job_id).toBe(job_id);
    expect((await reopened.findByPaymentKey(job!.payment.payment_key!))?.job_id).toBe(job_id);
    expect((await reopened.listByStatus(["completed"])).map((j) => j.job_id)).toContain(job_id);

    const again = await post({ "PAYMENT-SIGNATURE": header });
    expect(((await again.json()) as { job_id: string }).job_id).toBe(job_id);
    await expect(reopened.create(job!)).rejects.toBeInstanceOf(DuplicateJobError);
    await expect(reopened.update("missing", (j) => j)).rejects.toBeInstanceOf(JobNotFoundError);
    const other = new PostgresJobStore({ pool, agentId: "agent-b", tablePrefix: prefix });
    expect(await other.get(job_id)).toBeNull();
  });

  it("serialises concurrent updates to one job", async () => {
    const store = new PostgresJobStore({ pool, agentId: "agent-c", tablePrefix: prefix });
    await store.migrate();
    const { agent } = makeAgent({ store, handler: () => new Promise(() => undefined) });
    const res = await agent.fetch(
      new Request("https://agent.test/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier_from_purchaser: "c", input_data: { topic: "juice" } }) }),
    );
    const required = (await res.json()) as PaymentRequired;
    const paid = await agent.fetch(
      new Request("https://agent.test/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": paymentHeader(required.accepts[0]!, 3) },
        body: JSON.stringify({ identifier_from_purchaser: "c", input_data: { topic: "juice" } }),
      }),
    );
    const { job_id } = (await paid.json()) as { job_id: string };
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.update(job_id, (j) => ({ ...j, sources: [...j.sources, { url: `https://example.org/${i}` }] }))),
    );
    expect((await store.get(job_id))?.sources).toHaveLength(20);
    agent.close();
  });
});
