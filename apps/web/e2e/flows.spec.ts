import { expect, test } from "@playwright/test";

const TREE = "ee8a129b76092ccc84719cbc4961baf0226b2808a1a3ff640cd9fb69";

test.describe("Tree Explorer", () => {
  test("every state badge links to a Cardanoscan preprod transaction", async ({ page }) => {
    await page.goto(`/tree/${TREE}`);
    await expect(page.getByTestId("tree-explorer")).toBeVisible();
    const badges = page.locator("a[aria-label$='open the transaction on Cardanoscan']");
    await expect(badges.first()).toBeVisible();
    const hrefs = await badges.evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
    expect(hrefs.length).toBeGreaterThanOrEqual(9);
    for (const href of hrefs) expect(href).toMatch(/^https:\/\/preprod\.cardanoscan\.io\/transaction\/[0-9a-f]{64}(\?tab=contracts)?$/);
  });

  test("opens a node drawer with hashes, datum and transactions", async ({ page }, info) => {
    await page.goto(`/tree/${TREE}`);
    const open = page.getByRole("button", { name: /^Scribe, Settled/ }).or(page.getByRole("button", { name: "Scribe", exact: true }));
    await open.first().click();
    const drawer = page.getByTestId("node-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("Datum, decoded")).toBeVisible();
    await expect(drawer.getByText("Checker A accepted")).toBeVisible();
    if (info.project.name === "desktop") await page.screenshot({ path: "e2e/screenshots/tree-drawer-1280.png" });
  });

  test("replays to the refund and shows value moving up", async ({ page }, info) => {
    await page.goto(`/tree/${TREE}`);
    await page.getByRole("button", { name: "Flaky Lisan missed its deadline and was refunded" }).click();
    await expect(page.getByTestId("timeline")).toContainText("Flaky Lisan missed its deadline and was refunded");
    await expect(page.getByTestId("root-held").locator(".sr-only")).toHaveText("68.00 tUSDM");
    if (info.project.name === "desktop") {
      await expect(page.getByTestId("edge-flow")).toHaveCount(1);
      await page.getByTestId("tree-explorer").evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 64));
      await page.waitForTimeout(700);
      await page.screenshot({ path: "e2e/screenshots/tree-refund-1280.png" });
    } else {
      await expect(page.locator('[data-testid="node-card"][data-layout="row"]').filter({ hasText: "Refund 15.00 tUSDM" })).toBeVisible();
    }
  });

  test("respects reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/tree/${TREE}`);
    await page.getByRole("button", { name: "Flaky Lisan missed its deadline and was refunded" }).click();
    await expect(page.getByTestId("root-held").locator(".sr-only")).toHaveText("68.00 tUSDM");
    await expect(page.getByTestId("edge-flow")).toHaveCount(0);
  });

  test("works in dark mode", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`/tree/${TREE}`);
    await expect(page.getByTestId("node-card").first()).toBeVisible();
    await page.waitForTimeout(800);
    await page.screenshot({ path: "e2e/screenshots/tree-dark-1280.png" });
  });
});

test("receipt reconciles to the base unit", async ({ page }) => {
  await page.goto(`/receipt/${TREE}`);
  const line = page.getByTestId("reconciliation");
  await expect(line).toContainText("Balanced to the last base unit");
  await expect(line).toContainText("150,000,000");
  await expect(line).toContainText("14,000,000 lovelace");
  const masumi = page.getByTestId("masumi-hire");
  await expect(masumi).toContainText("Paid to the seller");
  const links = await masumi.locator("a").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
  expect(links.length).toBe(3);
  for (const href of links) expect(href).toMatch(/^https:\/\/preprod\.cardanoscan\.io\/transaction\/[0-9a-f]{64}(\?tab=contracts)?$/);
});

test("node drawer shows the Masumi hire made through the purchase wallet", async ({ page }) => {
  await page.goto(`/tree/${TREE}`);
  await page.getByRole("button", { name: /^Conductor, \w+\. Open details$/ }).or(page.getByRole("button", { name: "Conductor", exact: true })).first().click();
  const drawer = page.getByTestId("node-drawer");
  await expect(drawer.getByText("Masumi hires")).toBeVisible();
  await expect(drawer.getByTestId("masumi-hire")).toContainText("Paid to the seller");
});

test("new job form validates, then asks for a plan", async ({ page }) => {
  await page.goto("/console/new");
  await page.getByRole("button", { name: "Get a plan" }).click();
  await expect(page.getByText("Describe the job in at least 10 characters.")).toBeVisible();
  await page.getByLabel("Goal").fill("Market entry brief for cold-pressed juice in Dubai with a price table.");
  await page.getByRole("button", { name: "Get a plan" }).click();
  await expect(page).toHaveURL(/\/console\/plan\/plan-demo-juice$/);
  await expect(page.getByTestId("plan-totals")).toContainText("150.00 tUSDM");
});

test("fund step shows the plain-language preview before any wallet prompt", async ({ page }, info) => {
  await page.goto("/console/plan/plan-demo-juice");
  await page.getByRole("button", { name: "Fund this plan" }).click();
  const dialog = page.getByTestId("sign-flow");
  await expect(dialog.getByTestId("plain-preview")).toHaveText("Lock 150.00 tUSDM and 14.00 ADA structural reserve in a Cascade root.");
  if (info.project.name === "desktop") await page.screenshot({ path: "e2e/screenshots/fund-preview-1280.png" });
  await dialog.getByRole("button", { name: "Connect a preprod wallet" }).click();
  await expect(dialog.getByText("No Cardano wallet found in this browser.")).toBeVisible();
});

test("arbiter split builder produces exact values", async ({ page }) => {
  await page.goto("/arbiter");
  await expect(page.getByTestId("split-result")).toContainText("14.00 tUSDM");
  await expect(page.getByTestId("split-result")).toContainText("16000000 base units");
});

const BUYER_HEX = "00301fe8305d64a75df26cc9dadf7747ee27da4f1a7a50e35d8157e31defa93d21f81f9caae998dfcbe4ea7cb2871fc26291cd7ce8a0987b5b";

/** A minimal preprod CIP-30 wallet; signing rejects, since the sample transaction is not real. */
async function injectWallet(page: import("@playwright/test").Page, previewMode: "match" | "mismatch"): Promise<void> {
  await page.addInitScript(
    ({ hex, mode }) => {
      window.localStorage.setItem("cascade-sample-preview", mode);
      const api = {
        getNetworkId: async () => 0,
        getChangeAddress: async () => hex,
        getUsedAddresses: async () => [hex],
        getUnusedAddresses: async () => [],
        getRewardAddresses: async () => [],
        getUtxos: async () => [],
        getBalance: async () => "00",
        getExtensions: async () => [],
        signTx: async () => {
          throw new Error("User declined to sign.");
        },
        signData: async () => {
          throw new Error("User declined to sign.");
        },
        submitTx: async () => {
          throw new Error("not submitted");
        },
      };
      (window as unknown as { cardano: Record<string, unknown> }).cardano = {
        testwallet: { name: "Test wallet", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", apiVersion: "1.0.0", enable: async () => api, isEnabled: async () => true },
      };
    },
    { hex: BUYER_HEX, mode: previewMode },
  );
}

for (const width of [1600, 1280, 390]) {
  test(`fund dialog keeps headline, moves, alert and action visible at ${width} px`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop");
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const mode of ["match", "mismatch"] as const) {
      await injectWallet(page, mode);
      await page.goto("/console/plan/plan-demo-juice");
      await page.getByRole("button", { name: "Fund this plan" }).click();
      const dialog = page.getByTestId("sign-flow");
      await dialog.getByRole("button", { name: "Connect a preprod wallet" }).click();
      await dialog.getByRole("button", { name: "Test wallet" }).click();
      const action = dialog.getByRole("button", { name: "Sign and fund" });
      await expect(action).toBeVisible();
      await expect(dialog.getByTestId("tx-moves")).toContainText("Cascade root");
      await expect(dialog.getByTestId("tx-moves")).toContainText("Tree config");
      await expect(dialog.getByTestId("tx-moves")).toContainText("Your wallet");
      if (mode === "match") await expect(action).toBeEnabled();
      else {
        await expect(dialog.getByRole("alert")).toContainText("Signing is blocked");
        await expect(action).toBeDisabled();
      }
      for (const id of ["plain-preview", "tx-moves", "sign-footer"]) await expect(dialog.getByTestId(id)).toBeInViewport();
      const box = await dialog.boundingBox();
      const viewport = page.viewportSize();
      expect(box !== null && viewport !== null && box.x >= 0 && box.x + box.width <= viewport.width && box.y >= 0 && box.y + box.height <= viewport.height).toBe(true);
      const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `e2e/screenshots/fund-confirm-${mode}-${width}.png` });
    }
  });
}

test("landing replays a real tree and shows live totals", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("live-tree")).toBeVisible();
  await expect(page.getByTestId("live-stats")).toContainText("Trees funded");
  await expect(page.getByRole("link", { name: "Open this tree" })).toHaveAttribute("href", /\/tree\/[0-9a-f]{56}$/);
});

test.describe("stage view", () => {
  test("pins big figures, a caption and the metered counter", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop");
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/tree/${TREE}?stage=1&replay=0`);
    await expect(page.getByTestId("stage-header")).toBeVisible();
    await expect(page.getByTestId("stage-root-held").locator(".sr-only")).toHaveText("0.00 tUSDM");
    await expect(page.getByTestId("stage-metered")).toContainText("214");
    await expect(page.getByTestId("stage-metered")).toContainText("2L1 transactions");
    await expect(page.getByTestId("stage-caption")).toContainText("Root closed and settled");
    await page.screenshot({ path: "e2e/screenshots/stage-1920.png" });
  });

  test("refund moment: the failed node flashes, the parent's balance grows back, the replacement says what it replaces", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop");
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/tree/${TREE}?stage=1&replay=0`);
    const timeline = page.getByTestId("timeline");
    const slider = timeline.getByRole("slider");
    // Event 12 is Flaky Lisan's refund in the sample tree.
    await slider.fill("12");
    await expect(page.getByTestId("stage-caption")).toHaveText("Flaky Lisan missed its deadline and was refunded");
    await expect(page.locator(".node-refund-flash")).toHaveCount(1);
    await expect(page.getByTestId("stage-root-held").locator(".sr-only")).toHaveText("68.00 tUSDM");
    await page.waitForTimeout(450);
    await page.screenshot({ path: "e2e/screenshots/stage-refund-1920.png" });
    await slider.fill("13");
    await expect(page.getByText("Replaces Flaky Lisan")).toBeVisible();
  });
});

test("hovering a node keeps its ancestors and subtree lit and dims the rest", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await page.goto(`/tree/${TREE}`);
  const scout = page.getByTestId("node-card").filter({ hasText: "Scout" });
  await expect(scout).toBeVisible();
  await scout.hover();
  await expect(page.locator('[data-testid="node-card"][data-dimmed="true"]')).toHaveCount(5);
  await expect(page.getByTestId("node-card").filter({ hasText: "Pricer" })).not.toHaveAttribute("data-dimmed", "true");
  await expect(page.getByTestId("node-card").filter({ hasText: "Conductor" })).not.toHaveAttribute("data-dimmed", "true");
});

test("receipt reads as an invoice and prints without site chrome", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await page.goto(`/receipt/${TREE}`);
  const invoice = page.getByTestId("invoice");
  await expect(invoice).toContainText("Reconciled");
  await expect(invoice).toContainText("Deposited");
  await expect(invoice.getByTestId("receipt-nodes").locator("tbody tr")).toHaveCount(9);
  await expect(page.getByRole("button", { name: "Save as PDF" })).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("header.sticky")).toBeHidden();
  await expect(page.getByRole("button", { name: "Save as PDF" })).toBeHidden();
  await expect(invoice).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/receipt-print-1280.png", fullPage: true });
});

test("verify: the drawer recomputes the spec hash and the receipt checks itself", async ({ page }) => {
  await page.goto(`/tree/${TREE}`);
  await page.getByRole("button", { name: /^Scribe, \w+\. Open details$/ }).or(page.getByRole("button", { name: "Scribe", exact: true })).first().click();
  const verify = page.getByTestId("verify-node");
  await expect(verify.getByTestId("check-badge").first()).toHaveAttribute("data-status", "match");
  await page.getByLabel("Paste the result JSON the agent returned").fill('{"not":"the result"}');
  await page.getByRole("button", { name: "Hash and compare" }).click();
  await expect(verify.locator('[data-status="mismatch"]')).toHaveCount(1);

  await page.goto(`/receipt/${TREE}`);
  const panel = page.getByTestId("verify-receipt");
  await expect(panel).toContainText("9 of 9 node specs hash to the spec hash in their datum");
  await expect(panel.locator('[data-status="mismatch"]')).toHaveCount(0);
});

const SCRIBE_AGENT = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b";

test("agent profile shows reputation, signals and record, reachable from the drawer", async ({ page }) => {
  await page.goto(`/tree/${TREE}`);
  await page.getByRole("button", { name: /^Scribe, \w+\. Open details$/ }).or(page.getByRole("button", { name: "Scribe", exact: true })).first().click();
  await page.getByRole("link", { name: "Scribe, reputation and record" }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${SCRIBE_AGENT}[0-9a-f]+$`));
  await expect(page.getByRole("heading", { level: 1, name: "Scribe" })).toBeVisible();
  await expect(page.getByTestId("agent-score")).toHaveText("86");
  await expect(page.getByTestId("agent-record")).toContainText("Acceptance rate");
  await expect(page.getByText("Passed verification")).toBeVisible();
});

test("tree and receipt links carry their own titles and social images", async ({ page, request }) => {
  await page.goto(`/tree/${TREE}`);
  await expect(page).toHaveTitle(`Tree ${TREE.slice(0, 8)} | Cascade`);
  const og = await page.locator('meta[property="og:image"]').getAttribute("content");
  expect(og).toMatch(/\/tree\/[0-9a-f]{56}\/opengraph-image/);
  const image = await request.get(new URL(og ?? "", page.url()).pathname);
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toBe("image/png");
  const receipt = await request.get(`/receipt/${TREE}/opengraph-image`);
  expect(receipt.status()).toBe(200);
});

test("waterfall shows each node's duration in tree order", async ({ page }) => {
  await page.goto(`/tree/${TREE}`);
  await page.getByRole("button", { name: "Waterfall" }).click();
  const waterfall = page.getByTestId("waterfall");
  await expect(waterfall.getByRole("button")).toHaveCount(9);
  await expect(waterfall.getByRole("button", { name: /^Flaky Lisan: .*, refunded\. Open details$/ })).toBeVisible();
});

test("redeemer chips and timeline markers link the story to the chain", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await page.goto(`/tree/${TREE}`);
  await expect(page.getByTestId("timeline-markers")).toContainText("Refund");
  await expect(page.getByTestId("timeline-markers")).toContainText("Close");
  await page.getByRole("button", { name: /^Scout, \w+\. Open details$/ }).click();
  const chip = page.getByTestId("redeemer-chip").first();
  await expect(chip).toHaveAttribute("href", /\?tab=contracts$/);
  await page.keyboard.press("Escape");
  await page.getByTestId("timeline").getByRole("slider").focus();
  await page.keyboard.press("Tab");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("j");
  await expect(page.getByTestId("timeline")).toContainText("Event 38 of 39");
});

test("command palette jumps to a tree by pasted id", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await page.goto("/");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox").fill(TREE);
  await expect(palette.getByRole("option").first()).toContainText("Tree ee8a129b");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/tree/${TREE}$`));
});
