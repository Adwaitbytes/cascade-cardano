import { describe, expect, it } from "vitest";
import type { CascadeRunner, RootOutcome } from "../src/cascade.js";
import { TUSDM_PREPROD, type CoworkerConfig } from "../src/config.js";
import { memoryJournal } from "../src/journal.js";
import type { MpsSeller } from "../src/mps.js";
import { sha256Hex, type ObservedPayment, type TermsRequest } from "../src/payment.js";
import { SokosumiError, type SokosumiClient, type SokosumiTask, type TaskEventBody } from "../src/sokosumi.js";
import { CoworkerWorker, type TaskState } from "../src/worker.js";
import { registration, terms } from "./fixtures.js";

const TREE = "a".repeat(56);
const config: CoworkerConfig = {
  coworkerId: "cw",
  quote: { amount: "1000000", unit: TUSDM_PREPROD },
  mpsUrl: "http://mps",
  conductorUrl: "http://conductor",
  indexerUrl: "http://indexer",
  temporalAddress: "t",
  temporalNamespace: "n",
  dataDir: "/unused",
  treeBudgetLovelace: "80000000",
  treeWindowMs: 75 * 60_000,
  pollMs: 1,
  port: 0,
  publicSite: "https://site",
};
const outcome: RootOutcome = { node_id: TREE, result: { result: { brief: { brief: "The brief.", summary: "Short." } }, children: ["brief"], partial: false }, result_hash: "c".repeat(64), partial: false, children: [] };

function harness(opts: { unpaid?: boolean; startError?: SokosumiError } = {}) {
  const calls: string[] = [];
  const events: TaskEventBody[] = [];
  let taskStatus = "READY";
  let observed: ObservedPayment = { blockchainIdentifier: "signed-id", onChainState: null };
  let submittedHash: string | null = null;
  let termsBody: TermsRequest | null = null;
  const task = (): SokosumiTask => ({ id: "task-1", name: "Brief", description: "Market-entry brief for Dubai", status: taskStatus, ownerId: "owner", organizationId: null, workspace: { id: "ws", organizationId: null } });
  const sokosumi: SokosumiClient = {
    listTasks: async () => (taskStatus === "READY" ? [task()] : []),
    getTask: async () => task(),
    authorizePersonalWorkspace: async () => void calls.push("authorize"),
    postEvent: async (_id, body) => {
      if ("status" in body && body.status === "RUNNING" && opts.startError !== undefined) throw opts.startError;
      events.push(body);
      calls.push(`event:${"masumiPayment" in body ? "masumiPayment" : "status" in body ? body.status : "comment"}`);
      if ("status" in body) taskStatus = body.status;
      return { id: `ev-${events.length}`, status: "status" in body ? body.status : null };
    },
    receipt: async () => ({ settled: true, txHash: "w".repeat(64) }),
  };
  const mps: MpsSeller = {
    requestTerms: async (body) => {
      termsBody = body;
      calls.push("mps:terms");
      return terms({ inputHash: body.inputHash, payByTime: String(Date.parse(body.payByTime)), submitResultTime: String(Date.parse(body.submitResultTime)) });
    },
    resolve: async () => observed,
    submitResult: async (_b, hash) => {
      submittedHash = hash;
      calls.push("mps:submit");
    },
  };
  let rootReady = false;
  const cascade: CascadeRunner = {
    draftPlan: async () => (calls.push("cascade:plan"), "plan-1"),
    planStatus: async () => ({ status: "funded", tree_id: TREE }),
    fund: async () => (calls.push("cascade:fund"), { treeId: TREE, fundTx: "f".repeat(64) }),
    rootOutcome: async () => (rootReady ? outcome : null),
    acceptRoot: async () => (calls.push("cascade:accept"), "e".repeat(64)),
    tree: async () => ({ tree_id: TREE, asset: "lovelace", root_budget: "80000000", state: "open", nodes: [{ node_id: TREE, parent_id: null, depth: 0, kind: "Native", agent_name: "Cascade Conductor", state: "Accepted", budget: "80000000", fee: "8000000", tx_ids: ["e".repeat(64)] }] }),
    receipt: async () => ({ tree_id: TREE, deposits: { asset: "lovelace", amount: "80000000" }, payouts: { asset: "lovelace", amount: "8000000" }, refunds: { asset: "lovelace", amount: "0" }, balanced: true, lines: [] }),
  };
  const journal = memoryJournal();
  const worker = new CoworkerWorker({ config, registration, sokosumi, mps, cascade, journal, unpaidTaskIds: new Set(opts.unpaid === true ? ["task-1"] : []), log: () => undefined });
  return {
    worker,
    journal,
    calls,
    events,
    state: () => journal.load("task-1") as TaskState,
    setObserved: (o: Partial<ObservedPayment>) => void (observed = { ...observed, ...o }),
    rootReady: () => void (rootReady = true),
    submitted: () => submittedHash,
    termsBody: () => termsBody,
    ticks: async (n: number) => {
      for (let i = 0; i < n; i++) await worker.tick();
    },
  };
}

const confirmed = (state: string, txHash: string) => ({ onChainState: state, CurrentTransaction: { status: "Confirmed", newOnChainState: state, txHash } });

describe("paid Task", () => {
  it("follows the TOKEN2049 order and completes with the exact text whose hash went on chain", async () => {
    const h = harness();
    await h.ticks(4);
    expect(h.state().stage).toBe("awaiting-escrow");
    expect(h.calls).toEqual(["authorize", "event:RUNNING", "mps:terms", "event:masumiPayment"]);
    expect(h.termsBody()?.inputHash).toBe(sha256Hex("Market-entry brief for Dubai"));
    const purchase = h.events.find((e) => "masumiPayment" in e);
    expect(purchase !== undefined && "masumiPayment" in purchase ? purchase.masumiPayment.blockchainIdentifier : null).toBe("signed-id");

    await h.ticks(2);
    expect(h.calls).not.toContain("cascade:plan");
    h.setObserved(confirmed("FundsLocked", "1".repeat(64)));
    await h.ticks(4);
    expect(h.state().stage).toBe("tree-running");
    expect(h.state().escrowTx).toBe("1".repeat(64));
    h.rootReady();
    await h.ticks(4);
    expect(h.state().stage).toBe("awaiting-result");
    const result = h.state().result as string;
    expect(result).toContain("The brief.");
    expect(h.submitted()).toBe(sha256Hex(result));
    expect(h.calls).not.toContain("event:COMPLETED");

    h.setObserved({ ...confirmed("ResultSubmitted", "2".repeat(64)), resultHash: sha256Hex(result) });
    await h.ticks(2);
    expect(h.state().stage).toBe("awaiting-withdrawal");
    const completion = h.events.find((e) => "status" in e && e.status === "COMPLETED");
    expect(completion !== undefined && "comment" in completion ? completion.comment : null).toBe(result);

    h.setObserved(confirmed("Withdrawn", "3".repeat(64)));
    await h.ticks(1);
    expect(h.state().stage).toBe("settled");
    expect(h.state().settlement).toEqual({ txHash: "3".repeat(64), receiptSettled: true, withdrawnState: "Withdrawn" });
    expect(h.calls.filter((c) => c === "event:masumiPayment")).toHaveLength(1);
  });

  it("never reposts a masumiPayment whose outcome is unknown", async () => {
    const h = harness();
    await h.ticks(3);
    h.journal.save({ ...h.state(), stage: "purchase-pending" });
    await h.ticks(3);
    expect(h.state().stage).toBe("blocked");
    expect(h.calls.filter((c) => c === "event:masumiPayment")).toHaveLength(0);
  });

  it("fails the Task without doing the work when escrow is never funded", async () => {
    const h = harness();
    await h.ticks(4);
    h.journal.save({ ...h.state(), terms: terms({ payByTime: String(Date.now() - 6 * 60_000) }) });
    await h.ticks(1);
    expect(h.state().stage).toBe("failed");
    expect(h.calls).toContain("event:FAILED");
    expect(h.calls).not.toContain("cascade:plan");
  });

  it("keeps waiting while the Task owner has not granted Vendor access", async () => {
    const h = harness({ startError: new SokosumiError("403", 403, "grant_required") });
    await h.ticks(3);
    expect(h.state().stage).toBe("starting");
    expect(h.state().error).toBe("grant_required");
  });
});

describe("unpaid rehearsal", () => {
  it("runs the tree and completes without any Masumi call", async () => {
    const h = harness({ unpaid: true });
    h.rootReady();
    await h.ticks(10);
    expect(h.state().stage).toBe("completed");
    expect(h.calls.some((c) => c.startsWith("mps:"))).toBe(false);
    expect(h.calls).toEqual(["authorize", "event:RUNNING", "cascade:plan", "cascade:fund", "event:comment", "cascade:accept", "event:COMPLETED"]);
  });
});

describe("refused purchase", () => {
  it("goes back to the signed terms when Core refuses the masumiPayment event", async () => {
    const h = harness();
    await h.ticks(3);
    const refusing = new CoworkerWorker({
      config,
      registration,
      sokosumi: { ...stubSokosumi(), postEvent: async () => Promise.reject(new SokosumiError("422", 422, "insufficient_balance")) },
      mps: { requestTerms: async () => terms(), resolve: async () => ({ blockchainIdentifier: "x", onChainState: null }), submitResult: async () => undefined },
      cascade: {} as CascadeRunner,
      journal: h.journal,
      unpaidTaskIds: new Set(),
      log: () => undefined,
    });
    await refusing.advance(h.state());
    expect(h.state().stage).toBe("terms-saved");
    expect(h.state().error).toContain("422");
  });
});

function stubSokosumi(): SokosumiClient {
  return {
    listTasks: async () => [],
    getTask: async () => Promise.reject(new Error("unused")),
    authorizePersonalWorkspace: async () => undefined,
    postEvent: async () => ({ id: "e" }),
    receipt: async () => ({ settled: false }),
  };
}

describe("planning that cannot fit", () => {
  it("fails the Task honestly instead of retrying forever", async () => {
    const h = harness({ unpaid: true });
    const worker = new CoworkerWorker({
      config,
      registration,
      sokosumi: { ...stubSokosumi(), postEvent: async (_id, body) => (h.events.push(body), { id: "e" }) },
      mps: { requestTerms: async () => terms(), resolve: async () => ({ blockchainIdentifier: "x", onChainState: null }), submitResult: async () => undefined },
      cascade: { draftPlan: async () => Promise.reject(new Error("planning_failed: deadline too short: this plan needs submit_by >= X")) } as unknown as CascadeRunner,
      journal: h.journal,
      unpaidTaskIds: new Set(["task-1"]),
      log: () => undefined,
    });
    h.journal.save({ taskId: "task-1", paid: false, stage: "escrow-locked", input: "goal text", updatedAt: 0, log: [] });
    await worker.advance(h.state());
    expect(h.state().stage).toBe("failed");
    expect(h.events.at(-1)).toMatchObject({ status: "FAILED" });
  });
});
