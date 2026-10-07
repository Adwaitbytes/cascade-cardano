/**
 * Renders the film's captions, lower-thirds and title cards to PNG with real type (Inter), so the
 * ffmpeg edit only composites. Run: tsx demo/film/overlays.ts <out_dir>
 * Reads demo/film/lines.json (captions) and the LOWER and CARDS tables below.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const OUT = resolve(process.argv[2] ?? "film-overlays");
const lines = JSON.parse(readFileSync(join(import.meta.dirname, "lines.json"), "utf8")) as Array<{ id: string; cap: string }>;

export const LOWER: Record<string, [string, string]> = {
  live: ["Cascade on Cardano preprod", "cascade-alpha-amber.vercel.app"],
  network: ["Network page", "Every figure read from indexed chain events"],
  task: ["Sokosumi Task 01a114cd", "Paid with 1 test USDM, rendered from the Coworker journal"],
  lock: ["Masumi escrow", "Buyer's payment locked at the Masumi contract"],
  tree: ["Cascade tree 4b50da32", "Explorer replay of indexed preprod events, sped up"],
  console: ["Buyer console", "Plan review, then one wallet signature"],
  receipt: ["Receipt", "Every deposit, payout and refund, reconciled"],
  result: ["Result hash on chain", "Masumi SubmitResult for Task 01a114cd"],
  payout: ["Seller payout", "Masumi escrow Withdrawn to Cascade"],
  fund: ["Cascade contract tx", "FundRoot: root escrow, plan root, thread tokens"],
  tokens: ["Native tokens", "Thread tokens minted for the root and its config"],
  waterfall: ["Deadlines nest", "Every child ends before its parent"],
  repo: ["Open source", "github.com/Adwaitbytes/cascade-cardano"],
};

const BASE = `
@font-face{font-family:I;src:local("Inter Variable"),local("Inter")}
*{box-sizing:border-box;margin:0}
html,body{width:1920px;height:1080px;background:transparent;font-family:"Inter Variable",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.cap{position:absolute;left:50%;bottom:64px;transform:translateX(-50%);max-width:1380px;width:max-content;padding:16px 28px 17px;border-radius:16px;
  background:rgba(10,18,30,.84);color:#f8fafc;font-size:33px;line-height:1.36;font-weight:520;letter-spacing:-.01em;text-align:center;
  box-shadow:0 10px 40px rgba(0,0,0,.28)}
.lt{position:absolute;left:56px;top:96px;display:flex;gap:16px;align-items:stretch;padding:16px 26px 16px 18px;border-radius:16px;
  background:rgba(10,18,30,.9);color:#fff;box-shadow:0 10px 40px rgba(0,0,0,.25)}
.lt i{width:5px;border-radius:3px;background:linear-gradient(#34d399,#22d3ee)}
.lt b{display:block;font-size:30px;font-weight:650;letter-spacing:-.02em;line-height:1.15}
.lt span{display:block;margin-top:5px;font-size:20px;color:#a5b4c3;font-weight:450}
.card{position:absolute;inset:0;display:grid;place-items:center;text-align:center;color:#f8fafc;
  background:radial-gradient(1200px 700px at 30% 20%,#123a3a 0%,transparent 60%),radial-gradient(900px 600px at 80% 90%,#14284a 0%,transparent 60%),#0a121e}
.card h1{font-size:132px;font-weight:700;letter-spacing:-.05em;line-height:1}
.card p{margin-top:26px;font-size:40px;color:#c9d4df;font-weight:450;letter-spacing:-.015em}
.card small{display:block;margin-top:44px;font:500 22px/1.6 ui-monospace,Menlo,monospace;color:#7dd3c0;letter-spacing:.06em}
`;

const CARDS: Record<string, string> = {
  title: `<div class="card"><div><h1>Cascade</h1><p>Escrow at every hop, for agents that hire agents.</p><small>CARDANO · MASUMI · X402 · LIVE ON PREPROD</small></div></div>`,
  end: `<div class="card"><div><h1>Cascade</h1><p>cascade-alpha-amber.vercel.app</p><small>GITHUB.COM/ADWAITBYTES/CASCADE-CARDANO<br>COWORKER ON SOKOSUMI PREPROD · APACHE-2.0</small></div></div>`,
};

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const shoot = async (name: string, body: string, transparent: boolean): Promise<void> => {
    await page.setContent(`<!doctype html><html><head><style>${BASE}</style></head><body>${body}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(OUT, `${name}.png`), omitBackground: transparent });
  };
  for (const l of lines) await shoot(`cap-${l.id}`, `<div class="cap">${esc(l.cap)}</div>`, true);
  for (const [k, [t, s]] of Object.entries(LOWER)) await shoot(`lt-${k}`, `<div class="lt"><i></i><div><b>${esc(t)}</b><span>${esc(s)}</span></div></div>`, true);
  for (const [k, html] of Object.entries(CARDS)) await shoot(`card-${k}`, html, false);
  await shoot("badge-speed", `<div class="lt" style="left:auto;right:56px;top:96px;padding:10px 18px"><div><b style="font-size:22px">Sped up 2x</b><span style="font-size:16px">typing the goal</span></div></div>`, true);
} finally {
  await browser.close();
}
