/**
 * Integration tests against the running local stack (`pnpm local:up`): Postgres on 55432 and Yaci's
 * Ogmios. No chain call is mocked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS, OgmiosClient, OgmiosError, loadNetworkConfig, migrate } from "../src/index.js";
import { createTestDatabase, type TestDatabase } from "../src/testing/db.js";

const cfg = loadNetworkConfig("local");

describe("postgres schema", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  it("creates every PRD 17.1 table and is idempotent", async () => {
    expect(await migrate(db.pool)).toEqual([]);
    const { rows } = await db.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ["trees", "nodes", "node_events", "agents", "quotes", "plans", "verdicts", "gate_logs", "x402_claims", "reputation", "artefacts"]) {
      expect(names).toContain(t);
    }
    const applied = await db.pool.query<{ id: number }>("SELECT id FROM schema_migrations ORDER BY id");
    expect(applied.rows.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it("enforces one tx per terms digest in x402_claims", async () => {
    const insert = (tx: string) =>
      db.pool.query("INSERT INTO x402_claims (terms_digest, tx_id, status, requirements, owner_token, network) VALUES ($1, $2, 'in-flight', '{}', 'o', 'cardano:local')", [
        "d".repeat(64),
        tx,
      ]);
    await insert("1".repeat(64));
    await expect(insert("2".repeat(64))).rejects.toThrow(/duplicate key/);
  });
});

describe("ogmios on Yaci", () => {
  const ogmios = new OgmiosClient(cfg.ogmiosHttp);

  it("reads tip, height and protocol parameters", async () => {
    const tip = await ogmios.tip();
    expect(tip.slot).toBeGreaterThan(0);
    expect(await ogmios.blockHeight()).toBeGreaterThan(0);
    const pp = await ogmios.protocolParameters();
    expect(pp.coinsPerUtxoByte).toBe(4310n);
    expect(pp.minFeeCoefficient).toBe(44n);
    expect(pp.maxExecutionUnitsPerTransaction.memory).toBeGreaterThan(0n);
  });

  it("returns a typed error for an undecodable transaction", async () => {
    await expect(ogmios.evaluate("00")).rejects.toBeInstanceOf(OgmiosError);
  });
});
