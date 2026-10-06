// Applies the services/kit Postgres migrations to the preprod Neon database
// (DATABASE_URL_PREPROD). Idempotent: migrate() skips applied ids. Prints ids only.
import { createPool, migrate } from "@cascade/service-kit";
import { requireEnv } from "./lib/env.js";

async function main(): Promise<void> {
  const pool = createPool(requireEnv("DATABASE_URL_PREPROD"), 2);
  try {
    const applied = await migrate(pool);
    console.log(applied.length === 0 ? "Preprod database is up to date." : `Applied migrations ${applied.join(", ")}.`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // pg errors can echo the connection string; print only the message class and code.
  const e = error as { code?: unknown; name?: unknown };
  console.error(`migration failed: ${String(e.name ?? "Error")}${e.code === undefined ? "" : ` (${String(e.code)})`}`);
  process.exit(1);
});
