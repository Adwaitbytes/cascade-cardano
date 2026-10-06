/**
 * The funding watcher polls every drafted plan the console asked a fund tx for. A failing indexer
 * read for one plan ("indexer tree answered 500" on preprod) aborted the whole tick, so no other
 * funded tree started until that plan's read succeeded.
 */
import { describe, expect, it } from "vitest";
import type { Client } from "@temporalio/client";
import { InMemoryPlanStore, orchestratorApi } from "../src/api/index.js";
import { IndexerClient } from "../src/chain/indexer.js";
import { LlmClient } from "../src/llm.js";
import { watchFunding } from "../src/run-tree.js";

const NOW = Date.now();
const AGENT = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b01";
const BROKEN = "bb".repeat(28);
const FUNDED = "cc".repeat(28);

describe("funding watcher", () => {
  it("starts a funded tree even when another plan's indexer read fails", async () => {
    const store = new InMemoryPlanStore();
    const app = orchestratorApi({
      llm: new LlmClient({}),
      agents: () => ({ primary: { agent_id: AGENT, quote_id: null, price: "0" }, fallbacks: [] }),
      verifierKeyOf: (t) => t.id.slice(-1).charCodeAt(0).toString(16).padStart(2, "0").repeat(28),
      masumiPurchaserHash: "9f".repeat(28),
      names: { lookup: async () => ({}) },
      allowedOrigins: [],
      store,
    });
    const draft = async (): Promise<string> => {
      const res = await app.fetch(
        new Request("https://orch.test/v1/jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: "Market entry brief for cold-pressed juice in Dubai.", asset: "lovelace", budget: "150000000", deadline: NOW + 6 * 3_600_000, max_depth: 3, min_reputation: 0, risk: "balanced", acceptance: "buyer_review", allow_agents: [], block_agents: [] }),
        }),
      );
      const body = (await res.json()) as { plan_id?: string };
      if (body.plan_id === undefined) throw new Error(`draft failed: ${JSON.stringify(body)}`);
      return body.plan_id;
    };
    await store.assignTree(await draft(), BROKEN);
    await store.assignTree(await draft(), FUNDED);

    const indexer = new IndexerClient({
      baseUrl: "https://indexer.test",
      adminToken: null,
      fetch: async (url) => (String(url).endsWith(BROKEN) ? new Response("{}", { status: 500 }) : new Response("{}", { status: 200 })),
    });
    const started: string[] = [];
    const client = { workflow: { start: async (_type: string, o: { workflowId: string }) => void started.push(o.workflowId) } } as unknown as Client;
    const errors: unknown[] = [];
    const stop = watchFunding({ store, indexer, client, plansApi: "https://orch.test", intervalMs: 10, onError: (e) => errors.push(e) });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    expect(started).toContain(`tree-${FUNDED}`);
    expect(String(errors[0])).toContain("indexer tree answered 500");
  });
});
