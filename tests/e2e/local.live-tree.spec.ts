/**
 * Live Tree Explorer against the local stack (PRD 14.3, evaluator #5): a real tree on Yaci, driven
 * through the SDK while the page stays open. The explorer must update from indexer WebSocket
 * events, without a reload, as nodes are drawn, submitted and the root is frozen.
 */
import { expect, test, type WebSocket } from "@playwright/test";
import { h32, TreeLab, ADA } from "../lib/tree-fixture.js";

test("explorer follows a live Yaci tree over WebSocket without reloading", async ({ page }) => {
  const lab = await TreeLab.create();
  const plan = lab.plan(`e2e-live-${Date.now()}`, 100n * ADA, [
    { tag: "A", parent: 0, maxBudget: 10n * ADA, maxFee: 2n * ADA },
    { tag: "B", parent: 0, maxBudget: 10n * ADA, maxFee: 2n * ADA },
  ]);
  const { treeId } = await lab.fund(plan, 40n * ADA, 5n * ADA, 900_000n, 20n * ADA);

  const sockets: WebSocket[] = [];
  let framesReceived = 0;
  page.on("websocket", (ws) => {
    sockets.push(ws);
    ws.on("framereceived", () => (framesReceived += 1));
  });

  await page.goto(`/tree/${treeId}`);
  const explorer = page.getByTestId("tree-explorer");
  await expect(explorer).toBeVisible();
  await expect(explorer.getByText("Live", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("node-card")).toHaveCount(1);
  const framesBefore = framesReceived;
  // A marker on the page global survives client-side routing but not a reload.
  await page.evaluate(() => Object.assign(globalThis, { __cascadeNoReload: true }));

  const { operator, workerA, workerB } = lab.parties;
  const submitBy = (await lab.client.node(treeId)).datum.submit_by;
  const accept = { type: "ParentAccept" as const, key: operator.vkh };
  const drawn = await lab.client.draw(treeId, [
    lab.nativeChild(plan, 1, workerA, 10n * ADA, 2n * ADA, submitBy, accept, 300_000n),
    lab.nativeChild(plan, 2, workerB, 10n * ADA, 2n * ADA, submitBy, accept, 300_000n),
  ]);
  await lab.submit(drawn);
  await expect(page.getByTestId("node-card")).toHaveCount(3);
  await expect(page.locator("[data-testid=node-card][data-state=Funded]")).toHaveCount(3);

  await lab.submit(await lab.client.submit(drawn.childIds[0]!, h32("e2e-result")));
  await expect(page.locator("[data-testid=node-card][data-state=Submitted]")).toHaveCount(1);

  await lab.submit(await lab.client.freeze(treeId));
  await expect(explorer.getByText("Frozen", { exact: true })).toBeVisible();

  expect(await page.evaluate(() => (globalThis as { __cascadeNoReload?: boolean }).__cascadeNoReload === true), "the page was never reloaded").toBe(true);
  expect(sockets.length, "the explorer opened a WebSocket").toBeGreaterThan(0);
  expect(framesReceived - framesBefore, "chain events arrived over the WebSocket").toBeGreaterThan(0);
  await page.screenshot({ path: "../evidence/e2e/live-tree-1280.png" });
});
