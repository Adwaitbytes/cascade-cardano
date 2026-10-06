import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    // Local-chain tests share one devnet wallet and must run in order.
    fileParallelism: false,
  },
});
