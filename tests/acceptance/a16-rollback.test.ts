import { describe, it } from "vitest";
import { chromium } from "@playwright/test";
import { runAcceptance } from "../lib/acceptance.js";
import { ACCEPTANCE } from "../lib/catalog.js";
import { localDeployment, sleep } from "../lib/devnet.js";
import { withHeavyLock } from "../lib/heavy-lock.js";
import { optionalEnv } from "../lib/repo.js";
import { ADA, TreeLab } from "../lib/tree-fixture.js";
import { healYaciStore } from "@cascade/service-kit/testing";
import { awaitVerifyStages } from "../lib/verify-signals.js";
import { A16_WAITS_FOR } from "../lib/verify-plan.js";
import { httpFetch } from "../lib/http.js";
import { localWebUrl } from "../lib/local-web.js";

const INDEXER = optionalEnv("CASCADE_LOCAL_INDEXER_URL") ?? "http://127.0.0.1:36100";
const WEB = localWebUrl();

async function json<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T | null }> {
  const res = await httpFetch("A16: read", url, init, { idempotent: true, timeoutMs: 30_000 });
  return { status: res.status, body: res.ok ? ((await res.json().catch(() => null)) as T | null) : null };
}

/** The node's own block height from Ogmios (the Yaci store lags far behind the node after a rollback). */
async function nodeHeight(): Promise<number | null> {
  try {
    const res = await fetch(localDeployment().endpoints.ogmiosHttp, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "queryNetwork/blockHeight", id: null }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json()) as { result?: unknown };
    return typeof body.result === "number" ? body.result : null;
  } catch {
    // The node is restarting from the snapshot.
    return null;
  }
}

describe(`A16 ${ACCEPTANCE.A16.title}`, () => {
  it("reflects a forced Yaci rollback in indexer and UI within one block, with no phantom states", async () => {
    await runAcceptance("A16", async (run) => {
      const admin = (localDeployment().endpoints as { adminApi?: string }).adminApi ?? "http://localhost:20000";
      // Under verify:all the local devnet stages (aiken to e2e) run beside acceptance. The rollback
      // restarts cardano-node, which would wedge Yaci Store under any of them, so it waits for all.
      await awaitVerifyStages(A16_WAITS_FOR);
      // The rollback rewinds the shared devnet: hold the cross-agent heavy lock for the whole window.
      await withHeavyLock(async () => {
        try {
          const lab = await TreeLab.create();
          const plan = lab.plan(`a16-${Date.now()}`, 100n * ADA, [
            { tag: "A", parent: 0, maxBudget: 10n * ADA, maxFee: 2n * ADA },
            { tag: "B", parent: 0, maxBudget: 10n * ADA, maxFee: 2n * ADA },
          ]);
          const { treeId } = await lab.fund(plan, 40n * ADA, 5n * ADA, 900_000n, 20n * ADA);
          await sleep(3000);

          const snap = await httpFetch("A16: take the Yaci DB snapshot", `${admin}/local-cluster/api/devnet/rollback/take-db-snapshot`, { method: "POST" }, { idempotent: false });
          run.check("Yaci took a DB snapshot", true, snap.ok);

          const browser = await chromium.launch();
          try {
            const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
            await page.goto(`${WEB}/tree/${treeId}`);
            await page.evaluate(() => Object.assign(globalThis, { __a16NoReload: true }));
            // A page served for another network (or blocked by indexer CORS) never shows this Yaci tree.
            const rootShown = await page.locator("[data-testid=node-card]").first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
            run.check(`explorer at ${WEB} shows the funded Yaci tree before the draw`, true, rootShown);

            const { operator, workerA, workerB } = lab.parties;
            const submitBy = (await lab.client.node(treeId)).datum.submit_by;
            const accept = { type: "ParentAccept" as const, key: operator.vkh };
            const drawn = await lab.client.draw(treeId, [
              lab.nativeChild(plan, 1, workerA, 10n * ADA, 2n * ADA, submitBy, accept, 300_000n),
              lab.nativeChild(plan, 2, workerB, 10n * ADA, 2n * ADA, submitBy, accept, 300_000n),
            ]);
            const drawTx = await lab.submit(drawn);
            await page.locator("[data-testid=node-card]").nth(2).waitFor({ timeout: 30_000 });
            run.check("before the rollback: UI shows root and two children", 3, await page.locator("[data-testid=node-card]").count());
            const before = await json<{ nodes: unknown[] }>(`${INDEXER}/v1/trees/${treeId}`);
            run.check("before the rollback: indexer has 3 nodes", 3, before.body?.nodes.length);
            run.note(`Draw ${drawTx} creates ${drawn.childIds.join(", ")}`);

            // Force the rollback: the node restarts from the snapshot and the Draw disappears. The admin call
            // blocks across the restart, so heights are sampled concurrently, every 200 ms, from Ogmios
            // (the node itself; the Yaci store lags far behind after a rollback).
            const heightBefore = await nodeHeight();
            if (heightBefore === null) throw new Error("Ogmios gave no block height before the rollback");
            const samples: string[] = [];
            const indexerView: string[] = [];
            let resumed: number | null = null;
            let consistentAt: number | null = null;
            let sawDown = false;
            const watch = (async () => {
              const until = Date.now() + 300_000;
              while (consistentAt === null && Date.now() < until) {
                const h = await nodeHeight();
                if (samples.at(-1) !== String(h) && samples.length < 60) samples.push(String(h));
                if (h === null) sawDown = true;
                if (resumed === null && h !== null && (sawDown || h < heightBefore)) resumed = h;
                if (resumed !== null) {
                  const r = await fetch(`${INDEXER}/v1/trees/${treeId}`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
                  const t = r !== null && r.ok ? ((await r.json()) as { nodes: { node_id: string; state: string }[] }) : null;
                  const view = r === null ? "unreachable" : t === null ? `HTTP ${r.status}` : `${t.nodes.length} nodes`;
                  if (indexerView.at(-1) !== view && indexerView.length < 30) indexerView.push(`${view}@${h}`);
                  if (t !== null && t.nodes.length === 1) consistentAt = (await nodeHeight()) ?? h;
                }
                if (consistentAt === null) await sleep(200);
              }
            })();
            const rbStart = Date.now();
            const rb = await httpFetch("A16: roll back to the snapshot", `${admin}/local-cluster/api/devnet/rollback/rollback-to-db-snapshot`, { method: "POST" }, { idempotent: false, timeoutMs: 300_000 });
            run.check("Yaci rolled back to the snapshot", true, rb.ok);
            run.note(`rollback call took ${Date.now() - rbStart} ms; node height before ${heightBefore}`);
            await watch;
            run.note(`tree ${treeId}; node heights during the rollback: ${samples.join(" ")}`);
            run.note(`indexer view by node height: ${indexerView.join(", ")}`);
            run.note(`node resumed at block ${resumed}; indexer showed only the root at node block ${consistentAt}`);
            run.check("indexer reflects the rollback", true, consistentAt !== null);
            run.check("indexer reflects it within one node block of the node resuming", true, resumed !== null && consistentAt !== null && consistentAt - resumed <= 1);
            for (const childId of drawn.childIds) {
              run.check(`no phantom node ${childId.slice(0, 8)} in the indexer`, 404, (await json(`${INDEXER}/v1/trees/${treeId}/nodes/${childId}`)).status);
            }
            const tree = await json<{ nodes: { node_id: string; state: string; children_open?: string }[] }>(`${INDEXER}/v1/trees/${treeId}`);
            const root = tree.body?.nodes.find((n) => n.node_id === treeId);
            run.check("root is back to Funded with no open children", { state: "Funded", children_open: "0" }, { state: root?.state, children_open: String(root?.children_open ?? "") });
            const events = await json<{ events: { type: string }[] }>(`${INDEXER}/v1/trees/${treeId}/events`);
            run.check("indexer emitted chain.rollback", true, events.body?.events.some((e) => e.type === "chain.rollback") === true);

            // The open explorer follows without a reload.
            await page.locator("[data-testid=node-card]").nth(1).waitFor({ state: "detached", timeout: 15_000 });
            run.check("UI shows only the root after the rollback", 1, await page.locator("[data-testid=node-card]").count());
            run.check("UI was not reloaded", true, await page.evaluate(() => (globalThis as { __a16NoReload?: boolean }).__a16NoReload === true));
            await page.screenshot({ path: "../evidence/A16/explorer-after-rollback.png" });
            run.artefact("evidence/A16/explorer-after-rollback.png");
          } finally {
            await browser.close();
          }
        } finally {
          // The node restart drops Yaci Store's connection and it may never follow again. Leave the
          // shared devnet healthy for whoever takes the lock next.
          const { endpoints } = localDeployment();
          const healed = await healYaciStore(endpoints.ogmiosHttp, endpoints.blockfrostCompatible, { log: (m) => run.note(m) });
          run.note(`Yaci Store after the rollback: ${healed}`);
        }
      });
    });
  });
});
