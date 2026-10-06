/**
 * Console trees set a reputation floor of 0, but the plan reached the indexer without the buyer's
 * policy, so the signer applied its default 0.3 floor and refused every Draw to Scribe (score
 * 0.290, gate-3-reputation-floor) in preprod trees 43bc277c, 1f97401a and 04f1d0c8. The buyer's
 * intake choices must travel with the plan.
 */
import { describe, expect, it } from "vitest";
import { BuyerPolicySchema, DEFAULT_BUYER_POLICY } from "@cascade/policy";
import type { Plan } from "@cascade/shared/browser";
import { buyerPolicyFor, InMemoryPlanStore, orchestratorApi, type BuyerTerms, type BuyerTxBuilder } from "../src/api/index.js";
import { IndexerClient } from "../src/chain/indexer.js";
import { LlmClient } from "../src/llm.js";

const NOW = 1_790_000_000_000;
const HOUR = 3_600_000;
const SCRIBE = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b1238dbef204d429c5b8207175d900b1c5999f7b96d5da1c3c353655eed000001";

describe("buyer policy from intake", () => {
  it("takes the buyer's reputation floor, so a seller at 0.290 passes a floor of 0", () => {
    const policy = BuyerPolicySchema.parse(buyerPolicyFor(DEFAULT_BUYER_POLICY, { min_reputation: 0, block_agents: [] }));
    expect(policy.reputation_floor).toEqual({ score: 0, confidence: 0 });
    expect(0.29 >= policy.reputation_floor.score).toBe(true);
    expect(buyerPolicyFor(DEFAULT_BUYER_POLICY, { min_reputation: 60, block_agents: [] }).reputation_floor.score).toBe(0.6);
  });

  it("keeps every other default and adds blockable agent ids to the blocklist", () => {
    const policy = BuyerPolicySchema.parse(buyerPolicyFor(DEFAULT_BUYER_POLICY, { min_reputation: 30, block_agents: [SCRIBE, "not-an-agent-id", SCRIBE] }));
    expect(policy.blocklist).toEqual([SCRIBE]);
    expect({ ...policy, reputation_floor: DEFAULT_BUYER_POLICY.reputation_floor, blocklist: [] }).toEqual(DEFAULT_BUYER_POLICY);
  });

  it("builds from the default policy when the caller has none, so fund-tx never fails on a missing base", () => {
    // A Conductor built before the policy change passed no base; fund-tx answered 500 (base.blocklist of undefined).
    const policy = BuyerPolicySchema.parse(buyerPolicyFor(undefined, { min_reputation: 0, block_agents: [SCRIBE] }));
    expect(policy.reputation_floor).toEqual({ score: 0, confidence: DEFAULT_BUYER_POLICY.reputation_floor.confidence });
    expect(policy.blocklist).toEqual([...DEFAULT_BUYER_POLICY.blocklist, SCRIBE]);
  });

  it("rejects a floor outside 0 to 100", () => {
    expect(() => buyerPolicyFor(DEFAULT_BUYER_POLICY, { min_reputation: 101, block_agents: [] })).toThrow(RangeError);
  });

  it("fund-tx hands the stored request's floor and blocklist to the transaction builder", async () => {
    const seen: BuyerTerms[] = [];
    const txBuilder: BuyerTxBuilder = {
      fundRoot: async (_plan, _wallet, terms) => {
        seen.push(terms);
        return { tx_cbor: "84a400", tree_id: "aa".repeat(28) };
      },
      treeAction: async () => ({ tx_cbor: "84a401" }),
      resolve: async () => ({ tx_cbor: "84a403" }),
    };
    const app = orchestratorApi({
      llm: new LlmClient({}),
      agents: () => ({ primary: { agent_id: SCRIBE, quote_id: null, price: "0" }, fallbacks: [] }),
      verifierKeyOf: (t) => t.id.slice(-1).charCodeAt(0).toString(16).padStart(2, "0").repeat(28),
      masumiPurchaserHash: "9f".repeat(28),
      names: { lookup: async () => ({}) },
      allowedOrigins: ["https://console.test"],
      store: new InMemoryPlanStore(),
      now: () => NOW,
      txBuilder,
    });
    const post = (path: string, body: unknown) =>
      app.fetch(new Request(`https://orch.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const job = {
      goal: "Market entry brief for selling cold-pressed juice in Dubai, with competitor pricing table.",
      asset: "lovelace",
      budget: "150000000",
      deadline: NOW + 6 * HOUR,
      max_depth: 3,
      min_reputation: 0,
      risk: "balanced",
      acceptance: "buyer_review",
      allow_agents: [],
      block_agents: [SCRIBE],
    };
    const { plan_id } = (await (await post("/v1/jobs", job)).json()) as { plan_id: string };
    expect((await post(`/v1/plans/${plan_id}/fund-tx`, { change_address: "addr_test1qqx", utxos: [] })).status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.min_reputation).toBe(0);
    expect(seen[0]?.block_agents).toEqual([SCRIBE]);
  });

  it("the indexer client sends the policy with the plan", async () => {
    const bodies: unknown[] = [];
    const fetchStub: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    };
    const client = new IndexerClient({ baseUrl: "https://indexer.test", adminToken: null, fetch: fetchStub });
    const plan = { plan_id: "p" } as unknown as Plan;
    const policy = buyerPolicyFor(DEFAULT_BUYER_POLICY, { min_reputation: 0, block_agents: [] });
    await client.registerPlan(plan, "aa".repeat(28), policy);
    await client.registerPlan(plan, null);
    expect(bodies).toEqual([
      { plan, tree_id: "aa".repeat(28), policy },
      { plan, tree_id: null },
    ]);
  });
});
