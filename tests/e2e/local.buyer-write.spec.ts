/**
 * Buyer write flow on the local stack (PRD 14.1, 14.2, 14.4): describe a job, plan it through the
 * local Conductor, review, fund with a CIP-30 test wallet, accept the root result and read the
 * receipt. The wallet is a real devnet key (qa-buyer in deployments/wallets.local.json) that signs
 * and submits on Yaci; nothing on the chain path is mocked.
 */
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { localWebUrl } from "../lib/local-web.js";
import { allowlistLocalAgents } from "./local-directory.js";
import { freshLocalSeed, installLocalWallet, LOCAL_WALLET_NAME, localRoleLucid } from "./local-wallet.js";

const BUYER_ROLE = "qa-buyer";
/** The local indexer (scripts/local-stack.ts services block). */
const LOCAL_INDEXER = process.env.E2E_LOCAL_INDEXER_URL ?? "http://127.0.0.1:36100";
/** The local Conductor: its preprod port in agents/kit/src/roles.ts plus 10000. */
const LOCAL_CONDUCTOR = process.env.E2E_LOCAL_CONDUCTOR_URL ?? "http://127.0.0.1:34001";

const PlanNodeShape: z.ZodType<{ spec: { rail: string }; children: unknown[] }> = z.looseObject({ spec: z.looseObject({ rail: z.string() }), children: z.array(z.unknown()) });
const PlanEnvelopeShape = z.looseObject({ plan: z.looseObject({ root: PlanNodeShape }) });
const TreeEventsShape = z.object({ events: z.array(z.looseObject({ type: z.string(), node_id: z.string(), payload: z.unknown() })), next: z.string().nullable() });
const DrawnPayload = z.looseObject({ spec_hash: z.string() });

/** Planned descendants that become node UTxOs through a Draw: every child except AddressPayment (x402) leaves. */
function plannedDraws(node: { spec: { rail: string }; children: unknown[] }): number {
  return node.children.reduce<number>((n, raw) => {
    const child = PlanNodeShape.parse(raw);
    return n + (child.spec.rail === "address" ? 0 : 1) + plannedDraws(child);
  }, 0);
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
  return res.json();
}

async function treeEvents(treeId: string): Promise<z.infer<typeof TreeEventsShape>["events"]> {
  const out: z.infer<typeof TreeEventsShape>["events"] = [];
  let since: string | null = null;
  for (;;) {
    const page = TreeEventsShape.parse(await getJson(`${LOCAL_INDEXER}/v1/trees/${treeId}/events?limit=1000${since === null ? "" : `&since=${encodeURIComponent(since)}`}`));
    out.push(...page.events);
    if (page.next === null) return out;
    since = page.next;
  }
}
const GOAL = "Market-entry brief for cold-pressed juice in Dubai, with a competitor price table, an Arabic summary and a fact check.";

/**
 * The local Conductor's CORS list names http://localhost:3100 (scripts/local-stack.ts), so the
 * console's direct Conductor calls only pass from that origin. The page is the same dev server.
 */
function consoleOrigin(): string {
  return localWebUrl().replace("//127.0.0.1:", "//localhost:");
}

/**
 * On Yaci the local Conductor plans a 5-minute fund window and a root submit_by at most about 15
 * minutes after fund_by (LOCAL_POLICY), so the root result arrives within 18 minutes. The watchtower
 * closes the root at its on-chain challenge_until, half a minute after that planned submit_by, however
 * early the buyer accepted, so the close wait runs to that instant plus CLOSE_GRACE_MS (a fixed wait
 * from the accept click ended 80 s before challenge_until when the tree finished early). These waits
 * keep the test inside verify's 60-minute e2e stage, which also runs the public specs.
 */
const ROOT_RESULT_WAIT_MS = 18 * 60_000;
const CLOSE_GRACE_MS = 5 * 60_000;
const TreeShape = z.looseObject({ nodes: z.array(z.looseObject({ node_id: z.string(), challenge_until: z.number() })) });

test("buyer plans, funds with a test CIP-30 wallet and reaches the receipt", async ({ browser }) => {
  test.setTimeout(45 * 60_000);
  const origin = consoleOrigin();
  expect(await allowlistLocalAgents(LOCAL_INDEXER), "reference agents allowlisted in the local Directory").toBeGreaterThan(0);
  const lucid = await localRoleLucid(BUYER_ROLE);
  await freshLocalSeed(lucid, 400);

  const context = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 900 } });
  const signed = await installLocalWallet(context, lucid);
  const page = await context.newPage();

  // Describe the job.
  await page.goto("/console/new");
  await expect(page.getByTestId("network-badge").first(), "the local site names the local network").toHaveText("local");
  await page.getByLabel("Goal").fill(GOAL);
  await page.getByLabel("Budget").fill("150");
  // The slider is a whole percent and reaches the signer as a fraction (50 -> 0.5). Local sellers
  // start at the neutral 0.5 and drift with every local tree (Scout stood at 0.471 on 2026-10-06), so
  // any floor above 0 can refuse a planned hire at gate 3 and leave the tree empty. Gate 3 itself is
  // covered by packages/policy/test/gates.test.ts.
  await page.locator("#job-minReputation").fill("0");
  await page.locator("#job-asset").selectOption("lovelace");
  await page.getByText("I review the result").click();
  await page.getByRole("button", { name: "Get a plan" }).click();

  // Plan through the local Conductor, then review it.
  await page.waitForURL(/\/console\/plan\//, { timeout: 300_000 });
  await expect(page.getByTestId("plan-rows")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("plan-totals")).toBeVisible();
  const planId = /\/console\/plan\/([^/?#]+)/.exec(page.url())?.[1];
  if (planId === undefined) throw new Error(`no plan id in ${page.url()}`);
  const planned = plannedDraws(PlanEnvelopeShape.parse(await getJson(`${LOCAL_CONDUCTOR}/v1/plans/${planId}`)).plan.root);
  expect(planned, "the plan hires at least one agent").toBeGreaterThan(0);

  // Fund with the test wallet.
  await page.getByRole("button", { name: "Fund this plan" }).click();
  await page.getByRole("button", { name: "Connect a preprod wallet" }).click();
  await page.getByRole("button", { name: LOCAL_WALLET_NAME }).click();
  const fund = page.getByRole("button", { name: "Sign and fund" });
  await expect(fund).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("sign-flow").getByRole("alert"), "the console blocked signing").toHaveCount(0);
  await fund.click();
  await expect(page.getByText("Submitted to preprod")).toBeVisible({ timeout: 180_000 });
  expect(signed.filter((s) => s.submitted), "FundRoot was signed and submitted by the test wallet").toHaveLength(1);

  // Follow the tree.
  await page.getByRole("link", { name: "Watch the tree grow" }).click();
  await page.waitForURL(/\/console\/job\/[0-9a-f]{56}/, { timeout: 60_000 });
  const treeId = /\/console\/job\/([0-9a-f]{56})/.exec(page.url())?.[1];
  if (treeId === undefined) throw new Error(`no tree id in ${page.url()}`);
  await expect(page.getByTestId("tree-explorer")).toBeVisible({ timeout: 60_000 });

  // The root result arrives; the buyer accepts it with one signature.
  const accept = page.getByTestId("pending-actions").getByRole("button", { name: "Accept", exact: true });
  await expect(accept).toBeVisible({ timeout: ROOT_RESULT_WAIT_MS });
  await accept.click();
  await page.getByRole("button", { name: "Connect a preprod wallet" }).click();
  await page.getByRole("button", { name: LOCAL_WALLET_NAME }).click();
  const sign = page.getByRole("button", { name: "Sign and accept" });
  await expect(sign).toBeVisible({ timeout: 180_000 });
  await sign.click();
  await expect(page.getByText("Submitted to preprod")).toBeVisible({ timeout: 180_000 });
  expect(signed.filter((s) => s.submitted), "Accept was signed and submitted by the test wallet").toHaveLength(2);
  await page.keyboard.press("Escape");

  // CloseRoot follows; the receipt reconciles every payout and refund.
  const root = TreeShape.parse(await getJson(`${LOCAL_INDEXER}/v1/trees/${treeId}`)).nodes.find((n) => n.node_id === treeId);
  if (root === undefined) throw new Error(`root ${treeId} missing from the indexer`);
  const closeWaitMs = Math.max(0, root.challenge_until - Date.now()) + CLOSE_GRACE_MS;
  await expect(page.getByText("This job is closed. The receipt has every payout and refund.")).toBeVisible({ timeout: closeWaitMs });
  // The tree actually hired its planned agents: one Draw per planned child spec (a re-hire reuses
  // the spec, so distinct spec hashes count planned slots) and at least one child settled.
  const events = await treeEvents(treeId);
  const drawnSpecs = new Set(events.filter((e) => e.type === "node.drawn").map((e) => DrawnPayload.parse(e.payload).spec_hash));
  expect(drawnSpecs.size, "every planned child was drawn on chain").toBe(planned);
  expect(events.filter((e) => e.type === "node.settled").length, "at least one hired child settled").toBeGreaterThan(0);

  await page.goto(`/receipt/${treeId}`);
  await expect(page.getByTestId("receipt-nodes")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("reconciliation")).toBeVisible();
  await page.screenshot({ path: "../evidence/e2e/buyer-write-receipt-1280.png", fullPage: true });
  await context.close();
});
