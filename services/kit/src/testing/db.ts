/**
 * Creates a throwaway database on the local Postgres (deployments/local.json) for one test file,
 * and drops it afterwards. Tests never touch the `cascade` database the running services use.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { loadNetworkConfig } from "../config.js";
import { createPool, migrate, type Pool } from "../db.js";

export interface TestDatabase {
  url: string;
  pool: Pool;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = loadNetworkConfig("local").databaseUrl;
  const name = `cascade_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  const pool = createPool(url, 5);
  await migrate(pool);
  return {
    url,
    pool,
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
