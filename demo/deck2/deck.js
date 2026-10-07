// Draws every chart and annotation in deck.html from the numbers in demo/deck2/data (copied here, sources on each slide).
const NS = "http://www.w3.org/2000/svg";
const C = { ink: "#161514", ink2: "#4A4642", muted: "#7A746E", line: "#D8D0C8", green: "#1F7A50", greenDot: "#3FAE73", greenSoft: "#CFE3D7", orange: "#F2994A", burnt: "#B9511D", orangeSoft: "#F7DCC4", card: "#E9E3DD" };

function el(parent, tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}
function txt(svg, x, y, s, size = 20, opts = {}) {
  return el(svg, "text", { x, y, "font-size": size, fill: opts.fill ?? C.ink, "font-weight": opts.weight ?? 450, "text-anchor": opts.anchor ?? "start", "font-style": opts.italic ? "italic" : "normal", "letter-spacing": opts.ls ?? "0" }, s);
}

// Seeded jitter so every render draws the same hand-made strokes.
let seed = 7;
function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

// A hand-drawn ellipse: one loop that overshoots its start, like a pen circle.
function roughEllipsePath(cx, cy, rx, ry) {
  const pts = [];
  const start = -0.4 + rnd() * 0.3;
  const turns = 1.12;
  for (let i = 0; i <= 40; i++) {
    const t = start + (i / 40) * Math.PI * 2 * turns;
    const wob = 1 + (rnd() - 0.5) * 0.05 + (i / 40) * 0.06;
    pts.push([cx + Math.cos(t) * rx * wob, cy + Math.sin(t) * ry * wob]);
  }
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  return d;
}
function overlay(slide) {
  let svg = slide.querySelector("svg.rough");
  if (!svg) { svg = el(slide, "svg", { class: "rough", width: 1920, height: 1080, style: "left:0;top:0" }); }
  return svg;
}
function circle(slide, x, y, w, h, color = C.orange) {
  el(overlay(slide), "path", { d: roughEllipsePath(x + w / 2, y + h / 2, w / 2, h / 2), fill: "none", stroke: color, "stroke-width": 3.2, "stroke-linecap": "round" });
}
function arrow(slide, d, color = "green") {
  const marker = color === "green" ? "ah" : color === "orange" ? "aho" : "ahi";
  const stroke = color === "green" ? C.green : color === "orange" ? C.burnt : C.muted;
  el(overlay(slide), "path", { d, fill: "none", stroke, "stroke-width": 2.6, "stroke-linecap": "round", "marker-end": `url(#${marker})` });
}
function note(slide, x, y, html, width = 360, size = 26) {
  const div = document.createElement("div");
  div.className = "abs note";
  div.style.cssText = `left:${x}px;top:${y}px;width:${width}px;font-size:${size}px`;
  div.innerHTML = html;
  slide.appendChild(div);
}
const S = (n) => document.querySelector(`section[data-n="${n}"]`);

// Header and page number on every slide but the title.
document.querySelectorAll("section.slide").forEach((s) => {
  const n = Number(s.dataset.n);
  if (n !== 1) {
    s.insertAdjacentHTML("afterbegin", `<div class="brand"><svg viewBox="0 0 28 28"><use href="#logo"/></svg>Cascade</div>`);
    s.insertAdjacentHTML("beforeend", `<div class="pno">${n}</div>`);
  }
});

// 2 Problem: one dot per hire in the 4 published trees (live /api/v1/landing, 7 Oct 2026).
{
  const svg = document.getElementById("problemDots");
  const rows = [
    ["Paid Task 01a114cd", "coffee brief", ["paid", "refunded", "paid", "paid", "paid", "paid"]],
    ["Redeemer showcase", "ade682cb", ["paid", "paid", "paid", "paid", "paid", "refunded"]],
    ["Coffee brief run", "b945c5e3", ["paid", "refunded", "paid", "paid", "refunded"]],
    ["Coffee brief, cancelled", "2752ccc0", ["refunded", "refunded", "paid", "refunded", "paid"]],
  ];
  rows.forEach(([name, sub, dots], r) => {
    const y = 40 + r * 92;
    txt(svg, 0, y + 4, name, 23, { weight: 600 });
    txt(svg, 0, y + 30, sub, 18, { fill: C.muted });
    dots.forEach((o, i) => el(svg, "circle", { cx: 340 + i * 66, cy: y + 10, r: 25, fill: o === "paid" ? C.greenDot : C.orange }));
  });
  const ly = 400;
  el(svg, "circle", { cx: 10, cy: ly - 6, r: 10, fill: C.greenDot }); txt(svg, 30, ly, "15 delivered and paid", 21, { fill: C.ink2 });
  el(svg, "circle", { cx: 300, cy: ly - 6, r: 10, fill: C.orange }); txt(svg, 320, ly, "7 refunded up the tree", 21, { fill: C.ink2 });
  const slide = S(2);
  circle(slide, 1000 + 340 + 5 * 66 - 36, 470 + 40 + 92 - 26 + 10 - 10, 72, 72, C.green);
  note(slide, 1720, 590, "test agent,<br>fails on purpose", 190, 20);
}

// 3 Why now: x402 monthly transaction counts, linear scale so the gap shows.
{
  const svg = document.getElementById("whyChart");
  const a = 46574, b = 75.41e6, max = 80e6;
  const x0 = 0, w = 900, top = 40;
  const bars = [["September 2025", "ForkLog", a, C.muted], ["Last 30 days, to 7 Oct 2026", "x402.org", b, C.green]];
  bars.forEach(([label, src, v, col], i) => {
    const y = top + i * 170;
    txt(svg, x0, y, label, 24, { weight: 600 });
    txt(svg, x0, y + 28, `${src} · x402 transactions`, 18, { fill: C.muted });
    const bw = Math.max(3, (v / max) * w);
    el(svg, "rect", { x: x0, y: y + 46, width: bw, height: 64, rx: 4, fill: col });
    txt(svg, i === 0 ? x0 + 24 : x0 + bw - 18, y + 90, i === 0 ? "46,574" : "75.41M", 30, { weight: 700, fill: i === 0 ? C.ink : "#fff", anchor: i === 0 ? "start" : "end" });
  });
  const axisY = top + 2 * 170 + 10;
  el(svg, "line", { x1: 0, y1: axisY, x2: w, y2: axisY, stroke: C.line, "stroke-width": 1.5 });
  [0, 20, 40, 60, 80].forEach((m) => { const x = (m * 1e6 / max) * w; txt(svg, x, axisY + 30, m === 0 ? "0" : `${m}M`, 18, { fill: C.muted, anchor: m === 0 ? "start" : "middle" }); });
  const slide = S(3);
  circle(slide, 84, 494, 200, 90, C.orange);
  note(slide, 330, 500, "a bar too thin to see at this scale", 340, 24);
  arrow(slide, "M 325 525 C 300 520, 290 525, 282 532", "green");
  note(slide, 560, 868, "over 1,600× in about a year", 460, 30);
}

// 4 Today vs Cascade.
{
  const t = document.getElementById("todaySvg");
  const box = (svg, x, y, w, h, label, fill, stroke) => { el(svg, "rect", { x, y, width: w, height: h, rx: 12, fill, stroke, "stroke-width": 1.5 }); txt(svg, x + w / 2, y + h / 2 + 8, label, 22, { anchor: "middle", weight: 600 }); };
  box(t, 0, 160, 170, 70, "Buyer", "#fff", C.line);
  box(t, 290, 160, 210, 70, "Coordinator", "#fff", C.line);
  const leaves = ["Research", "Pricing", "Writer", "Checker"];
  leaves.forEach((l, i) => {
    const y = 10 + i * 105;
    box(t, 700, y, 190, 66, l, "#fff", C.line);
    el(t, "path", { d: `M 500 195 C 600 195, 600 ${y + 33}, 698 ${y + 33}`, fill: "none", stroke: C.orange, "stroke-width": 2.2, "stroke-dasharray": "6 6" });
    txt(t, 905, y + 40, "trust + front money", 19, { fill: C.burnt, italic: true });
  });
  el(t, "line", { x1: 170, y1: 195, x2: 288, y2: 195, stroke: C.green, "stroke-width": 2.4 });
  txt(t, 229, 150, "1 escrow", 19, { fill: C.green, anchor: "middle", italic: true });
  const steps = ["1 Buyer pays one agent, one Masumi escrow", "2 That agent pays each sub-agent from its own wallet", "3 No plan the buyer signed, no view of who did what", "4 A failed sub-agent is the coordinator's loss"];
  steps.forEach((s, i) => txt(t, 0, 470 - (3 - i) * 0 + i * 0, "", 1));
  const list = document.createElement("div");
  list.className = "abs small";
  list.style.cssText = "left:100px;top:880px;width:1100px;font-size:22px;line-height:1.5;display:grid;grid-template-columns:1fr 1fr;column-gap:40px";
  list.innerHTML = steps.map((s) => `<div>${s}</div>`).join("");
  S(4).appendChild(list);

  const c = document.getElementById("cascadeSvg");
  box(c, 0, 0, 500, 66, "Buyer pays once", C.greenSoft, C.green);
  box(c, 90, 120, 320, 66, "Root escrow", "#fff", C.green);
  el(c, "line", { x1: 250, y1: 66, x2: 250, y2: 118, stroke: C.green, "stroke-width": 2.4 });
  for (let i = 0; i < 5; i++) {
    const x = 10 + i * 98;
    el(c, "rect", { x, y: 260, width: 80, height: 56, rx: 10, fill: "#fff", stroke: C.green, "stroke-width": 1.5 });
    el(c, "path", { d: `M 250 186 C 250 230, ${x + 40} 220, ${x + 40} 258`, fill: "none", stroke: C.green, "stroke-width": 2 });
  }
  txt(c, 250, 300, "", 1);
  txt(c, 0, 370, "Each hire is a child escrow the", 22, { fill: C.ink2 });
  txt(c, 0, 402, "validators check: budget, plan, deadline.", 22, { fill: C.ink2 });
  txt(c, 0, 450, "Failed work refunds up the tree.", 22, { fill: C.green, weight: 650 });
  note(S(4), 1600, 690, "", 10);
}

// 5 How it works: the money funnel of tree 4b50da32 (tree and receipt APIs, 7 Oct 2026).
{
  const svg = document.getElementById("funnel");
  const cols = [
    { n: "1", title: "Sokosumi Task", sub: "Buyer pays 1 test USDM into Masumi escrow", val: "60 ADA", h: 60 },
    { n: "2", title: "Plan committed", sub: "6 specs, Merkle root 74cc17d2… in the root datum", val: "60 ADA", h: 60 },
    { n: "3", title: "Child escrows", sub: "5 drawn; each ≤ 31.67% of its parent, depth ≤ 2", val: "45.625 ADA", h: 45.625 },
    { n: "4", title: "Checked", sub: "Checker A and the parent accept; 10 min challenge window", val: "31.375 ADA", h: 31.375 },
    { n: "5", title: "Closed", sub: "Paid down to 4 agents and the Conductor; the rest back to the buyer", val: "37.375 ADA", h: 60 },
  ];
  const colW = 344, maxH = 340, baseY = 470;
  cols.forEach((c, i) => {
    const x = i * colW;
    const h = (c.h / 60) * maxH;
    const nh = i < cols.length - 1 ? (cols[i + 1].h / 60) * maxH : h;
    if (i === 4) {
      const ph = (37.375 / 60) * maxH;
      el(svg, "rect", { x, y: baseY - ph, width: colW - 4, height: ph, fill: C.green });
      el(svg, "rect", { x, y: baseY - maxH, width: colW - 4, height: maxH - ph, fill: C.orange });
      txt(svg, x + 18, baseY - maxH + 46, "22.625 ADA back", 30, { weight: 700, fill: "#fff" });
    } else {
      el(svg, "path", { d: `M ${x} ${baseY - h} L ${x + colW - 4} ${baseY - (i < 3 ? nh : h)} L ${x + colW - 4} ${baseY} L ${x} ${baseY} Z`, fill: C.greenSoft });
    }
    txt(svg, x + 18, 34, `${c.n} ${c.title}`, 27, { weight: 650 });
    const words = c.sub.split(" ");
    let line = "", ly = 66;
    for (const w of words) { if ((line + " " + w).length > 26) { txt(svg, x + 18, ly, line.trim(), 19, { fill: C.ink2 }); line = w; ly += 26; } else line += " " + w; }
    txt(svg, x + 18, ly, line.trim(), 19, { fill: C.ink2 });
    txt(svg, x + 18, baseY - 24, i === 4 ? "37.375 ADA paid" : c.val, i === 4 ? 30 : 34, { weight: 700, fill: i === 4 ? "#fff" : C.green });
  });
  // refund branch
  el(svg, "rect", { x: 3 * colW, y: baseY + 30, width: 2 * colW - 4, height: 70, rx: 10, fill: C.orangeSoft });
  txt(svg, 3 * colW + 18, baseY + 73, "Pricer missed its deadline: 14.25 ADA refunded to the root", 21, { fill: C.burnt, weight: 600 });
  const extra = document.createElement("div");
  extra.className = "abs";
  extra.style.cssText = "left:100px;top:860px;width:620px;font-size:22px;color:#4A4642;line-height:1.4";
  extra.innerHTML = "Every lovelace is accounted for: 37.375 paid plus 22.625 returned is the 60 locked. A second Scribe was hired to cover the Pricer's missing work.";
  S(5).appendChild(extra);
  const slide = S(5);
  note(slide, 800, 930, "validators check every draw", 360, 24);
  arrow(slide, "M 790 945 C 760 940, 745 880, 745 815", "green");
}

// 6 Product flow on real screens.
{
  const flow = document.getElementById("flow");
  const items = [["landing-crop.png", "1 Describe a goal or open a Task"], ["console-crop.png", "2 Fund it; every job lists its cost"], ["tree-crop.png", "3 Watch each escrow live"], ["receipt-crop.png", "4 Receipt, reconciled to chain"]];
  items.forEach(([img, label], i) => {
    const x = i * 440;
    const d = document.createElement("div");
    d.className = "abs";
    d.style.cssText = `left:${x}px;top:0;width:400px`;
    d.innerHTML = `<div class="shot" style="height:300px"><img src="shots/${img}" style="height:100%;width:100%;object-fit:cover;object-position:center top"></div><div style="font-size:24px;font-weight:600;margin-top:22px"><span style="color:#1F7A50">${label.slice(0, 1)}</span>${label.slice(1)}</div>`;
    flow.appendChild(d);
    if (i < 3) arrow(S(6), `M ${100 + x + 404} 520 C ${100 + x + 416} 512, ${100 + x + 424} 512, ${100 + x + 436} 520`, "green");
  });
  const slide = S(6);
  circle(slide, 1225, 528, 145, 80, C.orange);
  note(slide, 1170, 740, "Pricer missed its deadline: refunded", 260, 22);
  circle(slide, 1600, 412, 200, 60, C.orange);
  note(slide, 1610, 740, "85.36 ADA in, every lovelace reconciled", 240, 22);
}

// 7 Demo: play badge over the poster.
{
  const f = document.getElementById("videoFrame");
  f.insertAdjacentHTML("beforeend", `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(22,21,20,.08)"><div style="width:150px;height:150px;border-radius:50%;background:rgba(31,122,80,.94);display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(0,0,0,.25)"><svg width="60" height="60" viewBox="0 0 60 60"><path d="M18 10 L50 30 L18 50 Z" fill="#fff"/></svg></div></div>`);
}

// 8 Proof timeline (tree 4b50da32 and docs/submission/builderbase.md; times IST, 7 Oct 2026).
{
  const svg = document.getElementById("proofLine");
  const ev = [
    ["10:53", "Masumi escrow lock", "3585e64c…", "green"],
    ["10:56", "Root funded, 60 ADA", "f22e344b…", "green"],
    ["11:44", "Pricer misses deadline", "refund 03fdc78d…", "orange"],
    ["14:17", "Tree closes", "37.375 paid · 22.625 back", "green"],
    ["14:56", "Seller collects", "db84039e…", "green"],
  ];
  const w = 1720, y = 60;
  el(svg, "line", { x1: 10, y1: y, x2: w - 10, y2: y, stroke: C.green, "stroke-width": 3 });
  ev.forEach(([t, title, sub, col], i) => {
    const x = 20 + i * ((w - 330) / 4);
    el(svg, "circle", { cx: x, cy: y, r: 13, fill: C.bg ?? "#F2EEEA", stroke: col === "orange" ? C.orange : C.green, "stroke-width": 4 });
    txt(svg, x - 10, y - 26, t, 22, { weight: 700, fill: col === "orange" ? C.burnt : C.green });
    txt(svg, x - 10, y + 50, title, 24, { weight: 620 });
    txt(svg, x - 10, y + 80, sub, 19, { fill: C.muted });
  });
  const slide = S(8);
  slide.querySelectorAll(".shot").forEach((s) => { s.style.height = "350px"; });
  circle(slide, 236, 826, 330, 44, C.orange);
  circle(slide, 1156, 826, 330, 44, C.orange);
}

// 9 Fees of every tree action on preprod (demo/out/redeemers.json, 6 Oct 2026).
{
  const fees = [["Draw (native)", 775765], ["Draw (receipt)", 761946], ["Resolve", 577872], ["CloseRoot", 567360], ["SettleChild", 559481], ["Challenge", 553248], ["FundRoot", 552884], ["CloseReceipt, metered", 551369], ["Cancel", 547446], ["Refund", 536925], ["TopUp", 509124], ["Submit", 496785], ["Escalate", 495294], ["Accept", 493224], ["Unfreeze", 487315], ["Freeze", 487144], ["CloseReceipt, Masumi", 484204]];
  const svg = document.getElementById("feeChart");
  const x0 = 260, w = 640, max = 0.8, rowH = 34;
  fees.forEach(([n, f], i) => {
    const y = 10 + i * rowH;
    const ada = f / 1e6;
    txt(svg, x0 - 16, y + 18, n, 18, { anchor: "end", fill: C.ink2 });
    el(svg, "rect", { x: x0, y: y + 3, width: (ada / max) * w, height: 20, rx: 3, fill: n === "Refund" ? C.green : C.greenSoft });
    txt(svg, x0 + (ada / max) * w + 10, y + 19, ada.toFixed(2), 17, { fill: C.ink2, weight: 600 });
  });
  const ay = 10 + fees.length * rowH + 8;
  [0, 0.2, 0.4, 0.6, 0.8].forEach((v) => { const x = x0 + (v / max) * w; el(svg, "line", { x1: x, y1: 8, x2: x, y2: ay, stroke: C.line, "stroke-width": 1 }); txt(svg, x, ay + 24, `${v} ADA`, 16, { fill: C.muted, anchor: "middle" }); });
  txt(svg, 0, ay + 62, "Fee paid for each action, one preprod transaction each, read back from chain. demo/out/redeemers.json, 6 Oct 2026.", 16, { fill: C.muted });
  const slide = S(9);
  circle(slide, 100 + x0 - 250, 370 + 10 + 9 * rowH - 2, 250 + (0.537 / max) * w + 60, 34, C.orange);
  note(slide, 100 + x0 + 560, 400 + 220, "anyone can crank a refund for about 0.54 ADA", 300, 24);
}

// 10 Deadlines nest: submit_by of every node in tree 4b50da32 (UTC, 7 Oct 2026).
{
  const svg = document.getElementById("gantt");
  const t0 = 5 * 60 + 26, t1 = 9 * 60;
  const nodes = [["Checker A", 5 * 60 + 48, "Settled"], ["Pricer", 6 * 60 + 14, "Refunded"], ["Scout", 6 * 60 + 30, "Settled"], ["Scribe", 7 * 60, "Settled"], ["Scribe, replaces Pricer", 7 * 60 + 47, "Settled"]];
  const x0 = 330, w = 1300;
  const X = (m) => x0 + ((m - t0) / (t1 - t0)) * w;
  const root = 8 * 60 + 34;
  el(svg, "rect", { x: X(t0), y: 0, width: X(root) - X(t0), height: 46, rx: 6, fill: C.green });
  txt(svg, x0 - 20, 30, "Root, Conductor", 22, { anchor: "end", weight: 650 });
  txt(svg, X(root) - 14, 31, "submit by 08:34", 20, { anchor: "end", fill: "#fff", weight: 600 });
  nodes.forEach(([n, m, st], i) => {
    const y = 80 + i * 56;
    const col = st === "Refunded" ? C.orange : C.greenDot;
    el(svg, "line", { x1: X(t0), y1: y + 18, x2: X(m), y2: y + 18, stroke: col, "stroke-width": 3 });
    el(svg, "circle", { cx: X(m), cy: y + 18, r: 12, fill: col });
    txt(svg, x0 - 20, y + 25, n, 21, { anchor: "end", fill: C.ink2 });
    const hh = String(Math.floor(m / 60)).padStart(2, "0"), mm = String(m % 60).padStart(2, "0");
    txt(svg, X(m) + 22, y + 25, `${hh}:${mm}${st === "Refunded" ? "  missed, refunded" : ""}`, 19, { fill: st === "Refunded" ? C.burnt : C.ink2, weight: 600 });
  });
  el(svg, "line", { x1: X(root), y1: 50, x2: X(root), y2: 380, stroke: C.green, "stroke-width": 2, "stroke-dasharray": "7 7" });
  const ay = 400;
  el(svg, "line", { x1: x0, y1: ay, x2: x0 + w, y2: ay, stroke: C.line, "stroke-width": 1.5 });
  for (let m = 6 * 60; m <= t1; m += 60) txt(svg, X(m), ay + 28, `${String(m / 60).padStart(2, "0")}:00`, 17, { fill: C.muted, anchor: "middle" });
  txt(svg, x0, ay + 28, "05:26 funded", 17, { fill: C.muted });
  txt(svg, 0, ay + 62, "Deadline (submit_by) of every node, UTC. Tree 4b50da32 on preprod, live tree API, read 7 Oct 2026.", 16, { fill: C.muted });
  const slide = S(10);
  note(slide, 100 + X(root) - 330, 470 + 250, "a child deadline past this line fails validation", 300, 24);
  arrow(slide, `M ${100 + X(root) - 25} ${470 + 270} C ${100 + X(root) - 12} ${470 + 270}, ${100 + X(root) - 8} ${470 + 270}, ${100 + X(root) - 4} ${470 + 270}`, "green");
}

// 11 Attacks by action (tests/adversarial/report.json, 64 cases, all rejected_by_script).
{
  const by = [["Draw", 15], ["FundRoot", 9], ["Cancel", 5], ["TopUp", 5], ["CloseReceipt", 4], ["Resolve", 3], ["CloseRoot", 3], ["SettleChild", 3], ["Accept", 2], ["OwnerReclaim", 2], ["Challenge", 2], ["Redeem", 2], ["Escalate", 2], ["Freeze", 2], ["Refund", 2], ["Submit", 2], ["Unfreeze", 1]];
  const svg = document.getElementById("attackChart");
  const x0 = 200, rowH = 25.5;
  by.forEach(([n, c], i) => {
    const y = i * rowH;
    txt(svg, x0 - 16, y + 18, n, 17, { anchor: "end", fill: C.ink2 });
    for (let k = 0; k < c; k++) el(svg, "circle", { cx: x0 + 12 + k * 26, cy: y + 12, r: 10, fill: C.greenDot });
    txt(svg, x0 + 12 + c * 26 + 6, y + 18, String(c), 17, { fill: C.ink2, weight: 600 });
  });
  txt(svg, 0, by.length * rowH + 28, "Each dot is one forged transaction; every one was rejected by the script.", 18, { fill: C.muted });
  const slide = S(11);
  circle(slide, 780 + x0 - 2, 500 - 6, 15 * 26 + 30, 38, C.green);
  note(slide, 780 + x0 + 15 * 26 + 70, 500 - 6, "one lovelace over budget, a deadline past the parent's, a plan the buyer did not sign", 420, 23);
}

// 12 Audit findings (security/review-report.md).
{
  const svg = document.getElementById("auditChart");
  const rows = [
    ["Independent audit, 1 Oct", "audit 21f7228, re-review 814cc42", [["F1", "c"], ["F2", "c"], ["F3", "m"], ["F4", "m"], ["F5", "m"]]],
    ["End-of-wave evaluator", "fixed in ddeab4b", Array.from({ length: 14 }, (_, i) => [`E${i + 1}`, i === 0 ? "c" : i === 12 ? "l" : "o"])],
  ];
  rows.forEach(([name, sub, dots], r) => {
    const y = r * 170;
    txt(svg, 0, y + 30, name, 26, { weight: 650 });
    txt(svg, 0, y + 58, sub, 18, { fill: C.muted });
    dots.forEach(([id, sev], i) => {
      const cx = 30 + i * 74, cy = y + 112;
      const fill = sev === "c" ? C.burnt : sev === "m" ? C.orange : sev === "l" ? C.line : C.card;
      el(svg, "circle", { cx, cy, r: 28, fill, stroke: sev === "o" ? C.line : "none" });
      txt(svg, cx, cy + 7, id, 17, { anchor: "middle", weight: 650, fill: sev === "c" || sev === "m" ? "#fff" : C.ink2 });
    });
  });
  const ly = 400;
  [["Critical", C.burnt], ["Medium", C.orange], ["Low or unrated", C.line]].forEach(([n, col], i) => { el(svg, "circle", { cx: 10 + i * 220, cy: ly - 6, r: 10, fill: col }); txt(svg, 30 + i * 220, ly, n, 20, { fill: C.ink2 }); });
  txt(svg, 680, ly, "All 19 fixed, each with a regression test", 20, { fill: C.green, weight: 650 });
  const slide = S(12);
  circle(slide, 100 + 0, 500 + 76, 165, 76, C.orange);
  note(slide, 100 + 420, 500 + 18, "budget accounting could drift; a forced reward withdrawal could halt a tree", 520, 22);
  arrow(slide, "M 515 540 C 400 540, 300 560, 270 585", "green");
}

// 14 Business model: three revenue lines, in the order they can start.
{
  const svg = document.getElementById("bizChart");
  const bars = [["1", "Orchestrator fee", "per tree, 10% in our paid Task", 150, C.green, "#fff"], ["2", "Protocol fee", "basis points, at mainnet", 260, C.greenSoft, C.green], ["3", "SDK and services", "for agent builders, later", 340, C.greenSoft, C.green]];
  const base = 540;
  bars.forEach(([n, title, sub, h, fill, nfill], i) => {
    const x = i * 262;
    el(svg, "rect", { x, y: base - h, width: 248, height: h, fill });
    txt(svg, x + 22, base - h + 52, n, 40, { weight: 700, fill: nfill });
    txt(svg, x, base - h - 70, title, 27, { weight: 650 });
    const words = sub.split(" "); let line = "", ly = base - h - 42;
    for (const w of words) { if ((line + " " + w).length > 22) { txt(svg, x, ly, line.trim(), 18, { fill: C.ink2 }); line = w; ly += 23; } else line += " " + w; }
    txt(svg, x, ly, line.trim(), 18, { fill: C.ink2 });
  });
  el(svg, "line", { x1: 0, y1: base, x2: 780, y2: base, stroke: C.ink, "stroke-width": 2 });
  circle(S(14), 100 + 250, 380 + 40, 290, 120, C.green);
}

// 15 Roadmap.
{
  const svg = document.getElementById("roadmap");
  const done = [["1 Oct", "Design and prototypes"], ["6 Oct", "7 scripts on preprod"], ["7 Oct", "4 paid Sokosumi Tasks"]];
  const next = [["Next", "Second contract audit"], ["Then", "Mainnet: Masumi vested_pay, USDM budgets"], ["Later", "Open marketplace: any Coworker as a leaf"]];
  const y = 110, w = 1720;
  txt(svg, 0, 30, "DONE ON PREPROD", 19, { fill: C.green, weight: 650, ls: "2" });
  txt(svg, 860, 30, "AFTER THE HACKATHON", 19, { fill: C.muted, weight: 650, ls: "2" });
  el(svg, "line", { x1: 10, y1: y, x2: 750, y2: y, stroke: C.green, "stroke-width": 4 });
  el(svg, "line", { x1: 750, y1: y, x2: w - 20, y2: y, stroke: C.muted, "stroke-width": 3, "stroke-dasharray": "10 10" });
  [...done, ...next].forEach(([d, t], i) => {
    const x = 30 + i * 288;
    const isDone = i < 3;
    el(svg, "circle", { cx: x, cy: y, r: 15, fill: isDone ? C.green : "#F2EEEA", stroke: isDone ? C.green : C.muted, "stroke-width": 4 });
    txt(svg, x - 12, y + 56, d, 22, { weight: 700, fill: isDone ? C.green : C.ink2 });
    const words = t.split(" "); let line = "", ly = y + 88;
    for (const wd of words) { if ((line + " " + wd).length > 20) { txt(svg, x - 12, ly, line.trim(), 23, { weight: 560 }); line = wd; ly += 30; } else line += " " + wd; }
    txt(svg, x - 12, ly, line.trim(), 23, { weight: 560 });
  });
  el(svg, "rect", { x: 750 - 60, y: y - 26, width: 120, height: 52, rx: 26, fill: C.orange });
  txt(svg, 750, y + 8, "today", 22, { anchor: "middle", weight: 700, fill: "#fff" });
}
