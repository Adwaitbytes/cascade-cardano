import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Laptop budget: at most two workers (scripts/heavy.sh runs one suite at a time).
    maxWorkers: 2,
    minWorkers: 1,
    include: ["test/**/*.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
