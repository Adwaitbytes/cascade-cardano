// Renders each slide of deck.html to a 3840x2160 PNG (1920x1080 at 2x).
// Run from demo/: scripts/heavy.sh npx tsx deck2/render.ts [slide numbers ...]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = import.meta.dirname;
const out = join(dir, "png");
mkdirSync(out, { recursive: true });
const wanted = new Set(process.argv.slice(2).map(Number));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  page.on("pageerror", (error) => console.error(`page error: ${error.message}`));
  await page.goto(pathToFileURL(join(dir, "deck.html")).href, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const slides = await page.$$("section.slide");
  for (const [i, slide] of slides.entries()) {
    const n = i + 1;
    if (wanted.size > 0 && !wanted.has(n)) continue;
    await slide.screenshot({ path: join(out, `slide-${String(n).padStart(2, "0")}.png`) });
  }
  console.log(`rendered ${wanted.size || slides.length} slides`);
} finally {
  await browser.close();
}
