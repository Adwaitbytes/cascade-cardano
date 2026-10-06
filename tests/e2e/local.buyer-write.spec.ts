/**
 * Buyer write flow on the local stack (PRD 14.1, 14.2, 14.4): describe a job, plan it through the
 * local Conductor, review, fund with a CIP-30 test wallet, accept the root result and read the
 * receipt. The wallet is a real devnet key (qa-buyer in deployments/wallets.local.json) that signs
 * and submits on Yaci; nothing on the chain path is mocked.
 */
import { expect, test } from "@playwright/test";
import { localWebUrl } from "../lib/local-web.js";
import { allowlistLocalAgents } from "./local-directory.js";
import { freshLocalSeed, installLocalWallet, LOCAL_WALLET_NAME, localRoleLucid } from "./local-wallet.js";

const BUYER_ROLE = "qa-buyer";
/** The local indexer (scripts/local-stack.ts services block). */
const LOCAL_INDEXER = process.env.E2E_LOCAL_INDEXER_URL ?? "http://127.0.0.1:36100";
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
 * closes the root at its challenge_until, half a minute after that planned submit_by, however early
 * the buyer accepted, so the close wait covers the whole root window. These waits keep the test
 * inside verify's 60-minute e2e stage, which also runs the public specs.
 */
const ROOT_RESULT_WAIT_MS = 18 * 60_000;
const CLOSE_WAIT_MS = 15 * 60_000;

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
  // A recreated devnet has no reputation history, so every seller starts at the neutral 0.5; the
  // console's default floor of 60 would make the signer refuse every hire (gate 3).
  await page.locator("#job-minReputation").fill("50");
  await page.locator("#job-asset").selectOption("lovelace");
  await page.getByText("I review the result").click();
  await page.getByRole("button", { name: "Get a plan" }).click();

  // Plan through the local Conductor, then review it.
  await page.waitForURL(/\/console\/plan\//, { timeout: 300_000 });
  await expect(page.getByTestId("plan-rows")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("plan-totals")).toBeVisible();

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
  await expect(page.getByText("This job is closed. The receipt has every payout and refund.")).toBeVisible({ timeout: CLOSE_WAIT_MS });
  await page.goto(`/receipt/${treeId}`);
  await expect(page.getByTestId("receipt-nodes")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("reconciliation")).toBeVisible();
  await page.screenshot({ path: "../evidence/e2e/buyer-write-receipt-1280.png", fullPage: true });
  await context.close();
});
