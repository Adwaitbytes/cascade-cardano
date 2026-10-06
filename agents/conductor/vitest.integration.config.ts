import { defineConfig } from "vitest/config";

/** Yaci DevKit, local Postgres and local Temporal from infra/docker-compose.local.yml must be up. */
export default defineConfig({
  test: {
    include: ["test/**/*.integration.test.ts"],
    testTimeout: 1_200_000,
    hookTimeout: 600_000,
  },
});
