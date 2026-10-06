import { describe, expect, it } from "vitest";
import { localKeySigner } from "@cascade/agent";
import { buyAndRun, ScriptedVerifier, testRequirements, testRuntime } from "@cascade/agent-kit/testing";
import { validatePlanFull } from "@cascade/orchestrator";
import { LlmClient } from "@cascade/orchestrator/llm";
import { planNodesPreOrder, type Plan } from "@cascade/shared/browser";
import { createConductorAgent, EXECUTION_STATUS, type ReferenceAgentIds } from "../src/agent.js";

const signer = localKeySigner(new Uint8Array(32).fill(11));
const id = (n: number) => `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b${n.toString(16).padStart(2, "0")}`;
const agents: ReferenceAgentIds = { conductor: id(1), scout: id(2), pricer: id(3), "lookup-api": id(4), "flaky-lisan": id(5), lisan: id(6), "checker-a": id(7), "checker-b": id(8), "checker-c": id(10), scribe: id(9) };
const checkerKeys = { a: "aa".repeat(28), b: "bb".repeat(28), c: "cc".repeat(28) };
const goal = "Market entry brief for selling cold-pressed juice in Dubai, with competitor pricing table, Arabic translation of the summary, and a sourced fact check.";

describe("Conductor", () => {
  it("returns a valid, labelled Plan for the PRD 21.2 demo goal with the reference agents assigned", async () => {
    const agent = createConductorAgent({ runtime: testRuntime("conductor"), signer, llm: new LlmClient({}), agents, checkerKeys, masumiPurchaserHash: "9f".repeat(28), payments: { requirements: testRequirements(signer.address), verifier: new ScriptedVerifier() } });
    const run = await buyAndRun(agent, { goal, budget: 150_000_000, deadline_minutes: 360, risk: "balanced" });
    expect(run.status).toBe("completed");
    const result = run.bundle?.["result"] as { plan: Plan; plan_root: string; llm: string; execution: string; contingencies: Record<string, string> };
    expect(result.llm).toBe("deterministic-fallback");
    expect(result.execution).toBe(EXECUTION_STATUS);
    expect(validatePlanFull(result.plan)).toEqual([]);
    expect(result.plan_root).toBe(result.plan.plan_root);
    const assigned = Object.fromEntries(planNodesPreOrder(result.plan.root).map(({ node }) => [node.spec.id, node.agents.primary.agent_id]));
    expect(assigned).toEqual({
      root: agents.conductor,
      scout: agents.scout,
      pricer: agents.pricer,
      lookup: agents["lookup-api"],
      "check-a": agents["checker-a"],
      "check-b": agents["checker-b"],
      "check-c": agents["checker-c"],
      scribe: agents.scribe,
      // A normal job never hires the Flaky Lisan test agent: a native translation goes to Scribe.
      "translate-ar": agents.scribe,
      "translate-ar-masumi": agents.lisan,
    });
    expect(result.contingencies).toEqual({ "translate-ar-masumi": "translate-ar" });
  });

  it("rejects a deadline too short for the plan and invalid input", async () => {
    const agent = createConductorAgent({ runtime: testRuntime("conductor"), signer, llm: new LlmClient({}), agents, checkerKeys, masumiPurchaserHash: "9f".repeat(28), payments: { requirements: testRequirements(signer.address), verifier: new ScriptedVerifier() } });
    const run = await buyAndRun(agent, { goal, budget: 150_000_000, deadline_minutes: 30 });
    expect(run.status).toBe("failed");
    expect((await agent.store.get(run.job_id))?.error).toMatch(/deadline too short/);
    const bad = await agent.fetch(new Request("http://t/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier_from_purchaser: "x", input_data: { goal: "short", budget: 1, deadline_minutes: 1 } }) }));
    expect(bad.status).toBe(400);
  });
});

describe("Conductor console API", () => {
  it("serves /v1/jobs and /v1/plans on the agent's port", async () => {
    const { referenceAgentNames } = await import("../src/agent.js");
    const agent = createConductorAgent({ runtime: testRuntime("conductor"), signer, llm: new LlmClient({}), agents, checkerKeys, masumiPurchaserHash: "9f".repeat(28), api: { names: referenceAgentNames(agents), allowedOrigins: ["http://localhost:3000"] } });
    const res = await agent.fetch(
      new Request("http://t/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal, asset: "lovelace", budget: "150000000", deadline: Date.now() + 6 * 3_600_000, max_depth: 3, min_reputation: 60, risk: "balanced", acceptance: "buyer_review", allow_agents: [], block_agents: [] }),
      }),
    );
    expect(res.status).toBe(200);
    const { plan_id } = (await res.json()) as { plan_id: string };
    const envelope = (await (await agent.fetch(new Request(`http://t/v1/plans/${plan_id}`))).json()) as { agents: Record<string, { name: string }>; status: string };
    expect(envelope.status).toBe("draft");
    expect(envelope.agents[agents.scribe]?.name).toBe("Scribe");
    expect(envelope.agents[agents["flaky-lisan"]], "a normal job never lists the test agent").toBeUndefined();
  });

  it("plans minute-scale windows on the local devnet and keeps preprod's windows", async () => {
    const { referenceAgentNames } = await import("../src/agent.js");
    const planOn = async (network: "cardano:local" | "cardano:preprod", deadline: number): Promise<{ plan: Plan; createdAt: number; longestStep: number; rails: string[] }> => {
      const agent = createConductorAgent({ runtime: { ...testRuntime("conductor"), network }, signer, llm: new LlmClient({}), agents, checkerKeys, masumiPurchaserHash: "9f".repeat(28), api: { names: referenceAgentNames(agents), allowedOrigins: ["http://localhost:3000"] } });
      const createdAt = Date.now();
      const res = await agent.fetch(
        new Request("http://t/v1/jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal, asset: "lovelace", budget: "150000000", deadline, max_depth: 3, min_reputation: 60, risk: "balanced", acceptance: "buyer_review", allow_agents: [], block_agents: [] }),
        }),
      );
      expect(res.status).toBe(200);
      const { plan_id } = (await res.json()) as { plan_id: string };
      const { plan } = (await (await agent.fetch(new Request(`http://t/v1/plans/${plan_id}`))).json()) as { plan: Plan };
      expect(validatePlanFull(plan)).toEqual([]);
      const nodes = planNodesPreOrder(plan.root);
      const ids = nodes.flatMap(({ node }) => [node.agents.primary, ...node.agents.fallbacks].map((a) => a.agent_id));
      expect(ids, "a normal job never hires the test agent").not.toContain(agents["flaky-lisan"]);
      const steps = nodes.flatMap(({ node }) => [node.spec.deadlines.work_ms, node.spec.deadlines.compose_ms]);
      return { plan, createdAt, longestStep: Math.max(...steps), rails: nodes.map(({ node }) => node.spec.rail) };
    };
    const deadline = Date.now() + 6 * 3_600_000;
    const local = await planOn("cardano:local", deadline);
    expect(local.plan.limits.min_challenge_window_ms).toBe(30_000);
    expect(local.plan.limits.min_safety_margin_ms).toBe(15_000);
    expect(local.plan.root.spec.deadlines.dispute_window_ms).toBe(30_000);
    expect(local.longestStep).toBeLessThanOrEqual(60_000);
    // No Masumi payment service on Yaci, and its 35-minute minimum window would set the pace.
    expect(local.rails).not.toContain("address");
    // The buyer asked for 6 hours; the local root must submit as soon as its critical path allows.
    expect(local.plan.deadlines.fund_by - local.createdAt).toBeLessThanOrEqual(5 * 60_000 + 5_000);
    expect(local.plan.deadlines.submit_by - local.plan.deadlines.fund_by).toBeLessThanOrEqual(15 * 60_000);
    expect(local.plan.deadlines.dispute_until).toBeLessThan(deadline);
    const preprod = await planOn("cardano:preprod", deadline);
    expect(preprod.plan.limits.min_challenge_window_ms).toBe(10 * 60_000);
    expect(preprod.plan.limits.min_safety_margin_ms).toBe(5 * 60_000);
    expect(preprod.plan.root.spec.deadlines.dispute_window_ms).toBe(10 * 60_000);
    expect(preprod.longestStep).toBeGreaterThan(3 * 60_000);
    expect(preprod.plan.deadlines.submit_by, "preprod keeps the buyer's deadline").toBe(deadline);
    expect(preprod.plan.deadlines.fund_by - preprod.createdAt).toBeGreaterThanOrEqual(30 * 60_000);
  });
});
