// Renders each social HTML at high device scale with one headless browser, then render.py downscales.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
// demo/social has no package of its own; borrow the pinned Playwright from the tests workspace.
const { chromium } = createRequire(path.join(dir, "../../tests/package.json"))("@playwright/test");
const jobs = [
  { page: "avatar.html", w: 400, h: 400, scale: 5, out: "out/avatar@5x.png" },
  { page: "banner.html", w: 1500, h: 500, scale: 2, out: "out/banner@2x.png" },
  { page: "post-card.html", w: 1200, h: 675, scale: 2, out: "out/post-card@2x.png" },
];

const browser = await chromium.launch();
try {
  for (const job of jobs) {
    const context = await browser.newContext({ viewport: { width: job.w, height: job.h }, deviceScaleFactor: job.scale });
    const page = await context.newPage();
    await page.goto(`file://${path.join(dir, job.page)}`);
    await page.evaluate(() => document.fonts.ready);
    await page.locator("#frame").screenshot({ path: path.join(dir, job.out) });
    await context.close();
  }
} finally {
  await browser.close();
}
