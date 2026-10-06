import { BaseSequencer, type TestSpecification } from "vitest/node";
import { defineConfig } from "vitest/config";
import { ACCEPTANCE_CONCURRENCY, rankAcceptanceFile } from "./acceptance-order.js";

/** Console-driven in one lane; A4, A20, sdk-driven, A16 in the other (acceptance-order.ts). */
class AcceptanceOrderSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    return [...sorted].sort((a, b) => rankAcceptanceFile(a.moduleId) - rankAcceptanceFile(b.moduleId));
  }
}

const MINUTE = 60_000;

export default defineConfig({
  test: {
    // Suites share one preprod treasury and one Yaci devnet, so test files run one at a time.
    fileParallelism: false,
    sequence: { sequencer: AcceptanceOrderSequencer },
    // Operator laptop load rule (CLAUDE.md): at most two workers.
    maxWorkers: 2,
    projects: [
      {
        test: {
          name: "lib",
          include: ["lib/**/*.test.ts"],
          testTimeout: 2 * MINUTE,
        },
      },
      {
        test: {
          name: "acceptance",
          include: ["acceptance/**/*.test.ts"],
          // it.concurrent cases in flight per worker; each test has its own buyer wallet.
          maxConcurrency: ACCEPTANCE_CONCURRENCY,
          testTimeout: 60 * MINUTE,
          hookTimeout: 10 * MINUTE,
        },
      },
      {
        test: {
          name: "integration",
          include: ["integration/**/*.test.ts"],
          testTimeout: 30 * MINUTE,
          hookTimeout: 10 * MINUTE,
        },
      },
      {
        test: {
          name: "adversarial",
          include: ["adversarial/**/*.test.ts"],
          globalSetup: ["adversarial/global-setup.ts"],
          testTimeout: 30 * MINUTE,
          hookTimeout: 10 * MINUTE,
        },
      },
      {
        test: {
          name: "chaos",
          include: ["chaos/**/*.test.ts"],
          testTimeout: 60 * MINUTE,
        },
      },
      {
        test: {
          name: "load",
          include: ["load/**/*.test.ts"],
          testTimeout: 60 * MINUTE,
        },
      },
    ],
  },
});
