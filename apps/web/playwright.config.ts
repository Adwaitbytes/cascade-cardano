import { defineConfig, devices } from "@playwright/test";

// Own port, never reused: another agent's server on a shared port may not be in sample-data mode.
const PORT = Number(process.env.WEB_E2E_PORT ?? 3157);

/**
 * Smoke tests for every route at desktop and phone width. They run against `next dev` with the
 * labelled sample data, because production builds cannot load it by design.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    { name: "phone", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: `next dev --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { NEXT_PUBLIC_CASCADE_FIXTURES: "1", NEXT_DIST_DIR: ".next/web-e2e" },
  },
});
