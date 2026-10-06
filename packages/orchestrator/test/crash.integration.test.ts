/**
 * A15: a Conductor killed between signing a Draw and sending its payment, then restarted, sends the
 * same payment and never draws a second child (CASCADE_TEST_CRASH_AFTER_SIGN, test-scenarios.ts).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CRASH_EXIT_CODE } from "../src/test-scenarios.js";
import { migrateOrchestratorState } from "../src/state/postgres.js";

const url = process.env["CASCADE_TEST_DATABASE_URL"] ?? "postgres://cascade:cascade@127.0.0.1:55432/cascade";
const prefix = `t_crash_${process.pid}`;
const pool = new pg.Pool({ connectionString: url, max: 2 });
const script = fileURLToPath(new URL("./fixtures/crash-hire.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "cascade-a15-"));
const draws = join(dir, "draws.log");
const jobs = join(dir, "settled.log");

beforeAll(async () => {
  await migrateOrchestratorState(pool, prefix);
});
afterAll(async () => {
  await pool.query(`DROP TABLE IF EXISTS ${prefix}_plans, ${prefix}_hires`);
  await pool.end();
});

const run = (crash: string | null) =>
  spawnSync(process.execPath, ["--import", "tsx", script, url, prefix, draws, jobs], {
    env: { ...process.env, ...(crash === null ? {} : { CASCADE_TEST_CRASH_AFTER_SIGN: crash }) },
    encoding: "utf8",
    timeout: 60_000,
  });

describe("A15 crash between signing and submission", () => {
  it("restarts without a duplicate Draw or a lost node", () => {
    const first = run("payment-recorded");
    expect(first.status).toBe(CRASH_EXIT_CODE);
    expect(first.stderr).toContain("TEST SCENARIO: CASCADE_TEST_CRASH_AFTER_SIGN=payment-recorded");
    expect(readFileSync(draws, "utf8").trim().split("\n")).toHaveLength(1);

    const second = run(null);
    expect(second.status, second.stderr).toBe(0);
    const out = JSON.parse(second.stdout.trim().split("\n").pop() ?? "{}") as { node_id: string; draws: number };
    expect(out).toEqual({ node_id: "22".repeat(28), draws: 1 });
    // The resent payment is the one recorded before the crash: settled exactly once.
    expect(readFileSync(jobs, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
