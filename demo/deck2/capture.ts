// Captures the real pages the deck shows: the live Cascade app and the public sources it cites.
// Run from demo/: scripts/heavy.sh npx tsx deck2/capture.ts [name ...]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const site = "https://cascade-alpha-amber.vercel.app";
const tree = "4b50da32cf987ecdccbf0b421b5269161e3ac84651476ed30bb045bf";
const scan = "https://preprod.cexplorer.io/tx/";

interface Shot {
  name: string;
  url: string;
  width: number;
  height: number;
  waitMs: number;
}

const shots: Shot[] = [
  { name: "landing", url: `${site}/`, width: 1440, height: 900, waitMs: 6000 },
  { name: "console", url: `${site}/console`, width: 1440, height: 900, waitMs: 6000 },
  { name: "tree", url: `${site}/tree/${tree}`, width: 1440, height: 900, waitMs: 12000 },
  { name: "receipt", url: `${site}/receipt/${tree}`, width: 1440, height: 1100, waitMs: 6000 },
  { name: "economy", url: `${site}/economy`, width: 1440, height: 900, waitMs: 6000 },
  { name: "scan-escrow", url: `${scan}3585e64c0afb16d19c711ced384180170d2c256090c68cdc81aee076598a1623`, width: 1280, height: 900, waitMs: 12000 },
  { name: "scan-withdraw", url: `${scan}db84039e31a7706f4454380de0a26815df26fb4b856534839ba3000ddd8d5f77`, width: 1280, height: 900, waitMs: 12000 },
  { name: "scan-refund", url: `${scan}fb8280c71a523c5d423af87edc355f191feea126ba1e1722d514e66a279d6472`, width: 1280, height: 900, waitMs: 12000 },
  { name: "github", url: "https://github.com/Adwaitbytes/cascade-cardano", width: 1280, height: 900, waitMs: 4000 },
];

const out = join(import.meta.dirname, "shots");
mkdirSync(out, { recursive: true });
const wanted = new Set(process.argv.slice(2));

const browser = await chromium.launch();
try {
  for (const shot of shots) {
    if (wanted.size > 0 && !wanted.has(shot.name)) continue;
    const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: 2 });
    try {
      await page.goto(shot.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(shot.waitMs);
      await page.screenshot({ path: join(out, `${shot.name}.png`) });
      console.log(`captured ${shot.name}`);
    } catch (error) {
      console.error(`failed ${shot.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
