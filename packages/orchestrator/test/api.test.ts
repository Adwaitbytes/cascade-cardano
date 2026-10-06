/**
 * Orchestrator API against the web console's own response schemas (apps/web/src/lib/api/schemas.ts).
 */
import { describe, expect, it } from "vitest";
import * as web from "../../../apps/web/src/lib/api/schemas.js";
import { validatePlanFull } from "../src/validate.js";
import { orchestratorApi, markPlanFunded, InMemoryPlanStore, type BuyerTxBuilder } from "../src/api/index.js";
import { LlmClient } from "../src/llm.js";

const NOW = 1_790_000_000_000;
const HOUR = 3_600_000;
const agentId = (n: number) => `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b${n.toString(16).padStart(2, "0")}`;
const job = (over: Record<string, unknown> = {}) => ({
  goal: "Market entry brief for selling cold-pressed juice in Dubai, with competitor pricing table, Arabic translation of the summary, and a sourced fact check.",
  asset: "lovelace",
  budget: "150000000",
  deadline: NOW + 6 * HOUR,
  max_depth: 3,
  min_reputation: 60,
  risk: "balanced",
  acceptance: "buyer_review",
  allow_agents: [],
  block_agents: [],
  ...over,
});

function make(txBuilder?: BuyerTxBuilder, now = () => NOW, scenarioKeys?: { lookupApi: string }) {
  const store = new InMemoryPlanStore();
  const app = orchestratorApi({
    llm: new LlmClient({}),
    agents: () => ({ primary: { agent_id: agentId(1), quote_id: null, price: "0" }, fallbacks: [{ agent_id: agentId(2), quote_id: null, price: "0" }] }),
    verifierKeyOf: (t) => t.id.slice(-1).charCodeAt(0).toString(16).padStart(2, "0").repeat(28),
    masumiPurchaserHash: "9f".repeat(28),
    names: { lookup: async (ids) => Object.fromEntries(ids.map((id) => [id, { name: `Agent ${id.slice(-2)}`, reputation: 0.5 }])) },
    allowedOrigins: ["https://console.test"],
    store,
    now,
    ...(txBuilder === undefined ? {} : { txBuilder }),
    ...(scenarioKeys === undefined ? {} : { scenarioKeys }),
  });
  const call = (method: "GET" | "POST", path: string, body?: unknown) =>
    app.fetch(new Request(`https://orch.test${path}`, { method, headers: { "content-type": "application/json", origin: "https://console.test" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { app, call, store };
}

const builder: BuyerTxBuilder = {
  fundRoot: async () => ({ tx_cbor: "84a400", tree_id: "aa".repeat(28) }),
  treeAction: async (_t, action) => ({ tx_cbor: action === "Accept" ? "84a401" : "84a402" }),
  resolve: async (_t, _n, split) => ({ tx_cbor: split.worker > 0n ? "84a403" : "84a404" }),
};

describe("orchestrator API (web contract)", () => {
  it("answers the console's CORS preflight, including the ngrok-skip-browser-warning header, without credentials", async () => {
    const { app } = make(builder);
    const res = await app.fetch(
      new Request("https://orch.test/v1/jobs", {
        method: "OPTIONS",
        headers: { origin: "https://console.test", "access-control-request-method": "POST", "access-control-request-headers": "content-type,ngrok-skip-browser-warning" },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://console.test");
    expect(res.headers.get("access-control-allow-headers")?.split(",").map((h) => h.trim().toLowerCase())).toContain("ngrok-skip-browser-warning");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    const other = await app.fetch(new Request("https://orch.test/v1/jobs", { method: "OPTIONS", headers: { origin: "https://evil.test", "access-control-request-method": "POST" } }));
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("POST /v1/jobs drafts a valid plan and GET /v1/plans/:id returns the web PlanEnvelope", async () => {
    const { call } = make(builder);
    const created = await call("POST", "/v1/jobs", web.CreateJobRequestSchema.parse(job()));
    expect(created.status).toBe(200);
    const { plan_id } = web.CreateJobResponseSchema.parse(await created.json());
    const res = await call("GET", `/v1/plans/${plan_id}`);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://console.test");
    const envelope = web.PlanEnvelopeSchema.parse(await res.json());
    expect(envelope.status).toBe("draft");
    expect(envelope.tree_id).toBeNull();
    expect(validatePlanFull(envelope.plan)).toEqual([]);
    expect(Object.keys(envelope.agents).sort()).toEqual([agentId(1), agentId(2)]);
  });

  // A3 and A8 on preprod (fe84dd5): "plan is labelled as the A3/A8 test scenario" failed because the
  // scenario draft's "TEST SCENARIO ..." summary never reached the plan the buyer funds.
  it.each([
    ["a3-masumi-leaf", "TEST SCENARIO A3:"],
    ["a8-schema-fail", "TEST SCENARIO A8:"],
  ])("a %s plan says it is a labelled test scenario in its root task", async (scenario, label) => {
    const { call } = make(builder, () => NOW, { lookupApi: "ab".repeat(28) });
    const created = await call("POST", "/v1/jobs", job({ test_scenario: scenario }));
    expect(created.status).toBe(200);
    const { plan_id } = (await created.json()) as { plan_id: string };
    const envelope = web.PlanEnvelopeSchema.parse(await (await call("GET", `/v1/plans/${plan_id}`)).json());
    expect(envelope.plan.root.spec.task.startsWith(label)).toBe(true);
    expect(envelope.plan.root.spec.task).toContain(`Goal: ${job().goal}`);
    expect(envelope.goal).toBe(job().goal);
    expect(validatePlanFull(envelope.plan)).toEqual([]);
  });

  it("native_only plans no Masumi slot, so a short window is not paced by Masumi's 35-minute minimum", async () => {
    const masumiSlots = async (over: Record<string, unknown>) => {
      const { call } = make(builder);
      const { plan_id } = (await (await call("POST", "/v1/jobs", job(over))).json()) as { plan_id: string };
      const envelope = web.PlanEnvelopeSchema.parse(await (await call("GET", `/v1/plans/${plan_id}`)).json());
      const found: string[] = [];
      const walk = (n: typeof envelope.plan.root): void => {
        if ((n.spec as { masumi_followup?: unknown }).masumi_followup !== undefined) found.push(n.spec.id);
        n.children.forEach(walk);
      };
      walk(envelope.plan.root);
      return found;
    };
    expect(await masumiSlots({})).not.toEqual([]);
    expect(await masumiSlots({ native_only: true })).toEqual([]);
  });

  it("a plan drafted without a test scenario carries no scenario label", async () => {
    const { call } = make(builder, () => NOW, { lookupApi: "ab".repeat(28) });
    const { plan_id } = (await (await call("POST", "/v1/jobs", job())).json()) as { plan_id: string };
    expect(JSON.stringify(await (await call("GET", `/v1/plans/${plan_id}`)).json())).not.toContain("TEST SCENARIO");
  });

  it("fund-tx, tree actions and resolve-tx return unsigned txs in the web shapes", async () => {
    const { call, store } = make(builder);
    const { plan_id } = (await (await call("POST", "/v1/jobs", job())).json()) as { plan_id: string };
    const wallet = { change_address: "addr_test1qqx", utxos: ["82825820"] };
    const fund = web.FundTxResponseSchema.parse(await (await call("POST", `/v1/plans/${plan_id}/fund-tx`, web.FundTxRequestSchema.parse(wallet))).json());
    expect(fund).toEqual({ tx_cbor: "84a400", tree_id: "aa".repeat(28) });
    const action = web.TreeActionRequestSchema.parse({ ...wallet, action: "Accept", node_id: "bb".repeat(28) });
    expect(web.UnsignedTxSchema.parse(await (await call("POST", `/v1/trees/${"aa".repeat(28)}/actions`, action)).json())).toEqual({ tx_cbor: "84a401" });
    const resolve = await call("POST", `/v1/disputes/${"aa".repeat(28)}/${"bb".repeat(28)}/resolve-tx`, { ...wallet, worker: "5", parent: "0" });
    expect(web.UnsignedTxSchema.parse(await resolve.json())).toEqual({ tx_cbor: "84a403" });
    await markPlanFunded(store, plan_id, fund.tree_id);
    expect(web.PlanEnvelopeSchema.parse(await (await call("GET", `/v1/plans/${plan_id}`)).json()).status).toBe("funded");
    expect((await call("POST", `/v1/plans/${plan_id}/fund-tx`, wallet)).status).toBe(409);
  });

  it("fund-tx hands an abandoned plan's tree id to the buyer's new plan, and answers 409 once that tree is funded", async () => {
    const { call, store } = make(builder);
    const wallet = { change_address: "addr_test1qqx", utxos: ["82825820"] };
    const abandoned = ((await (await call("POST", "/v1/jobs", job())).json()) as { plan_id: string }).plan_id;
    expect((await call("POST", `/v1/plans/${abandoned}/fund-tx`, wallet)).status).toBe(200);
    const rebuilt = ((await (await call("POST", "/v1/jobs", job({ budget: "140000000" }))).json()) as { plan_id: string }).plan_id;
    expect(rebuilt).not.toBe(abandoned);
    expect((await call("POST", `/v1/plans/${rebuilt}/fund-tx`, wallet)).status).toBe(200);
    expect((await store.byTree("aa".repeat(28)))?.built.plan.plan_id).toBe(rebuilt);
    expect(await store.awaitingFunding()).toEqual([rebuilt]);
    await markPlanFunded(store, rebuilt, "aa".repeat(28));
    const res = await call("POST", `/v1/plans/${abandoned}/fund-tx`, wallet);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("tree_already_funded");
  });

  it("answers 503 with the reason while the SDK tx builder is not wired", async () => {
    const { call } = make();
    const { plan_id } = (await (await call("POST", "/v1/jobs", job())).json()) as { plan_id: string };
    const res = await call("POST", `/v1/plans/${plan_id}/fund-tx`, { change_address: "a", utxos: [] });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/@cascade\/sdk/);
  });

  it("rejects bad input, unknown plans, short deadlines and expired plans", async () => {
    let now = NOW;
    const { call } = make(builder, () => now);
    expect((await call("POST", "/v1/jobs", job({ goal: "short" }))).status).toBe(400);
    expect((await call("POST", "/v1/jobs", job({ deadline: NOW + 60_000 }))).status).toBe(422);
    expect((await call("POST", "/v1/jobs", job({ deadline: NOW + 45 * 60_000 }))).status).toBe(422);
    expect((await call("GET", "/v1/plans/nope")).status).toBe(404);
    expect((await call("GET", "/v1/plans/bad%20id")).status).toBe(400);
    expect((await call("POST", `/v1/trees/xyz/actions`, {})).status).toBe(400);
    const { plan_id } = (await (await call("POST", "/v1/jobs", job())).json()) as { plan_id: string };
    now += 31 * 60_000;
    expect(web.PlanEnvelopeSchema.parse(await (await call("GET", `/v1/plans/${plan_id}`)).json()).status).toBe("expired");
    expect((await call("POST", `/v1/plans/${plan_id}/fund-tx`, { change_address: "a", utxos: [] })).status).toBe(409);
  });
});
