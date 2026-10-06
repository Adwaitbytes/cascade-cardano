/**
 * Conductor durability (A15): plans and hire records survive a restart (new store instances on the
 * same database), and a hire retried after a crash resends the recorded payment instead of drawing
 * a second child.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cascadeAgent, defaultRailRequirement, localKeySigner, type PaymentRequirements, type PaymentVerifier } from "@cascade/agent";
import { jcs, type NodeSpec } from "@cascade/shared/browser";
import { createActivities, type ChainActions } from "../src/activities.js";
import { buildPlan, DEFAULT_POLICY } from "../src/build-plan.js";
import { demoDraft } from "../src/draft.js";
import { LlmClient } from "../src/llm.js";
import { composeByMerge } from "../src/compose.js";
import { migrateOrchestratorState, PostgresHireLedger, PostgresPlanStore } from "../src/state/postgres.js";
import { markPlanFunded, orchestratorApi, type BuyerTxBuilder } from "../src/api/index.js";

const url = process.env["CASCADE_TEST_DATABASE_URL"] ?? "postgres://cascade:cascade@127.0.0.1:55432/cascade";
const pool = new pg.Pool({ connectionString: url, max: 4 });
const prefix = `t_orch_${process.pid}`;

beforeAll(async () => {
  await migrateOrchestratorState(pool, prefix);
});
afterAll(async () => {
  await pool.query(`DROP TABLE IF EXISTS ${prefix}_plans, ${prefix}_hires`);
  await pool.end();
});

const id = (n: number) => `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b${n.toString(16).padStart(2, "0")}`;

describe("PostgresPlanStore", () => {
  it("survives a restart and maps trees to plans", async () => {
    const now = Date.now();
    const built = buildPlan(demoDraft(), { goal: "juice in Dubai", asset: "lovelace", budget: "150000000", fund_by: now + 1_800_000, submit_by: now + 6 * 3_600_000, max_depth: 3, reputation_floor: 0, risk: "balanced" }, () => ({ primary: { agent_id: id(1), quote_id: null, price: "0" }, fallbacks: [] }), DEFAULT_POLICY, (t) => t.id.slice(-1).charCodeAt(0).toString(16).padStart(2, "0").repeat(28), { masumiPurchaserHash: "9f".repeat(28) });
    if (!built.ok) throw new Error(built.errors.join("; "));
    const request = { goal: "juice in Dubai", asset: "lovelace", budget: "150000000", deadline: now, max_depth: 3, min_reputation: 0, risk: "balanced" as const, acceptance: "buyer_review" as const, allow_agents: [], block_agents: [] };
    const first = new PostgresPlanStore(pool, prefix);
    await first.put({ built: built.built, request, llm: "deterministic-fallback", fallback_reason: null, tree_id: null, funded: false, created_at: now });
    const planId = built.built.plan.plan_id;
    await first.update(planId, (p) => ({ ...p, tree_id: "ab".repeat(28) }));

    const restarted = new PostgresPlanStore(pool, prefix);
    expect(await restarted.awaitingFunding()).toContain(planId);
    const byTree = await restarted.byTree("ab".repeat(28));
    expect(byTree?.built.plan).toEqual(built.built.plan);
    expect(byTree?.built.verifiers).toEqual(built.built.verifiers);
    await restarted.update(planId, (p) => ({ ...p, funded: true }));
    expect(await restarted.awaitingFunding()).not.toContain(planId);
  });
});

describe("fund-tx against Postgres", () => {
  // tree_id derives from the seed UTxO, so a buyer who abandons a fund tx and drafts again from the
  // same wallet gets the same tree id for a different plan.
  const treeId = "cd".repeat(28);
  const builder: BuyerTxBuilder = {
    fundRoot: async () => ({ tx_cbor: "84a400", tree_id: treeId }),
    treeAction: async () => ({ tx_cbor: "84a401" }),
    resolve: async () => ({ tx_cbor: "84a402" }),
  };
  const now = Date.now();
  const store = new PostgresPlanStore(pool, prefix);
  const app = orchestratorApi({
    llm: new LlmClient({}),
    agents: () => ({ primary: { agent_id: id(1), quote_id: null, price: "0" }, fallbacks: [] }),
    verifierKeyOf: (t) => t.id.slice(-1).charCodeAt(0).toString(16).padStart(2, "0").repeat(28),
    masumiPurchaserHash: "9f".repeat(28),
    names: { lookup: async (ids) => Object.fromEntries(ids.map((i) => [i, { name: "Agent", reputation: 0.5 }])) },
    allowedOrigins: [],
    store,
    now: () => now,
    txBuilder: builder,
  });
  const call = async (path: string, body: unknown) => app.fetch(new Request(`https://orch.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const draft = async (goal: string) => {
    const res = await call("/v1/jobs", { goal, asset: "lovelace", budget: "150000000", deadline: now + 6 * 3_600_000, max_depth: 3, min_reputation: 0, risk: "balanced", acceptance: "buyer_review", allow_agents: [], block_agents: [] });
    expect(res.status).toBe(200);
    return ((await res.json()) as { plan_id: string }).plan_id;
  };
  const wallet = { change_address: "addr_test1qqx", utxos: ["82825820"] };

  it("hands an unfunded tree id to the buyer's new plan and answers 409 once the tree is funded", async () => {
    const abandoned = await draft("Market entry brief for selling cold-pressed juice in Dubai, with competitor pricing table and a sourced fact check.");
    expect((await call(`/v1/plans/${abandoned}/fund-tx`, wallet)).status).toBe(200);
    expect((await call(`/v1/plans/${abandoned}/fund-tx`, wallet)).status).toBe(200);

    const rebuilt = await draft("Market entry brief for selling cold-pressed juice in Abu Dhabi, with competitor pricing table and a sourced fact check.");
    expect(rebuilt).not.toBe(abandoned);
    const res = await call(`/v1/plans/${rebuilt}/fund-tx`, wallet);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tx_cbor: "84a400", tree_id: treeId });
    expect((await store.byTree(treeId))?.built.plan.plan_id).toBe(rebuilt);
    expect((await store.get(abandoned))?.tree_id).toBeNull();
    expect(await store.awaitingFunding()).not.toContain(abandoned);

    await markPlanFunded(store, rebuilt, treeId);
    const late = await call(`/v1/plans/${abandoned}/fund-tx`, wallet);
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toBe("tree_already_funded");
    expect((await store.byTree(treeId))?.built.plan.plan_id).toBe(rebuilt);
  });
});

describe("hire after a crash", () => {
  it("resends the recorded payment and never draws twice", async () => {
    const signer = localKeySigner(new Uint8Array(32).fill(3));
    let settles = 0;
    const verifier: PaymentVerifier = {
      verify: async () => ({ isValid: true, node: { tree_id: "11".repeat(28), node_id: "22".repeat(28) } }),
      settle: async () => (settles++, { success: true, network: "cardano:preprod", transaction: "ab".repeat(32) }),
    };
    const offer = (amount: string, asset: string): PaymentRequirements[] => [defaultRailRequirement({ network: "cardano:preprod", payTo: signer.address, amount, asset })];
    const agent = cascadeAgent({
      name: "Worker",
      description: "Works.",
      baseUrl: "http://worker.test",
      registryAsset: id(2),
      network: "cardano:preprod",
      inputSchema: { input_data: [{ id: "context", type: "textarea", name: "Context" }] },
      outputSchema: { type: "object" },
      handler: async () => ({ result: { ok: true } }),
      pricing: { asset: "lovelace", amount: "1000000", etaMs: 1_000 },
      rails: ["native"],
      capabilities: { roles: ["specialist"], categories: ["research"], maxDepth: 1, bondLovelace: "0" },
      signer,
      payments: { verifier, requirements: { offer: async (c) => offer(c.amount, c.asset), match: async (a, c) => offer(c.amount, c.asset).find((r) => jcs(r) === jcs(a)) ?? null, discovery: () => offer("1000000", "lovelace") } },
    });
    let crashOnPaid = true;
    const fetchImpl: typeof fetch = async (u, init) => {
      const paid = new Headers(init?.headers).has("PAYMENT-SIGNATURE");
      if (paid && crashOnPaid) {
        crashOnPaid = false;
        throw new Error("simulated crash before the paid purchase reached the agent");
      }
      return agent.fetch(new Request(String(u), init));
    };
    let draws = 0;
    const chain = {
      draw: async (i: { offer: PaymentRequirements[] }) => {
        draws++;
        return { node_id: "22".repeat(28), tx_id: "cd".repeat(32), submit_by: Date.now() + 60_000, challenge_until: Date.now() + 120_000, payment: { x402Version: 2 as const, accepted: i.offer[0]!, payload: { transaction: "84a4", nonce: `${"ef".repeat(32)}#0` } } };
      },
      awaitTx: async () => undefined,
    } as unknown as ChainActions;
    const spec = { id: "research", task: "Research", rail: "native" } as unknown as NodeSpec;
    const make = () =>
      createActivities({
        chain,
        directory: { resolve: async () => ({ base_url: "http://worker.test", payment_address: signer.address }) },
        compose: composeByMerge,
        llm: new LlmClient({}),
        fetch: fetchImpl,
        ledger: new PostgresHireLedger(pool, prefix),
        activityKey: () => "wf-1/activity-7",
        heartbeat: () => undefined,
      });
    const input = { tree_id: "11".repeat(28), parent_node_id: "11".repeat(28), spec, agent: { agent_id: id(2), quote_id: null, price: "1000000" }, input: {} };
    await expect(make().hire(input)).rejects.toThrow(/simulated crash/);
    const record = await make().hire(input);
    expect(draws).toBe(1);
    expect(settles).toBe(1);
    // One job only: the resent header was byte-identical, so the agent recognised the paid retry.
    expect((await agent.store.listByStatus(["awaiting_payment", "running", "completed", "failed", "awaiting_input"])).length).toBe(1);
    expect(record.job_id).not.toBe("");
    expect(record.node_id).toBe("22".repeat(28));
    const again = await make().hire(input);
    expect(again).toEqual(record);
    expect(draws).toBe(1);
  });
});
