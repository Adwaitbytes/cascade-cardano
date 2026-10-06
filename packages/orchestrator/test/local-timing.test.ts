import { describe, expect, it } from "vitest";
import { nestingErrors, nodeDeadlineErrors, planNodesPreOrder, planWindows, type AgentRef } from "@cascade/shared/browser";
import { buildPlan, DEFAULT_POLICY, drawSlackMs, LOCAL_POLICY, rootCriticalPathMs, type AgentSource, type JobIntake } from "../src/build-plan.js";
import { minDisputeWindow } from "../src/chain/buyer-tx.js";
import { demoDraft, type PlanDraft } from "../src/draft.js";
import { scenarioDraft } from "../src/test-scenarios.js";
import { TestAgentRefusedError, withoutTestAgents } from "../src/test-agents.js";
import { validatePlanFull } from "../src/validate.js";

const MIN = 60_000;
const SLACK = drawSlackMs(LOCAL_POLICY);
const FUND_BY = 1_790_000_000_000;
const agent = (n: number): AgentRef => ({ agent_id: `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b${n.toString(16).padStart(2, "0")}`, quote_id: null, price: "0" });
const FLAKY = agent(9);
const isTest = (id: string): boolean => id === FLAKY.agent_id;
const verifierKeyOf = (t: { id: string }) => t.id.slice(-1).charCodeAt(0).toString(16).padStart(2, "0").repeat(28);
const PURCHASER = "9f".repeat(28);
const intake = (over: Partial<JobIntake> = {}): JobIntake => ({
  goal: "Market-entry brief for cold-pressed juice in Dubai, with a competitor price table, an Arabic summary and a fact check.",
  asset: "lovelace",
  budget: "150000000",
  fund_by: FUND_BY,
  submit_by: FUND_BY + 6 * 60 * MIN,
  max_depth: 3,
  reputation_floor: 0.5,
  risk: "balanced",
  ...over,
});
const plain: AgentSource = () => ({ primary: agent(1), fallbacks: [], output_schema: { type: "object" } });

describe("test agents are hired only by labelled test scenarios", () => {
  /** A source that offers the test agent for translation, the way a Directory tag search could. */
  const offersFlaky: AgentSource = (task) =>
    task !== "root" && (task.category === "translation" || task.test_flaky_primary === true)
      ? { primary: FLAKY, fallbacks: [agent(2)], output_schema: { type: "object" } }
      : { primary: agent(1), fallbacks: [], output_schema: { type: "object" } };

  const hiresOf = (draft: PlanDraft, source: AgentSource) => {
    const res = buildPlan(draft, intake(), source, DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    if (!res.ok) throw new Error(res.errors.join("; "));
    return planNodesPreOrder(res.built.plan.root).map(({ node }) => ({ id: node.spec.id, primary: node.agents.primary.agent_id, fallbacks: node.agents.fallbacks.map((f) => f.agent_id) }));
  };

  it("drops a test agent from a normal job's candidates and promotes the next one", () => {
    const hires = hiresOf(demoDraft(), withoutTestAgents(offersFlaky, isTest));
    expect(hires.flatMap((h) => [h.primary, ...h.fallbacks])).not.toContain(FLAKY.agent_id);
    expect(hires.find((h) => h.id === "translate-ar")).toEqual({ id: "translate-ar", primary: agent(2).agent_id, fallbacks: [] });
  });

  it("refuses a slot whose only candidate is a test agent", () => {
    const onlyFlaky: AgentSource = (task, spec) => (task !== "root" && task.category === "translation" ? { primary: FLAKY, fallbacks: [], output_schema: { type: "object" } } : plain(task, spec));
    const res = buildPlan(demoDraft(), intake(), withoutTestAgents(onlyFlaky, isTest), DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.errors.join("; ")).toMatch(/translate-ar: sourcing offered only the test agent/);
    expect(new TestAgentRefusedError("t", "a")).toBeInstanceOf(Error);
  });

  it("keeps the test agent for the A2 TEST SCENARIO slot pinned to it", () => {
    const hires = hiresOf(scenarioDraft("a2-refund-rehire", { lookupApi: "ab".repeat(28) }), withoutTestAgents(offersFlaky, isTest));
    expect(hires.filter((h) => h.primary === FLAKY.agent_id).map((h) => h.id)).toEqual(["scribe"]);
  });
});

describe("LOCAL_POLICY closes a demo-shaped tree in minutes", () => {
  const local = (draft: PlanDraft, over: Partial<JobIntake> = {}) => {
    const res = buildPlan(draft, intake(over), plain, LOCAL_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    if (!res.ok) throw new Error(res.errors.join("; "));
    return res.built.plan;
  };

  it("plans no Masumi slot, minute-scale windows, and a root submit_by at its critical path", () => {
    const plan = local(demoDraft());
    expect(validatePlanFull(plan)).toEqual([]);
    const nodes = planNodesPreOrder(plan.root).map(({ node }) => node);
    expect(nodes.map((n) => n.spec.rail)).not.toContain("address");
    expect(nodes.every((n) => n.spec.masumi_followup === undefined)).toBe(true);
    // The Masumi contingency would only re-hire the same native agent, so it is dropped.
    expect(nodes.map((n) => n.spec.id)).not.toContain("translate-ar-masumi");
    for (const n of nodes) {
      expect(n.spec.deadlines.work_ms).toBeLessThanOrEqual(MIN);
      expect(n.spec.deadlines.compose_ms).toBeLessThanOrEqual(MIN / 2);
      expect(n.spec.deadlines.challenge_window_ms).toBe(MIN / 2);
      expect(n.spec.deadlines.dispute_window_ms).toBe(MIN / 2);
    }
    const span = plan.deadlines.submit_by - plan.deadlines.fund_by;
    expect(span).toBe(rootCriticalPathMs(plan, demoDraft(), SLACK));
    // Worst case, every slot running to its deadline plus its Draw slack; the root closes
    // at its challenge_until, half a minute later. A tree whose agents deliver accepts well inside it.
    expect(span).toBeLessThanOrEqual(15 * MIN);
    expect(plan.deadlines.submit_by).toBeGreaterThanOrEqual(plan.deadlines.fund_by + Number(planWindows(plan).get("root")?.submit_offset));
  });

  it("keeps every on-chain rule: node windows, the tree's min_dispute_window, and Draw nesting along the critical path", () => {
    const plan = local(demoDraft());
    const d = plan.deadlines;
    const root = { submit_by: BigInt(d.submit_by), challenge_until: BigInt(d.challenge_until), refund_after: BigInt(d.refund_after), dispute_until: BigInt(d.dispute_until) };
    expect(nodeDeadlineErrors(root, BigInt(plan.limits.min_challenge_window_ms))).toEqual([]);
    expect(minDisputeWindow(plan)).toBe(BigInt(MIN / 2));
    expect(root.dispute_until - root.challenge_until).toBeGreaterThanOrEqual(minDisputeWindow(plan));
    // The translation is the last child drawn: after scout, the checkers and Scribe, each run to
    // its deadline plus its Draw slack.
    const w = planWindows(plan);
    const off = (id: string) => Number(w.get(id)?.submit_offset);
    const slack = SLACK;
    const scoutDone = off("scout") + slack;
    const checkersDone = scoutDone + off("check-a") + slack;
    const scribeDone = checkersDone + off("scribe") + slack;
    const drawAt = BigInt(d.fund_by + plan.root.spec.deadlines.work_ms + scribeDone);
    const translationEnd = drawAt + BigInt(off("translate-ar") + slack) + BigInt(MIN);
    expect(nestingErrors({ dispute_until: translationEnd }, { submit_by: root.submit_by }, BigInt(plan.limits.min_safety_margin_ms), BigInt(plan.root.spec.deadlines.compose_ms))).toEqual([]);
  });

  it("draws with the slack the local deadline counts on, and preprod's minute", () => {
    expect(SLACK).toBe(30_000);
    expect(drawSlackMs(DEFAULT_POLICY)).toBe(MIN);
  });

  it("never pushes submit_by past the buyer's deadline, and leaves preprod's at the buyer's deadline", () => {
    const tight = local(demoDraft());
    const minimal = FUND_BY + Number(planWindows(tight).get("root")?.submit_offset);
    const asked = minimal + 5 * MIN;
    expect(local(demoDraft(), { submit_by: asked }).deadlines.submit_by).toBe(Math.min(asked, tight.deadlines.submit_by));
    const res = buildPlan(demoDraft(), intake(), plain, DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(res.built.plan.deadlines.submit_by).toBe(FUND_BY + 6 * 60 * MIN);
  });

  it("budgets the A2 refund and re-hire into the local deadline", () => {
    const flakyFirst: AgentSource = (task, spec) => (task !== "root" && task.test_flaky_primary === true ? { primary: FLAKY, fallbacks: [agent(2)], output_schema: { type: "object" } } : plain(task, spec));
    const draft = scenarioDraft("a2-refund-rehire", { lookupApi: "ab".repeat(28) });
    const res = buildPlan(draft, intake({ budget: "80000000" }), flakyFirst, LOCAL_POLICY, verifierKeyOf, {});
    if (!res.ok) throw new Error(res.errors.join("; "));
    const plan = res.built.plan;
    const withoutRetry = rootCriticalPathMs({ ...plan, root: { ...plan.root, children: plan.root.children.map((c) => ({ ...c, agents: { ...c.agents, fallbacks: [] } })) } }, draft, SLACK);
    const retry = Number(planWindows(plan).get("scribe")?.submit_offset) + 2 * SLACK;
    expect(plan.deadlines.submit_by - plan.deadlines.fund_by).toBe(withoutRetry + retry);
  });
});
