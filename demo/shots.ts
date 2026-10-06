/**
 * Screenshots of the live web app for the deck (demo/out/shots/*.png), at 1600 x 900, light
 * theme. Run after the UI ships: scripts/heavy.sh pnpm --filter @cascade/demo shots -- <tree id>
 * The tree defaults to the recorded demo tree in demo/out/cascade-demo.json. CASCADE_DEMO_WEB_URL
 * picks the web app, as for record.ts.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { z } from "zod";
import { repoPath, webOrigin } from "./src/preprod.js";

const origin = webOrigin();
const recorded = repoPath("demo", "out", "cascade-demo.json");
const treeId =
  process.argv.find((a) => /^[0-9a-f]{56}$/.test(a)) ??
  (existsSync(recorded) ? z.object({ treeId: z.string() }).parse(JSON.parse(readFileSync(recorded, "utf8"))).treeId : null);
if (treeId === null) throw new Error("pass a tree id, or record the demo first");

const shots: [string, string][] = [
  ["console-new", "/console/new"],
  ["explorer-stage", `/tree/${treeId}?stage=1`],
  ["receipt", `/receipt/${treeId}`],
];

const dir = repoPath("demo", "out", "shots");
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
  for (const [name, path] of shots) {
    await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${dir}/${name}.png` });
    console.log(`wrote demo/out/shots/${name}.png`);
  }
} finally {
  await browser.close();
}
