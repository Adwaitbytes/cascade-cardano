// Stills of the live product for the launch film, taken in real Google Chrome (fresh profile,
// 1920x1080 at 2x). Surfaces are found in the DOM, not by fixed coordinates.
// Usage (from demo/launch): node capture-parts.mjs <tree id>
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const origin = "https://cascade-alpha-amber.vercel.app";
const treeId = process.argv[2];
if (!/^[0-9a-f]{56}$/.test(treeId ?? "")) throw new Error("pass a 56-hex tree id");

const profile = mkdtempSync(join(tmpdir(), "cascade-launch-chrome-"));
mkdirSync("assets/shots", { recursive: true });
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
  colorScheme: "light",
});

// Boxes of the nearest ancestors of leaf elements reading `text` whose size falls in the range.
function boxesFor(page, text, minW, maxW, minH, maxH) {
  return page.evaluate(
    ({ text, minW, maxW, minH, maxH }) => {
      const out = [];
      for (const hit of document.querySelectorAll("body *")) {
        if (hit.childElementCount !== 0 || hit.textContent.trim() !== text) continue;
        for (let el = hit; el; el = el.parentElement) {
          const r = el.getBoundingClientRect();
          if (r.width >= minW && r.width <= maxW && r.height >= minH && r.height <= maxH) {
            out.push({ x: r.x, y: r.y, width: r.width, height: r.height });
            break;
          }
          if (r.width > maxW) break;
        }
      }
      return out;
    },
    { text, minW, maxW, minH, maxH },
  );
}

async function shoot(page, name, box) {
  if (!box) throw new Error(`could not find ${name}`);
  await page.screenshot({ path: `assets/shots/${name}.png`, clip: box });
  console.log(`wrote ${name} ${Math.round(box.width)}x${Math.round(box.height)}`);
}

try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  for (const [name, path] of [
    ["explorer", `/tree/${treeId}`],
    ["receipt", `/receipt/${treeId}`],
  ]) {
    await page.goto(`${origin}${path}`, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `assets/shots/${name}.png` });
    if (name === "explorer") {
      const nodes = { root: "Cascade Conductor", scout: "Cascade Scout", pricer: "Cascade Pricer", checker: "Cascade Checker A" };
      for (const [k, t] of Object.entries(nodes)) await shoot(page, `n-${k}`, (await boxesFor(page, t, 120, 340, 50, 160))[0]);
      const scribes = await boxesFor(page, "Cascade Scribe", 120, 340, 50, 160);
      await shoot(page, "n-scribe", scribes[0]);
      await shoot(page, "n-scribe2", scribes[1]);
      await shoot(page, "p-events", (await boxesFor(page, "Events", 300, 640, 300, 1100))[0]);
    }
    if (name === "receipt") {
      const card = (await boxesFor(page, "Reconciled", 900, 1500, 300, 4000))[0];
      if (card) card.height = Math.min(card.height, 1080 - card.y);
      await shoot(page, "p-receipt", card);
    }
  }
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
}
