/**
 * Records the raw shots for the submission film (docs/submission/video-script.md) from the live preprod site,
 * the Coworker Task page rendered from its journal, Cardanoscan and GitHub.
 *
 * Run: scripts/heavy.sh demo/node_modules/.bin/tsx demo/film/record.ts <out_dir> [shot ...]
 * Headed Chrome, because Cardanoscan serves a bot check to headless browsers. Each shot gets its own
 * context and video; <out_dir>/shots.json maps a shot to its video and the second its content was ready.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";

const OUT = resolve(process.argv[2] ?? "film-raw");
const ONLY = new Set(process.argv.slice(3));
const SITE = "https://cascade-alpha-amber.vercel.app";
const TREE = "4b50da32cf987ecdccbf0b421b5269161e3ac84651476ed30bb045bf";
const TX = {
  masumiLock: "3585e64c0afb16d19c711ced384180170d2c256090c68cdc81aee076598a1623",
  resultHash: "559a1604a46ac62fa05c7351f46a5ce96da18c4d83cd206d68b486053e0e3360",
  withdrawn: "db84039e31a7706f4454380de0a26815df26fb4b856534839ba3000ddd8d5f77",
  fundRoot: "f22e344be8d2002d9d7995f8103f61239f3e1a2c232519f4d72429376d282512",
};
const TASK_PAGE = pathToFileURL(join(import.meta.dirname, "pages/task.html")).href;
const GOAL = "Market-entry brief for a specialty coffee subscription brand in Singapore, with a competitor price table and a Simplified Chinese summary.";
const SIZE = { width: 1920, height: 1080 };
const CS_STATE = join(OUT, "cardanoscan-state.json");

/** A visible cursor that follows real mouse events, since screen recordings carry no pointer. */
const CURSOR = `
globalThis.__name = globalThis.__name || ((fn) => fn);
addEventListener("DOMContentLoaded", () => {
  const c = document.createElement("div");
  c.id = "cx-cursor";
  c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 9.5-6.6 1.4 3.9 7.4-3 1.6-3.9-7.5L4 19z" fill="#0d1826" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none", transform: "translate(-200px,-200px)", filter: "drop-shadow(0 2px 4px rgba(0,0,0,.25))" });
  document.body.appendChild(c);
  addEventListener("mousemove", (e) => { c.style.transform = "translate(" + (e.clientX - 3) + "px," + (e.clientY - 2) + "px)"; }, true);
  const label = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || p.closest(".cx-test,script,style,svg")) continue;
      if (/^(Flaky Lisan|Lisan-B)/.test((n.textContent || "").trim()) && !(p.nextElementSibling && p.nextElementSibling.classList.contains("cx-test"))) hits.push(n);
    }
    for (const n of hits) {
      const b = document.createElement("span");
      b.className = "cx-test";
      b.textContent = "test agent, fails on purpose";
      Object.assign(b.style, { display: "inline-block", margin: "2px 0 0 6px", padding: "1px 7px", borderRadius: "6px", background: "#fef3c7", color: "#92400e", font: "600 11px/1.5 Inter, system-ui, sans-serif", whiteSpace: "nowrap" });
      n.parentElement.insertAdjacentElement("afterend", b);
    }
  };
  label();
  new MutationObserver(label).observe(document.body, { childList: true, subtree: true });
});`;

interface ShotRecord {
  video: string;
  ready: number;
  marks: Record<string, number>;
}
type Ctx = { page: Page; mark: (name: string) => void };

let mouse = { x: 960, y: 540 };
async function glide(page: Page, x: number, y: number, ms = 900): Promise<void> {
  const steps = Math.max(12, Math.round(ms / 16));
  const from = { ...mouse };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await page.waitForTimeout(ms / steps);
  }
  mouse = { x, y };
}
async function glideTo(page: Page, selector: ReturnType<Page["locator"]>, ms = 900): Promise<void> {
  const box = await selector.first().boundingBox();
  if (box !== null) await glide(page, box.x + box.width / 2, box.y + box.height / 2, ms);
}
/** Eased scroll by `dy` pixels over `ms`, run in the page so frames stay smooth. */
async function scroll(page: Page, dy: number, ms: number): Promise<void> {
  await page.evaluate(
    ([d, t]) =>
      new Promise<void>((done) => {
        const start = window.scrollY;
        const t0 = performance.now();
        const step = (now: number): void => {
          const p = Math.min(1, (now - t0) / t);
          const e = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
          window.scrollTo(0, start + d * e);
          if (p < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      }),
    [dy, ms] as const,
  );
}
async function cookieAccept(page: Page): Promise<void> {
  const btn = page.getByRole("button", { name: "Accept", exact: true });
  if (await btn.isVisible().catch(() => false)) await btn.click();
}
async function cardanoscan(page: Page, tx: string): Promise<void> {
  await page.goto(`https://preprod.cardanoscan.io/transaction/${tx}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.title.startsWith("Just a moment"), null, { timeout: 90_000 });
  await page.waitForTimeout(3500);
  await cookieAccept(page);
  // Later Cardanoscan shots reuse this clearance instead of facing the bot check again.
  await page.context().storageState({ path: CS_STATE });
  // A fixed strip pinned to the bottom of the viewport (ad slot) is not part of the transaction view.
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const cs = getComputedStyle(el);
      if ((cs.position === "fixed" || cs.position === "sticky") && el.getBoundingClientRect().top > window.innerHeight * 0.75) el.style.display = "none";
    }
  });
  await page.waitForTimeout(500);
}

const shots: Record<string, (c: Ctx) => Promise<void>> = {
  landing: async ({ page, mark }) => {
    await page.goto(SITE, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    mark("ready");
    await glide(page, 980, 300, 1500);
    await page.waitForTimeout(1500);
    await glideTo(page, page.getByRole("link", { name: "Watch the demo tree" }), 1400);
    await page.waitForTimeout(1500);
    await glide(page, 1360, 620, 1500);
    await page.waitForTimeout(1200);
    await glide(page, 1550, 900, 1400);
    await page.waitForTimeout(2500);
    mark("scroll");
    for (let i = 0; i < 5; i++) {
      await scroll(page, 900, 3200);
      await page.waitForTimeout(1600);
    }
    await page.waitForTimeout(1000);
  },
  economy: async ({ page, mark }) => {
    await page.goto(`${SITE}/economy`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    mark("ready");
    await glide(page, 1080, 380, 1500);
    await page.waitForTimeout(1500);
    await glide(page, 1420, 690, 1400);
    await page.waitForTimeout(1500);
    await scroll(page, 760, 3500);
    await glide(page, 1370, 560, 1500);
    await page.waitForTimeout(3000);
  },
  task: async ({ page, mark }) => {
    await page.goto(TASK_PAGE, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    mark("ready");
    await glide(page, 300, 520, 1500);
    await page.waitForTimeout(1200);
    await glide(page, 330, 700, 1800);
    await page.waitForTimeout(2500);
    mark("result");
    await glide(page, 1200, 500, 1200);
    for (let i = 0; i < 4; i++) {
      await scroll(page, 700, 2600);
      await page.waitForTimeout(1400);
    }
    await page.waitForTimeout(1500);
  },
  masumiLock: async ({ page, mark }) => {
    await cardanoscan(page, TX.masumiLock);
    mark("ready");
    await glide(page, 620, 225, 1300);
    await page.waitForTimeout(1000);
    await glide(page, 1200, 560, 1600);
    await page.waitForTimeout(1200);
    await glide(page, 1520, 612, 1200);
    await page.waitForTimeout(3000);
  },
  tree: async ({ page, mark }) => {
    await page.goto(`${SITE}/tree/${TREE}?stage=1`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    mark("ready");
    // Stage view replays the indexed events from funding to close on its own.
    await glide(page, 760, 560, 2500);
    await page.getByText(/Event 23 of 23/).waitFor({ timeout: 120_000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
    mark("hover");
    const pricer = page.getByText("Cascade Pricer").first();
    await glideTo(page, pricer, 1500);
    await page.waitForTimeout(1200);
    await pricer.click().catch(() => undefined);
    await page.waitForTimeout(6000);
  },
  console: async ({ page, mark }) => {
    await page.goto(`${SITE}/console/new`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    mark("ready");
    const goal = page.getByLabel("Goal");
    await glideTo(page, goal, 1100);
    await goal.click();
    await goal.fill("");
    await goal.pressSequentially(GOAL, { delay: 22 });
    await page.waitForTimeout(600);
    await page.getByLabel("Budget").fill("60");
    await page.locator("#job-asset").selectOption("lovelace").catch(() => undefined);
    const get = page.getByRole("button", { name: "Get a plan" });
    await glideTo(page, get, 1200);
    await get.click();
    mark("planning");
    await page.getByTestId("plan-rows").waitFor({ timeout: 240_000 });
    await page.waitForTimeout(1200);
    mark("plan");
    await glide(page, 900, 600, 1200);
    await scroll(page, 500, 2500);
    await page.waitForTimeout(1500);
    const fund = page.getByRole("button", { name: "Fund this plan" });
    await fund.scrollIntoViewIfNeeded();
    await glideTo(page, fund, 1200);
    await page.waitForTimeout(400);
    await fund.click();
    mark("wallet");
    await page.waitForTimeout(1500);
    const connect = page.getByRole("button", { name: "Connect a preprod wallet" });
    await connect.scrollIntoViewIfNeeded().catch(() => undefined);
    await glideTo(page, connect, 1200);
    await page.waitForTimeout(3000);
  },
  receipt: async ({ page, mark }) => {
    await page.goto(`${SITE}/receipt/${TREE}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    mark("ready");
    await glide(page, 900, 420, 1400);
    await page.waitForTimeout(1000);
    await scroll(page, 600, 3000);
    await page.waitForTimeout(1200);
    await scroll(page, 700, 3000);
    await page.waitForTimeout(1500);
  },
  resultHash: async ({ page, mark }) => {
    await cardanoscan(page, TX.resultHash);
    mark("ready");
    await glide(page, 620, 225, 1300);
    await page.waitForTimeout(1400);
    await glide(page, 1200, 580, 1400);
    await page.waitForTimeout(2500);
  },
  withdrawn: async ({ page, mark }) => {
    await cardanoscan(page, TX.withdrawn);
    mark("ready");
    await glide(page, 620, 225, 1300);
    await page.waitForTimeout(1400);
    await glide(page, 1400, 580, 1400);
    await page.waitForTimeout(2500);
  },
  fundRoot: async ({ page, mark }) => {
    await cardanoscan(page, TX.fundRoot);
    mark("ready");
    await glide(page, 1200, 560, 1500);
    await page.waitForTimeout(2000);
    const utxos = page.getByText("UTXOs", { exact: false }).first();
    await glideTo(page, utxos, 1200);
    await utxos.click().catch(() => undefined);
    await page.waitForTimeout(1500);
    mark("utxos");
    await scroll(page, 560, 3000);
    await glide(page, 1300, 560, 1500);
    await page.waitForTimeout(1500);
    const mints = page.getByText("Mints & Burns", { exact: false }).first();
    await glideTo(page, mints, 1200);
    await mints.click().catch(() => undefined);
    mark("mints");
    await page.waitForTimeout(1200);
    await glide(page, 900, 420, 1500);
    await page.waitForTimeout(5000);
  },
  waterfall: async ({ page, mark }) => {
    await page.goto(`${SITE}/tree/${TREE}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    const wf = page.getByRole("button", { name: "Waterfall" }).or(page.getByRole("tab", { name: "Waterfall" }));
    await glideTo(page, wf, 1000);
    await wf.first().click().catch(() => undefined);
    await page.waitForTimeout(1500);
    mark("ready");
    await glide(page, 760, 600, 2000);
    await page.waitForTimeout(6000);
  },
  github: async ({ page, mark }) => {
    await page.goto("https://github.com/Adwaitbytes/cascade-cardano", { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(5000);
    mark("ready");
    await glide(page, 760, 500, 1500);
    await page.waitForTimeout(1000);
    await scroll(page, 900, 3500);
    await page.waitForTimeout(1200);
    await scroll(page, 800, 3500);
    await page.waitForTimeout(2000);
  },
};

async function record(browser: Browser, name: string, run: (c: Ctx) => Promise<void>): Promise<ShotRecord> {
  const ctx = await browser.newContext({ viewport: SIZE, deviceScaleFactor: Number(process.env.FILM_DSF ?? "1"), recordVideo: { dir: OUT, size: SIZE }, colorScheme: "light", ...(process.env.FILM_UA ? { userAgent: process.env.FILM_UA } : {}), ...(existsSync(CS_STATE) ? { storageState: CS_STATE } : {}) });
  await ctx.addInitScript({ content: CURSOR });
  const page = await ctx.newPage();
  const t0 = Date.now();
  const marks: Record<string, number> = {};
  mouse = { x: 960, y: 540 };
  try {
    await run({ page, mark: (m) => (marks[m] = (Date.now() - t0) / 1000) });
  } finally {
    await ctx.close();
  }
  const raw = await page.video()?.path();
  if (raw === undefined) throw new Error(`${name}: no video`);
  const video = join(OUT, `${name}.webm`);
  renameSync(raw, video);
  return { video, ready: marks.ready ?? 0, marks };
}

const manifestPath = join(OUT, "shots.json");
const manifest: Record<string, ShotRecord> = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
const browser = await chromium.launch({ channel: "chrome", headless: process.env.FILM_HEADLESS === "1", args: ["--disable-blink-features=AutomationControlled", "--window-size=1920,1080", "--hide-scrollbars"] });
try {
  for (const [name, run] of Object.entries(shots)) {
    if (ONLY.size > 0 && !ONLY.has(name)) continue;
    console.log(`recording ${name}`);
    try {
      manifest[name] = await record(browser, name, run);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
      console.log(`  done ${JSON.stringify(manifest[name].marks)}`);
    } catch (err) {
      console.error(`  ${name} failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }
} finally {
  await browser.close();
}
