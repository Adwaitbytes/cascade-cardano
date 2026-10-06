import { defineConfig } from "vitest/config";

/** Needs the local Postgres from infra/docker-compose.local.yml (or CASCADE_TEST_DATABASE_URL). */
export default defineConfig({ test: { include: ["test/**/*.integration.test.ts"], testTimeout: 120_000 } });
