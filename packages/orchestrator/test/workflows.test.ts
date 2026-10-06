/**
 * Workflow logic against Temporal's time-skipping test server. Activities are in-memory fakes:
 * these tests prove sequencing and recovery, not chain behaviour (that is W2/W3 integration).
 */
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jcsSha256Hex, specHash, type AgentRef, type JsonValue, type NodeSpec } from "@cascade/shared/browser";
import type { CascadeActivities, ChallengeState } from "../src/activities.js";
import { buildPlan, DEFAULT_POLICY } from "../src/build-plan.js";
import { demoDraft } from "../src/draft.js";
import { subtreeWorkflowInput } from "../src/subtree.js";
import { scenarioDraft } from "../src/test-scenarios.js";
import { tsExtensionAlias, workflowsPath } from "../src/worker.js";
import type { HireOutcome, NodeOutcome } from "../src/workflows/types.js";

let env: TestWorkflowEnvironment;
beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);
afterAll(async () => {
  await env?.teardown();
});

const agent = (n: number): AgentRef => ({ agent_id: `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b${n.toString(16).padStart(2, "0")}`, quote_id: null, price: "0" });
const FLAKY = agent(0xf1).agent_id;
const BAD_SCHEMA = agent(0xba).agent_id;

type Behaviour = "deliver" | "silent" | "bad_schema" | "lost";

/** In-memory agents and chain. Records every call so tests can assert the recovery sequence. */
function fakeWorld(behaviour: (agentId: string) => Behaviour) {
  const calls: string[] = [];
  let n = 0;
  const hires = new Map<string, { agent_id: string; spec: NodeSpec; submit_by: number }>();
  const activities: CascadeActivities = {
    async hire({ spec, agent: a }) {
      n++;
      const node_id = n.toString(16).padStart(56, "0");
      const submit_by = Date.now() + spec.deadlines.work_ms;
      hires.set(`job-${node_id}`, { agent_id: a.agent_id, spec, submit_by });
      calls.push(`hire ${spec.id} ${a.agent_id.slice(-2)}`);
      // ADR 8.1: a Masumi purchase through P has no node, only the lock P made.
      if (spec.masumi_followup !== undefined) return { agent_id: a.agent_id, node_id: "", job_id: `job-${node_id}`, draw_tx_id: "aa".repeat(32), submit_by, challenge_until: submit_by + 600_000, masumi: { lock_tx: "a1".repeat(32), blockchain_identifier: "bid", submit_result_time: submit_by } };
      return { agent_id: a.agent_id, node_id, job_id: `job-${node_id}`, draw_tx_id: "aa".repeat(32), submit_by, challenge_until: submit_by + 600_000, ledger_key: `key-${n}` };
    },
    async buyAddress() {
      throw new Error("not used in these workflows");
    },
    async jobStatus({ agent_id }) {
      const b = behaviour(agent_id);
      return { status: b === "silent" ? "running" : b === "lost" ? "lost" : "completed" };
    },
    async markHireLost({ ledger_key }) {
      calls.push(`lost ${ledger_key}`);
    },
    async fetchResult({ agent_id, job_id }) {
      const hire = hires.get(job_id);
      if (hire === undefined) throw new Error("unknown job");
      if (behaviour(agent_id) === "bad_schema") return { ok: false, errors: ["/ must have required property"] };
      const result: JsonValue =
        hire.spec.category === "verification"
          ? { verdict: { verdict: "accept" } }
          : Object.fromEntries((hire.spec.output_schema["required"] as string[]).map((k) => [k, `${k} from ${hire.spec.id}`]));
      return { ok: true, result, result_hash: jcsSha256Hex(result) };
    },
    async crankRefund({ node_id }) {
      calls.push(`refund ${node_id.slice(-2)}`);
      return { tx_id: "bb".repeat(32) };
    },
    async challenge({ node_id }) {
      calls.push(`challenge ${node_id.slice(-2)}`);
      return { tx_id: "cc".repeat(32), reason_hash: "dd".repeat(32), notice_error: null, reason_record_error: null };
    },
    async challengeState(): Promise<ChallengeState> {
      return "unanswered";
    },
    async escalate() {
      calls.push("escalate");
      return { tx_id: "ee".repeat(32) };
    },
    async disputeState() {
      return "parent";
    },
    async requestMasumiRefund({ masumi }) {
      calls.push(`masumi refund${masumi === undefined ? "" : ` of lock ${masumi.lock_tx.slice(0, 4)}`}`);
    },
    async returnMasumiPayment({ draw_tx_id }) {
      calls.push(`masumi return ${draw_tx_id.slice(0, 4)}`);
      return { tx_id: "ab".repeat(32) };
    },
    async masumiRefundFinal() {
      return true;
    },
    async closeReceipt() {
      calls.push("close receipt");
      return { tx_id: "ff".repeat(32) };
    },
    async acceptAndSettle({ spec, verdicts }) {
      calls.push(`settle ${spec.id}${verdicts.length > 0 ? ` with ${verdicts.length} verdicts` : ""}`);
      return { tx_ids: ["11".repeat(32)] };
    },
    async compose({ parts, partial }) {
      const result: JsonValue = { result: Object.fromEntries(parts.map((p) => [p.spec_id, p.result])), children: parts.map((p) => p.spec_id), partial };
      return { result, result_hash: jcsSha256Hex(result), llm: "none: deterministic merge" };
    },
    async submit() {
      calls.push("submit root");
      return { tx_id: "22".repeat(32) };
    },
  };
  return { activities, calls };
}

async function run<T>(activities: CascadeActivities, workflow: "hireWorkflow" | "nodeWorkflow", arg: unknown): Promise<T> {
  const taskQueue = `q-${Math.random().toString(36).slice(2)}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: workflowsPath(),
    activities,
    bundlerOptions: { webpackConfigHook: tsExtensionAlias },
  });
  return worker.runUntil(env.client.workflow.execute(workflow, { taskQueue, workflowId: `wf-${taskQueue}`, args: [arg] })) as Promise<T>;
}

const FUND_BY = Date.now();
const built = buildPlan(
  demoDraft(),
  { goal: "juice in Dubai", asset: "lovelace", budget: "150000000", fund_by: FUND_BY, submit_by: FUND_BY + 6 * 3_600_000, max_depth: 3, reputation_floor: 0, risk: "balanced" },
  () => ({ primary: agent(1), fallbacks: [agent(2)] }),
  DEFAULT_POLICY,
  (t) => t.id.slice(-1).charCodeAt(0).toString(16).padStart(2, "0").repeat(28),
  { masumiPurchaserHash: "9f".repeat(28) },
);
if (!built.ok) throw new Error(built.errors.join("; "));
const plan = built.built.plan;
const specOf = (id: string): NodeSpec => {
  const find = (n: typeof plan.root): NodeSpec | undefined => (n.spec.id === id ? n.spec : n.children.map(find).find((s) => s !== undefined));
  const s = find(plan.root);
  if (s === undefined) throw new Error(id);
  return s;
};

const hireInput = (spec: NodeSpec, candidates: AgentRef[], extra: Record<string, unknown> = {}) => ({
  tree_id: "aa".repeat(28),
  parent_node_id: "aa".repeat(28),
  spec,
  candidates,
  input: {},
  reserve: spec.price.max_budget,
  remaining_budget: "0",
  can_replan: false,
  poll_ms: 30_000,
  ...extra,
});

describe("hireWorkflow", () => {
  it("hires, accepts and settles a delivering agent", async () => {
    const { activities, calls } = fakeWorld(() => "deliver");
    const out = await run<HireOutcome>(activities, "hireWorkflow", hireInput(specOf("scribe"), [agent(1)]));
    expect(out.status).toBe("accepted");
    expect(calls).toEqual(["hire scribe 01", "settle scribe"]);
  });

  it("refunds a silent agent after submit_by and re-hires the fallback from the reserve (demo step 4)", async () => {
    const { activities, calls } = fakeWorld((id) => (id === FLAKY ? "silent" : "deliver"));
    const out = await run<HireOutcome>(activities, "hireWorkflow", hireInput(specOf("translate-ar"), [{ ...agent(0xf1) }, agent(2)]));
    expect(out.status).toBe("accepted");
    expect(calls).toEqual(["hire translate-ar f1", "refund 01", "hire translate-ar 02", "settle translate-ar"]);
  });

  it("an agent that lost a paid job (job_not_found after its restart) is not polled again: refund at the deadline, then the fallback", async () => {
    const { activities, calls } = fakeWorld((id) => (id === agent(1).agent_id ? "lost" : "deliver"));
    const out = await run<HireOutcome>(activities, "hireWorkflow", hireInput(specOf("scribe"), [agent(1), agent(2)]));
    expect(out.status).toBe("accepted");
    expect(out.actions).toEqual(expect.arrayContaining(["event job_lost", "event missed_submit_by", "action crank_refund"]));
    expect(calls.filter((c) => c.startsWith("lost"))).toEqual(["lost key-1"]);
    expect(calls.filter((c) => c.startsWith("hire"))).toEqual(["hire scribe 01", "hire scribe 02"]);
  });

  it("challenges a schema failure; unanswered by the deadline, the parent wins and re-hires", async () => {
    const { activities, calls } = fakeWorld((id) => (id === BAD_SCHEMA ? "bad_schema" : "deliver"));
    const out = await run<HireOutcome>(activities, "hireWorkflow", hireInput(specOf("scribe"), [agent(0xba), agent(2)]));
    expect(out.status).toBe("accepted");
    expect(calls).toEqual(["hire scribe ba", "challenge 01", "hire scribe 02", "settle scribe"]);
  });

  it("returns partial when every candidate fails and re-planning is not allowed", async () => {
    const { activities } = fakeWorld(() => "silent");
    const out = await run<HireOutcome>(activities, "hireWorkflow", hireInput(specOf("scribe"), [agent(0xf1)]));
    expect(out.status).toBe("partial");
  });

  it("requests the Masumi refund for a silent Masumi seller", async () => {
    const { activities, calls } = fakeWorld(() => "silent");
    const out = await run<HireOutcome>(activities, "hireWorkflow", hireInput(specOf("translate-ar-masumi"), [agent(0xf1)]));
    expect(out.status).toBe("partial");
    // ADR 8.1: P requests the refund of its own lock (to buyer_refund); there is no receipt node to close.
    expect(calls).toEqual(["hire translate-ar-masumi f1", "masumi refund of lock a1a1"]);
  });

  it("returns a Masumi payment P could not lock to buyer_refund (detached) and leaves the slot partial", async () => {
    const { activities, calls } = fakeWorld(() => "deliver");
    const hire = activities.hire;
    let n = 0;
    activities.hire = async (h) => ({ ...(await hire(h)), draw_tx_id: `d${++n}`.padEnd(64, "0"), masumi: undefined, masumi_unlocked: { ledger_key: `wf/${n}`, reason: "lock refused" } });
    const out = await run<HireOutcome>(activities, "hireWorkflow", hireInput(specOf("translate-ar-masumi"), [agent(0xf1)]));
    expect(out.status).toBe("partial");
    // The return runs after its grace period in its own workflow; the slot does not wait for it.
    expect(calls.filter((c) => c.startsWith("hire"))).toEqual(["hire translate-ar-masumi f1", "hire translate-ar-masumi f1"]);
    expect(out.actions.some((a) => a.includes("returning it to buyer_refund"))).toBe(true);
  });

  it("runs sibling verifiers and settles with their verdicts when the quorum accepts", async () => {
    const { activities, calls } = fakeWorld(() => "deliver");
    const out = await run<HireOutcome>(
      activities,
      "hireWorkflow",
      hireInput(specOf("scout"), [agent(1)], { verifiers: [{ spec: specOf("check-a"), candidates: [agent(3)] }, { spec: specOf("check-b"), candidates: [agent(4)] }] }),
    );
    expect(out.status).toBe("accepted");
    expect(calls).toContain("settle scout with 2 verdicts");
  });

  it("A9 quorum: the labelled scenario reaches every checker, and two accepts of three settle despite one reject", async () => {
    const { activities, calls } = fakeWorld(() => "deliver");
    const hire = activities.hire;
    const fetchResult = activities.fetchResult;
    const checkerInputs: Record<string, JsonValue>[] = [];
    const rejecter = agent(5).agent_id;
    activities.hire = async (h) => {
      if (h.spec.category === "verification") checkerInputs.push(h.input);
      return hire(h);
    };
    activities.fetchResult = async (f) => {
      if (f.agent_id !== rejecter) return fetchResult(f);
      const result: JsonValue = { verdict: { verdict: "reject" } };
      return { ok: true, result, result_hash: jcsSha256Hex(result) };
    };
    const verifiers = [
      { spec: specOf("check-a"), candidates: [agent(3)] },
      { spec: specOf("check-b"), candidates: [agent(4)] },
      { spec: specOf("check-c"), candidates: [agent(5)] },
    ];
    const out = await run<HireOutcome>(activities, "hireWorkflow", hireInput(specOf("scout"), [agent(1)], { verifiers, input: { test_scenario: "a9-quorum" } }));
    expect(out.status).toBe("accepted");
    expect(checkerInputs.map((i) => i["test_scenario"])).toEqual(["a9-quorum", "a9-quorum", "a9-quorum"]);
    expect(calls).toContain("settle scout with 3 verdicts");
  });
});

describe("nodeWorkflow", () => {
  it("runs the root in dependency order, swaps in the Masumi contingency for Flaky Lisan, composes and submits", async () => {
    const { activities, calls } = fakeWorld((id) => (id === FLAKY ? "silent" : "deliver"));
    const children = plan.root.children.map((c) => ({
      spec: c.spec,
      candidates: c.spec.id === "translate-ar" ? [agent(0xf1)] : [agent(1)],
    }));
    const out = await run<NodeOutcome>(activities, "nodeWorkflow", {
      tree_id: "aa".repeat(28),
      node_id: "aa".repeat(28),
      spec: plan.root.spec,
      children,
      contingencies: built.built.contingencies,
      after: built.built.after,
      verifiers: built.built.verifiers,
      input: { goal: "juice in Dubai" },
      reserve: plan.totals.reserve,
      poll_ms: 30_000,
    });
    expect(out.partial).toBe(false);
    expect(Object.keys((out.result as { result: Record<string, unknown> }).result).sort()).toEqual(["scout", "scribe", "translate-ar-masumi"]);
    const order = (s: string) => calls.findIndex((c) => c.startsWith(s));
    expect(order("hire scout")).toBeLessThan(order("hire scribe"));
    expect(order("hire scribe")).toBeLessThan(order("hire translate-ar f1"));
    expect(order("refund")).toBeLessThan(order("hire translate-ar-masumi"));
    // The Masumi seller is paid through P's lock and withdraws itself: nothing to accept or settle on chain.
    expect(calls).not.toContain("settle translate-ar-masumi");
    expect(calls.at(-1)).toBe("submit root");
  });
});

describe("nodeWorkflow with a failed hire", () => {
  const rootInput = (children: { spec: NodeSpec; candidates: AgentRef[] }[]) => ({
    tree_id: "aa".repeat(28),
    node_id: "aa".repeat(28),
    spec: plan.root.spec,
    children,
    contingencies: built.built.contingencies,
    after: built.built.after,
    verifiers: built.built.verifiers,
    input: { goal: "juice in Dubai" },
    reserve: plan.totals.reserve,
    poll_ms: 30_000,
  });

  // Preprod trees fcca2101 (A5) and 42811ec9 (A7): a child's hire workflow failed, the root's
  // nodeWorkflow rethrew, and the root never submitted. The slot is now a missing part instead.
  it("composes the other parts and still submits the root when a child's hire workflow fails", async () => {
    const { activities, calls } = fakeWorld(() => "deliver");
    const hire = activities.hire;
    activities.hire = async (h) => {
      if (h.spec.id === "scout") throw ApplicationFailure.nonRetryable("deadline 1791241680429 has passed", "DeadlineError");
      return hire(h);
    };
    const children = plan.root.children.map((c) => ({ spec: c.spec, candidates: [agent(1)] }));
    const out = await run<NodeOutcome>(activities, "nodeWorkflow", rootInput(children));
    expect(out.partial).toBe(true);
    const scout = out.children.find((c) => c.spec_id === "scout");
    expect(scout?.status).toBe("partial");
    expect(scout?.actions.join(" ")).toContain("deadline 1791241680429 has passed");
    expect(Object.keys((out.result as { result: Record<string, unknown> }).result)).toContain("scribe");
    expect(calls).toContain("hire scribe 01");
    expect(calls.at(-1)).toBe("submit root");
  });

  // Preprod tree d14e6619: a verifier's hire failed (its crankRefund kept failing), which failed
  // the checked task's hire and the root. The other verifiers still decide the quorum.
  it("settles a checked task on the remaining verifiers' quorum when one verifier's hire fails", async () => {
    const { activities, calls } = fakeWorld(() => "deliver");
    const hire = activities.hire;
    activities.hire = async (h) => {
      if (h.spec.id === "check-c") throw ApplicationFailure.nonRetryable("Ogmios 3010: evaluation failed", "FiberFailureImpl");
      return hire(h);
    };
    const checks = (built.built.verifiers["scout"] ?? []).map((id) => ({ spec: specOf(id), candidates: [agent(3)] }));
    expect(checks).toHaveLength(3);
    const out = await run<HireOutcome>(activities, "hireWorkflow", hireInput(specOf("scout"), [agent(1)], { verifiers: checks }));
    expect(out.status).toBe("accepted");
    expect(calls).toContain("settle scout with 2 verdicts");
  });
});

describe("sub-hired subtree", () => {
  it("runs a mid-level node's children with the agent's upstream results and leaves the Submit to the agent", async () => {
    const a1 = buildPlan(
      scenarioDraft("a1-happy-path", { lookupApi: "ab".repeat(28) }),
      { goal: "juice in Dubai", asset: "lovelace", budget: "40000000", fund_by: FUND_BY, submit_by: FUND_BY + 3 * 3_600_000, max_depth: 2, reputation_floor: 0, risk: "balanced" },
      () => ({ primary: agent(1), fallbacks: [] }),
    );
    if (!a1.ok) throw new Error(a1.errors.join("; "));
    const market = a1.built.plan.root.children.find((c) => c.spec.id === "market");
    if (market === undefined) throw new Error("no market node");
    const input = subtreeWorkflowInput(a1.built.plan, specHash(market.spec), { tree_id: "aa".repeat(28), node_id: "bb".repeat(28), input: { goal: "juice in Dubai", depends_on: { scout: { competitors: [] } } } });
    expect(input?.children.map((c) => c.spec.id)).toEqual(["digest-detail", "digest-exec"]);
    expect(subtreeWorkflowInput(a1.built.plan, specHash(market.children[0]!.spec), { tree_id: "aa".repeat(28), node_id: "cc".repeat(28), input: {} })).toBeNull();

    const { activities, calls } = fakeWorld(() => "deliver");
    const inputs: Record<string, JsonValue>[] = [];
    const hire = activities.hire;
    activities.hire = (h) => (inputs.push(h.input), hire(h));
    const out = await run<NodeOutcome>(activities, "nodeWorkflow", input);
    expect(inputs.map((i) => i["depends_on"])).toEqual([{ scout: { competitors: [] } }, { scout: { competitors: [] } }]);
    expect(out.partial).toBe(false);
    expect(out.children.map((c) => c.status)).toEqual(["accepted", "accepted"]);
    expect(calls.filter((c) => c.startsWith("hire"))).toHaveLength(2);
    expect(calls).not.toContain("submit root");
  });
});
