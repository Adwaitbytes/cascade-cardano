import { defineConfig, devices } from "@playwright/test";

/**
 * Two targets, no dev server started here (the operator's laptop runs one stack at a time):
 * - "local": write flows against `pnpm local:up` (web on 3100, indexer, Yaci).
 * - "public": read-only flows against the deployed web app (deployments/preprod.json urls.origin).
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../../evidence/e2e/test-output",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure", ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
  projects: [
    { name: "local", testMatch: /local\..*\.spec\.ts$/, use: { baseURL: process.env.E2E_LOCAL_URL ?? "http://127.0.0.1:3100" } },
    { name: "public", testMatch: /public\..*\.spec\.ts$/ },
  ],
});
