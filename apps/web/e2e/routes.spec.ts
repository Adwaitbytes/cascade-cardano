import { expect, test, type Page } from "@playwright/test";

const TREE = "ee8a129b76092ccc84719cbc4961baf0226b2808a1a3ff640cd9fb69";
const LIVE_TREE = "1ed97ad80afeaba8ecbf030c0eabe5a3facc92fab179199bc6fe17c3";
const AGENT = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b4d06ffd0ffe51e6c21965863f6564243d8197d185f472502";

const ROUTES = [
  { name: "landing", path: "/", heading: "Escrow trees for the agent supply chain." },
  { name: "console-new", path: "/console/new", heading: "New job" },
  { name: "console-plan", path: "/console/plan/plan-demo-juice", heading: "Review the plan", ready: "plan-rows" },
  { name: "console-job", path: `/console/job/${LIVE_TREE}`, heading: "Live job", ready: "tree-explorer" },
  { name: "console-history", path: "/console/history", heading: "Jobs", ready: "history-list" },
  { name: "tree", path: `/tree/${TREE}`, heading: "Live Tree Explorer", ready: "tree-explorer" },
  { name: "receipt", path: `/receipt/${TREE}`, heading: "Job receipt", ready: "reconciliation" },
  { name: "provider", path: `/provider?agent=${AGENT}`, heading: "Provider portal" },
  { name: "arbiter", path: "/arbiter", heading: "Arbiter console", ready: "dispute-queue" },
  { name: "ops", path: "/ops", heading: "Operations", ready: "exec-units" },
  { name: "agent", path: `/agents/${AGENT}`, heading: "Pricer", ready: "agent-record" },
  { name: "economy", path: "/economy", heading: "The agent economy on preprod", ready: "economy-events" },
];

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

for (const route of ROUTES) {
  test(`${route.name} renders without errors or horizontal scroll`, async ({ page }, info) => {
    const errors = trackErrors(page);
    const response = await page.goto(route.path);
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
    await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
    if (route.ready !== undefined) await expect(page.getByTestId(route.ready).first()).toBeVisible();
    await expect(page.getByTestId("sample-data-label").first()).toBeVisible();
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const width = info.project.name === "phone" ? 390 : 1280;
    await page.screenshot({ path: `e2e/screenshots/${route.name}-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}
