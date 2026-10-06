/**
 * Records the PRD 21.2 demo flow on preprod through the public web console and Tree Explorer.
 *
 * Run (final): scripts/heavy.sh pnpm --filter @cascade/demo record -- --stage
 * Run (dry):   scripts/heavy.sh pnpm --filter @cascade/demo record -- --dry-run
 * Web app:     CASCADE_DEMO_WEB_URL=http://localhost:3100 to drive a local build (demo/web-local.ts);
 *              the deployed origin otherwise.
 *
 * The buyer signs through a CIP-30 test wallet injected into the page (src/wallet-shim.ts) with
 * the demo-buyer account, so a recording never competes with verify:all for the buyer's UTxOs; its
 * key stays in this process. Captions and test-agent labels are drawn over the real app. Nothing
 * is cut: waits for preprod blocks are sped up with a visible speed badge, and every moment the
 * event feed changes plays at real time.
 *
 * Dry run: plans a job and opens the funding dialog up to the decoded, unsigned FundRoot, but the
 * wallet refuses to submit, so no money moves. It then replays an existing closed demo tree in the
 * explorer and shows its receipt, and encodes the video, to check the whole pipeline.
 *
 * Output: demo/out/cascade-demo.mp4 (or cascade-demo-dryrun.mp4), demo/out/cascade-demo.json.
 */
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import { chromium, type Page } from "@playwright/test";
import { z } from "zod";
import { caption, installNameShim, installOverlay, speedBadge, titleCard } from "./src/overlay.js";
import { CARDANOSCAN_TX, DEMO_BUYER_ROLE, deployedOrigin, lucidFor, readJson, repoPath, role, sleep, webOrigin } from "./src/preprod.js";
import { encode, outputSegments, outputTime, posterFrame, rawDuration, Timeline } from "./src/video.js";
import { installWalletShim, SHIM_WALLET_NAME } from "./src/wallet-shim.js";

const DRY_RUN = process.argv.includes("--dry-run");
/** The full flow with real money, written under a rehearsal name so it never replaces the final video. */
const REHEARSAL = process.argv.includes("--rehearsal");
const OUT_NAME = DRY_RUN ? "cascade-demo-dryrun" : REHEARSAL ? "cascade-demo-rehearsal" : "cascade-demo";
const ORIGIN = webOrigin();
/** Trees are public on the deployed site whichever build recorded them. */
const PUBLIC_ORIGIN = deployedOrigin();
const API = `${ORIGIN}/api/v1`;
const GOAL = "Market-entry brief for cold-pressed juice in Dubai, with a competitor price table, an Arabic summary and a fact check.";
const BUDGET_ADA = process.env.DEMO_BUDGET_ADA ?? "150";
const MAX_RUN_MS = Number(process.env.DEMO_MAX_RUN_MIN ?? "240") * 60_000;
const FAST = 8;
/** Explorer stage mode (W5): bigger cards, live root balance, metered call counter. */
const STAGE = process.argv.includes("--stage");
const stageQuery = STAGE ? "?stage=1" : "";
const VIEWPORT = { width: 1600, height: 900 };

const log = (msg: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const short = (h: string): string => `${h.slice(0, 10)}...${h.slice(-6)}`;
const ada = (lovelace: string | number | bigint): string => `${(Number(lovelace) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })} ADA`;

// ---------------------------------------------------------------------------------------------
// Public API reads (the same endpoints the web app uses)

const TreeEvent = z.looseObject({ type: z.string(), node_id: z.string(), tx_id: z.string(), payload: z.unknown() });
type TreeEvent = z.infer<typeof TreeEvent>;
const TreeNode = z.looseObject({ node_id: z.string(), parent_id: z.string().nullable(), kind: z.string(), operator_vkh: z.string(), agent_asset_id: z.string().nullable(), budget: z.string(), fee: z.string(), state: z.string() });
const Tree = z.looseObject({ tree_id: z.string(), state: z.string(), nodes: z.array(TreeNode) });
const Agents = z.object({ agents: z.array(z.looseObject({ agent_asset_id: z.string(), name: z.string() })) });

async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return schema.parse(await res.json());
  } catch (err) {
    log(`read ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const events = async (treeId: string): Promise<TreeEvent[]> => (await getJson(`/trees/${treeId}/events?limit=1000`, z.object({ events: z.array(TreeEvent) })))?.events ?? [];

const roleNames = new Map(
  z
    .object({ wallets: z.array(z.object({ role: z.string(), paymentKeyHash: z.string() })) })
    .parse(readJson("deployments/wallets.preprod.json"))
    .wallets.map((w) => [w.paymentKeyHash, w.role.split("-").map((p) => p[0]?.toUpperCase() + p.slice(1)).join(" ")]),
);

class Names {
  private agents = new Map<string, string>();
  private nodes = new Map<string, z.infer<typeof TreeNode>>();

  async refresh(treeId: string): Promise<void> {
    if (this.agents.size === 0) for (const a of (await getJson("/agents", Agents))?.agents ?? []) this.agents.set(a.agent_asset_id, a.name.replace(/^Cascade /, ""));
    for (const n of (await getJson(`/trees/${treeId}`, Tree))?.nodes ?? []) this.nodes.set(n.node_id, n);
  }

  node(id: string) {
    return this.nodes.get(id);
  }

  name(id: string): string {
    const n = this.nodes.get(id);
    if (n === undefined) return `node ${id.slice(0, 6)}`;
    if (n.agent_asset_id !== null) {
      const a = this.agents.get(n.agent_asset_id);
      if (a !== undefined) return a;
    }
    if (n.kind === "MeteredReceipt") return "Lookup API channel";
    if (n.kind === "MasumiReceipt") return "Lisan (Masumi)";
    return roleNames.get(n.operator_vkh) ?? `node ${id.slice(0, 6)}`;
  }
}

/** One caption per event, in plain words, with the transaction it refers to. */
function describe(e: TreeEvent, names: Names): string | null {
  const n = names.node(e.node_id);
  const who = names.name(e.node_id);
  const parent = n?.parent_id == null ? "the buyer" : names.name(n.parent_id);
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "tree.funded":
      return `The buyer funded the root with one signature. ${n === undefined ? "" : `${ada(n.budget)} is locked on chain.`}`;
    case "node.drawn":
      if (p.kind === "AddressPayment" || n?.kind === "AddressPayment")
        return /lisan/i.test(who)
          ? `${parent} hired Lisan, an unmodified Masumi agent: the tree paid Lisan's Masumi purchase wallet, which locked the job in Masumi's vested_pay. The receipt shows its blockchainIdentifier.`
          : `${parent} paid a third-party x402 endpoint from the tree budget.`;
      if (n?.kind === "MeteredReceipt") return `${parent} opened a metered channel to the Lookup API. Calls are paid with off-chain vouchers.`;
      if (n?.kind === "MasumiReceipt") return `${parent} hired Lisan, an unmodified Masumi agent, from the tree budget. The Masumi lock is on chain.`;
      return `${parent} hired ${who} into a child escrow${n === undefined ? "" : ` of ${ada(n.budget)}`}.`;
    case "node.submitted":
      return `${who} submitted its result hash on chain.`;
    case "node.verified":
      return `${who} returned a signed verdict.`;
    case "node.challenged":
      return `${who}'s result was challenged. A bond is posted.`;
    case "node.resolved":
      return `${who}'s dispute was resolved by signed split.`;
    case "node.accepted":
      return `${who}'s result was accepted.`;
    case "node.refunded":
      return /flaky|lisan-b/i.test(who)
        ? `${who}, a test agent that fails on purpose, missed its deadline. The watchtower cranked the refund back into ${parent}.`
        : `${who} missed its deadline. Its budget was refunded into ${parent}.`;
    case "node.settled":
      return n?.parent_id == null ? null : `${who} settled: fee ${ada(String(p.fee_paid ?? n?.fee ?? 0))} paid, the rest returned to ${parent}.`;
    case "receipt.closed":
      return `${who} receipt closed into ${parent}.`;
    case "tree.frozen":
      return "The buyer froze the tree.";
    case "tree.closed":
      return `CloseRoot settled the tree. Paid ${ada(String(p.paid ?? 0))}, refunded ${ada(String(p.refunded ?? 0))} to the buyer.`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Pacing: real time whenever the screen changes, sped up while waiting for blocks

class Pace {
  private quietTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly page: Page,
    private readonly timeline: Timeline,
  ) {}

  realTime(holdMs = 15_000): void {
    this.timeline.setSpeed(1);
    void speedBadge(this.page, "");
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.fast(), holdMs);
  }

  fast(): void {
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    this.timeline.setSpeed(FAST);
    void speedBadge(this.page, `Waiting for deadline, ${FAST}x speed`);
  }

  stop(): void {
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.timeline.setSpeed(1);
    void speedBadge(this.page, "");
  }
}

/** Calls `onChange` whenever the event feed on screen gains an entry (no network involved). */
async function watchFeed(page: Page, onChange: () => void): Promise<void> {
  await page.exposeFunction("__cxFeedChanged", onChange).catch(() => undefined);
  await page.evaluate(() => {
    const w = window as unknown as { __cxFeedChanged: () => void; __cxWatching?: boolean };
    if (w.__cxWatching === true) return;
    w.__cxWatching = true;
    let last = -1;
    setInterval(() => {
      const count = document.querySelectorAll('[data-testid="event-feed"] > li').length;
      if (last !== -1 && count !== last) w.__cxFeedChanged();
      last = count;
    }, 1000);
  });
}

// ---------------------------------------------------------------------------------------------
// Steps

class OrchestratorOffline extends Error {
  override readonly name = "OrchestratorOffline";
}

async function newJob(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/console/new`, { waitUntil: "networkidle" });
  await caption(page, "A buyer describes the job and sets one budget.", `Budget ${BUDGET_ADA} ADA on preprod. Depth up to 3 levels.`);
  await page.getByLabel("Goal").pressSequentially(GOAL, { delay: 18 });
  await page.getByLabel("Budget").fill(BUDGET_ADA);
  await page.locator("#job-asset").selectOption("lovelace");
  // The demo path needs about 141 min; the form asks for at least 4 h at depth 3.
  const deadlineMin = Number(process.env.DEMO_DEADLINE_MIN ?? "250");
  const deadline = new Date(Date.now() + deadlineMin * 60_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await page.locator("#job-deadline").fill(deadline);
  await page.locator("#job-maxDepth").selectOption("3");
  await page.getByText("I review the result").click();
  await sleep(1500);
  await page.getByRole("button", { name: "Get a plan" }).click();
  await caption(page, "The Conductor plans the tree: tasks, prices, rails, verifiers and nested deadlines.");
  const outcome = await Promise.race([
    page.waitForURL(/\/console\/plan\//, { timeout: 300_000 }).then(() => "plan" as const),
    page.getByText("Orchestrator offline").waitFor({ timeout: 300_000 }).then(() => "offline" as const),
  ]);
  if (outcome === "offline") throw new OrchestratorOffline(`${ORIGIN} shows "Orchestrator offline": the web build has no conductor URL, or the conductor is down`);
  await page.getByTestId("plan-rows").waitFor({ timeout: 120_000 });
}

async function reviewAndFund(page: Page): Promise<string | null> {
  await caption(page, "The buyer reviews the plan. Every node has a price, a rail and a deadline that fits inside its parent.");
  await page.getByTestId("plan-rows").scrollIntoViewIfNeeded();
  await sleep(6000);
  await page.getByTestId("plan-totals").scrollIntoViewIfNeeded();
  await sleep(4000);
  await page.getByRole("button", { name: "Fund this plan" }).click();
  await caption(page, "One signature funds the whole tree. The plan root in the escrow commits to every node.");
  await sleep(3000);
  await page.getByRole("button", { name: "Connect a preprod wallet" }).click();
  await page.getByRole("button", { name: SHIM_WALLET_NAME }).click();
  const sign = page.getByRole("button", { name: "Sign and fund" });
  await sign.waitFor({ timeout: 180_000 });
  await caption(page, "The indexer decodes the unsigned FundRoot before anything is signed.", "Test wallet: a preprod key held by the recording script.");
  await sleep(6000);
  if (DRY_RUN) {
    await caption(page, "Dry run: the wallet stops here. Nothing is signed or submitted.");
    await sleep(4000);
    await page.keyboard.press("Escape");
    return null;
  }
  const blocked = page.getByTestId("sign-flow").getByRole("alert");
  if (await blocked.isVisible().catch(() => false)) throw new Error(`the console blocked signing: ${(await blocked.innerText()).replace(/\s+/g, " ")}`);
  await sign.click();
  await page.getByText("Submitted to preprod").waitFor({ timeout: 180_000 });
  const href = await page.getByTestId("sign-flow").locator(`a[href^="${CARDANOSCAN_TX}"]`).first().getAttribute("href");
  const fundTx = href?.slice(CARDANOSCAN_TX.length) ?? null;
  await caption(page, "FundRoot submitted to preprod.", fundTx === null ? "" : `Transaction ${short(fundTx)}`);
  await sleep(4000);
  await page.getByRole("link", { name: "Watch the tree grow" }).click();
  await page.waitForURL(/\/console\/job\//, { timeout: 60_000 });
  if (STAGE) await page.goto(`${page.url().split("?")[0]}${stageQuery}`, { waitUntil: "networkidle" });
  return fundTx;
}

/** Follows the live job until CloseRoot, accepting the root result as the buyer when asked. */
interface SeenEvent {
  event: TreeEvent;
  /** Seconds into the raw recording when the event was captioned (or found, if it has no caption). */
  rawAt: number;
  caption: string | null;
}

async function followJob(page: Page, pace: Pace, timeline: Timeline, treeId: string, seen: SeenEvent[]): Promise<void> {
  const names = new Names();
  const done = new Set<string>();
  let accepted = false;
  const started = Date.now();
  let changed = true;
  await watchFeed(page, () => {
    changed = true;
    pace.realTime();
  });
  pace.realTime(30_000);
  for (;;) {
    if (Date.now() - started > MAX_RUN_MS) throw new Error(`the tree did not close within ${MAX_RUN_MS / 60_000} min`);
    if (changed) {
      changed = false;
      await names.refresh(treeId);
      const all = await events(treeId);
      for (const e of all) {
        const key = `${e.type}/${e.node_id}/${e.tx_id}`;
        if (done.has(key)) continue;
        done.add(key);
        const text = describe(e, names);
        pace.realTime();
        seen.push({ event: e, rawAt: timeline.now(), caption: text });
        if (text !== null) {
          await caption(page, text, `Transaction ${short(e.tx_id)}`);
          await sleep(4000);
        }
      }
      const root = names.node(treeId);
      if (!accepted && root?.state === "Submitted") {
        accepted = await acceptRoot(page, pace);
      }
      if (all.some((e) => e.type === "tree.closed")) return;
    }
    // The page's own data refresh drives `changed`; this read every 30 s is a fallback.
    await sleep(30_000);
    changed = true;
  }
}

async function acceptRoot(page: Page, pace: Pace): Promise<boolean> {
  const button = page.getByTestId("pending-actions").getByRole("button", { name: "Accept", exact: true });
  if (!(await button.isVisible().catch(() => false))) return false;
  pace.stop();
  await caption(page, "The root result arrives. The buyer accepts it with one signature.");
  await button.scrollIntoViewIfNeeded();
  await sleep(3000);
  await button.click();
  await page.getByRole("button", { name: "Connect a preprod wallet" }).click();
  await page.getByRole("button", { name: SHIM_WALLET_NAME }).click();
  const sign = page.getByRole("button", { name: "Sign and accept" });
  await sign.waitFor({ timeout: 180_000 });
  await sleep(3000);
  await sign.click();
  await page.getByText("Submitted to preprod").waitFor({ timeout: 180_000 });
  await caption(page, "Accept submitted. CloseRoot pays the Conductor and returns the rest to the buyer.");
  await sleep(4000);
  await page.keyboard.press("Escape");
  pace.realTime();
  return true;
}

async function explorerAndReceipt(page: Page, pace: Pace, treeId: string): Promise<void> {
  pace.stop();
  await page.goto(`${ORIGIN}/tree/${treeId}${stageQuery}`, { waitUntil: "networkidle" });
  await page.getByTestId("tree-explorer").waitFor({ timeout: 60_000 });
  await caption(page, "The public Tree Explorer replays the whole tree from chain events.", `${PUBLIC_ORIGIN.replace(/^https:\/\//, "")}/tree/${treeId.slice(0, 12)}...`);
  await sleep(4000);
  const replay = page.getByRole("button", { name: "Replay from the start" });
  if (await replay.isVisible().catch(() => false)) {
    await replay.click();
    await sleep(45_000);
  }
  await page.goto(`${ORIGIN}/receipt/${treeId}`, { waitUntil: "networkidle" });
  await caption(page, "The receipt lists every agent, price, hash and transaction.");
  await sleep(6000);
  const nodes = page.getByTestId("receipt-nodes");
  if (await nodes.isVisible().catch(() => false)) {
    await nodes.scrollIntoViewIfNeeded();
    await sleep(6000);
  }
  const line = page.getByTestId("reconciliation");
  await line.scrollIntoViewIfNeeded();
  await caption(page, "Deposits equal payouts plus refunds plus fees plus structural ADA returned, to the lovelace.");
  await sleep(10_000);
}

async function pickReplayTree(): Promise<string> {
  const fromEnv = process.env.DEMO_REPLAY_TREE;
  if (fromEnv !== undefined && /^[0-9a-f]{56}$/.test(fromEnv)) return fromEnv;
  const list = await getJson("/trees?limit=50", z.object({ trees: z.array(z.looseObject({ tree_id: z.string(), goal: z.string(), state: z.string(), node_count: z.number() })) }));
  const closed = (list?.trees ?? []).filter((t) => t.state === "closed").sort((a, b) => b.node_count - a.node_count);
  const pick = closed.find((t) => /juice/i.test(t.goal)) ?? closed[0];
  if (pick === undefined) throw new Error("no closed tree to replay; set DEMO_REPLAY_TREE");
  return pick.tree_id;
}

/**
 * The tree id derives from the funding wallet's seed UTxO, and the Conductor records a plan's tree
 * id as soon as it builds the unsigned FundRoot. A dry run (or any abandoned plan) therefore claims
 * the wallet's current seed, and the next plan from the same UTxO is refused. A self-payment
 * replaces the wallet's UTxOs, so every real recording funds from a seed no plan has claimed.
 */
async function freshSeed(lucid: LucidEvolution): Promise<string> {
  const address = await lucid.wallet().address();
  const tx = await lucid.newTx().pay.ToAddress(address, { lovelace: 5_000_000n }).complete();
  const hash = await (await tx.sign.withWallet().complete()).submit();
  log(`fresh seed UTxO: self-payment ${hash}`);
  for (let i = 0; i < 40; i++) {
    if (await lucid.awaitTx(hash, 15_000).catch(() => false)) {
      // Blockfrost's UTxO view can trail the confirmation by a block.
      await sleep(30_000);
      return hash;
    }
  }
  throw new Error(`self-payment ${hash} did not confirm`);
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const rawDir = mkdtempSync(join(tmpdir(), "cascade-demo-"));
  const buyerLucid = await lucidFor(role(DEMO_BUYER_ROLE));
  const followId = process.argv.find((a) => /^[0-9a-f]{56}$/.test(a)) ?? null;
  if (!DRY_RUN && followId === null) await freshSeed(buyerLucid);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, recordVideo: { dir: rawDir, size: VIEWPORT }, colorScheme: "light", reducedMotion: "no-preference" });
  await installNameShim(context);
  const signed = await installWalletShim(context, buyerLucid, { allowSubmit: !DRY_RUN });
  await installOverlay(context);
  const page = await context.newPage();
  const timeline = new Timeline();
  const pace = new Pace(page, timeline);
  const seen: SeenEvent[] = [];
  let treeId: string | null = null;
  let fundTx: string | null = null;
  let failure: string | null = null;

  try {
    await page.goto(ORIGIN, { waitUntil: "networkidle" });
    await titleCard(page, "Cascade", "Escrow trees for the agent supply chain. Recorded on Cardano preprod.");
    await sleep(5000);
    await titleCard(page, "", "");
    try {
      if (followId === null) {
        await newJob(page);
        fundTx = await reviewAndFund(page);
      } else {
        // Resume following a tree this script already funded (for example after a restart).
        log(`following existing tree ${followId}`);
        await page.goto(`${ORIGIN}/console/job/${followId}${stageQuery}`, { waitUntil: "networkidle" });
        fundTx = "resumed";
      }
    } catch (err) {
      // A dry run still checks the explorer, receipt and encoding steps when planning is unavailable.
      if (!DRY_RUN || !(err instanceof OrchestratorOffline)) throw err;
      log(`dry run: ${err.message}; continuing with the replay`);
      failure = err.message;
    }
    if (fundTx !== null) {
      treeId = followId ?? page.url().match(/\/console\/job\/([0-9a-f]{56})/)?.[1] ?? null;
      if (treeId === null) throw new Error("job page did not open after funding");
      await followJob(page, pace, timeline, treeId, seen);
    } else {
      treeId = await pickReplayTree();
      log(`dry run: replaying closed tree ${treeId}`);
      await page.goto(`${ORIGIN}/console/job/${treeId}`, { waitUntil: "networkidle" });
      await caption(page, "Dry run: an earlier preprod demo tree, closed.");
      pace.fast();
      await sleep(20_000);
    }
    await explorerAndReceipt(page, pace, treeId);
    await titleCard(page, "Cascade", "The buyer pays once. Every agent is paid only for verified work. Failed work refunds up the tree.");
    await sleep(5000);
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    log(`recording stopped: ${failure}`);
    await page.screenshot({ path: join(rawDir, "failure.png") }).catch(() => undefined);
  } finally {
    pace.stop();
    await context.close();
    await browser.close();
  }

  const raw = readdirSync(rawDir).find((f) => f.endsWith(".webm"));
  if (raw === undefined) throw new Error("Playwright wrote no video");
  const out = repoPath("demo", "out", `${OUT_NAME}.mp4`);
  const rawTotal = rawDuration(join(rawDir, raw));
  const duration = encode(join(rawDir, raw), out, timeline.segments, join(rawDir, "parts"));
  const segments = outputSegments(timeline.segments, rawTotal);
  const rawOf = (iso: string): number => (Date.parse(iso) - timeline.startMs) / 1000;
  posterFrame(out, Math.min(20, duration / 3), repoPath("demo", "out", `${OUT_NAME}-poster.png`));
  const report = {
    dryRun: DRY_RUN,
    rehearsal: REHEARSAL,
    recordedAt: new Date().toISOString(),
    origin: ORIGIN,
    treeId,
    explorer: treeId === null ? null : `${PUBLIC_ORIGIN}/tree/${treeId}`,
    receipt: treeId === null ? null : `${PUBLIC_ORIGIN}/receipt/${treeId}`,
    fundTx,
    fundTxIsResume: fundTx === "resumed",
    timing: "at = seconds into the final video, after the speed-up mapping; factor = playback speed at that moment (1 is real time). Segments cover the whole video with no gaps.",
    walletSigned: signed.map((w) => ({ ...w, ...outputTime(segments, rawOf(w.at)), link: `${CARDANOSCAN_TX}${w.txHash}` })),
    events: seen.map((e) => ({
      type: e.event.type,
      node: e.event.node_id,
      tx: e.event.tx_id,
      link: `${CARDANOSCAN_TX}${e.event.tx_id}`,
      caption: e.caption,
      ...outputTime(segments, e.rawAt),
    })),
    segments,
    outputSeconds: Math.round(duration),
    failure,
  };
  writeFileSync(repoPath("demo", "out", `${OUT_NAME}.json`), `${JSON.stringify(report, null, 2)}\n`);
  log(`wrote ${out} (${Math.round(duration)} s), raw video in ${rawDir}`);
  if (failure !== null) {
    log(`not clean: ${failure}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
