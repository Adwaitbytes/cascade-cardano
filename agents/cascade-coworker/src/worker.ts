/**
 * The Coworker's Task state machine. Each tick advances every open Task by at most one external
 * write, journaling a `*-pending` stage before the write and the result after it. Paid Tasks follow
 * the TOKEN2049 order: signed terms, `masumiPayment` event, confirmed escrow, the work (a Cascade
 * tree), result hash on chain, Task completion, then seller collection after the unlock time.
 */
import type { CascadeRunner, RootOutcome } from "./cascade.js";
import type { CoworkerConfig, Registration } from "./config.js";
import type { Journal } from "./journal.js";
import type { MpsSeller } from "./mps.js";
import { confirmedState, confirmedTxHash, masumiPaymentPayload, newPurchaserNonce, paymentWindows, SELLER_PAID_STATES, sha256Hex, termsRequest, type PaymentWindows, type SignedTerms } from "./payment.js";
import { interpretTask, type IntakeResult } from "./intake.js";
import { renderReport } from "./report.js";
import { SokosumiError, type SokosumiClient } from "./sokosumi.js";

export type Stage =
  | "starting"
  | "started"
  | "terms-pending"
  | "terms-saved"
  | "purchase-pending"
  | "awaiting-escrow"
  | "escrow-locked"
  | "plan-pending"
  | "plan-drafted"
  | "fund-pending"
  | "tree-running"
  | "accept-pending"
  | "summarizing"
  | "result-saved"
  | "submit-pending"
  | "awaiting-result"
  | "complete-pending"
  | "awaiting-withdrawal"
  | "completed"
  | "settled"
  | "failed"
  | "blocked";

export interface TaskState {
  taskId: string;
  paid: boolean;
  stage: Stage;
  input: string;
  /** The Task's name, read with the description to infer the deliverable. */
  name?: string;
  updatedAt: number;
  log: { at: number; stage: Stage; note?: string }[];
  nonce?: string;
  windows?: PaymentWindows;
  terms?: SignedTerms;
  purchaseEventId?: string;
  escrowTx?: string | null;
  planId?: string;
  planAttempts?: number;
  planDraftedAt?: number;
  fundPendingAt?: number;
  treeId?: string;
  fundTx?: string;
  treeIndexed?: boolean;
  progressPosted?: boolean;
  outcome?: RootOutcome | null;
  acceptTx?: string | null;
  acceptAttempts?: number;
  summarizeAttempts?: number;
  /** The exact UTF-8 result: hashed for Masumi and posted as the completion comment. */
  result?: string;
  resultHash?: string;
  resultSubmitTx?: string | null;
  completionEventId?: string;
  settlement?: { txHash: string | null; receiptSettled: boolean; withdrawnState: string };
  error?: string;
}

export const CLOSED_STAGES: ReadonlySet<Stage> = new Set<Stage>(["completed", "settled", "failed", "blocked"]);
export const isOpen = (s: TaskState) => !CLOSED_STAGES.has(s.stage);

export interface WorkerDeps {
  config: CoworkerConfig;
  registration: Registration;
  sokosumi: SokosumiClient;
  mps: MpsSeller;
  cascade: CascadeRunner;
  journal: Journal;
  /** Task ids to run without payment (execution rehearsal, TOKEN2049 guide step 4, first run). */
  unpaidTaskIds: ReadonlySet<string>;
  now?: () => number;
  log?: (line: string) => void;
}

const MINUTE = 60_000;

export class CoworkerWorker {
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly d: WorkerDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`));
  }

  /** Picks up new READY Tasks, then advances every open Task one step. Errors stay per Task. */
  async tick(): Promise<void> {
    try {
      for (const task of await this.d.sokosumi.listTasks(this.d.config.coworkerId, "READY")) {
        if (this.d.journal.load(task.id) !== null) continue;
        const input = (task.description ?? "").trim() === "" ? task.name : (task.description as string);
        this.save({ taskId: task.id, paid: !this.d.unpaidTaskIds.has(task.id), stage: "starting", input, name: task.name, updatedAt: this.now(), log: [] }, "picked up");
      }
    } catch (e) {
      this.log(`listing READY Tasks failed: ${message(e)}`);
    }
    for (const state of this.d.journal.all().filter(isOpen)) {
      try {
        await this.advance(state);
      } catch (e) {
        const latest = this.d.journal.load(state.taskId) ?? state;
        this.save({ ...latest, error: message(e) }, `step failed at ${latest.stage}: ${message(e)}`);
      }
    }
  }

  private save(state: TaskState, note?: string): TaskState {
    const next: TaskState = { ...state, updatedAt: this.now(), log: [...state.log, { at: this.now(), stage: state.stage, ...(note === undefined ? {} : { note }) }].slice(-60) };
    this.d.journal.save(next);
    this.log(`task ${state.taskId} ${state.stage}${note === undefined ? "" : `: ${note}`}`);
    return next;
  }

  private intake(s: TaskState): IntakeResult {
    const description = s.name === undefined || s.input !== s.name ? s.input : null;
    return interpretTask(s.name ?? "", description, { budgetCapLovelace: this.d.config.treeBudgetLovelace, treeWindowMs: this.d.config.treeWindowMs });
  }

  private fundingBusy(except: string): boolean {
    return this.d.journal.all().some((s) => s.taskId !== except && (s.stage === "fund-pending" || (s.stage === "tree-running" && s.treeIndexed !== true)));
  }

  async advance(s: TaskState): Promise<TaskState> {
    const { config, registration, sokosumi, mps, cascade } = this.d;
    const now = this.now();
    switch (s.stage) {
      case "starting": {
        const task = await sokosumi.getTask(s.taskId);
        if (task.status === "RUNNING") return this.save({ ...s, stage: "started" }, "already RUNNING");
        if (task.status !== "READY") return this.save({ ...s, stage: "blocked", error: `Task is ${task.status}` }, `Task is ${task.status}; not started`);
        if (task.organizationId === null) {
          if (task.ownerId === undefined || task.workspace?.id === undefined) throw new Error("personal Task without owner or Workspace");
          await sokosumi.authorizePersonalWorkspace(task.ownerId, task.workspace.id);
        }
        try {
          await sokosumi.postEvent(s.taskId, { status: "RUNNING" });
        } catch (e) {
          if (e instanceof SokosumiError && e.kind !== null && e.kind.startsWith("grant_")) return this.save({ ...s, error: e.kind }, `${e.kind}: the Task owner's Workspace must approve Vendor access; retrying`);
          throw e;
        }
        return this.save({ ...s, stage: "started", error: undefined }, "RUNNING");
      }
      case "started": {
        // Refuse before any payment is requested: nothing is charged for a Task the team cannot do.
        const intake = this.intake(s);
        if (!intake.ok) {
          await sokosumi.postEvent(s.taskId, { status: "FAILED", comment: `${intake.message} Nothing was charged.` });
          return this.save({ ...s, stage: "failed", error: `intake refused: ${intake.reason}` }, `intake refused (${intake.reason})`);
        }
        const read = `understood as ${intake.notes.join("; ")}`;
        return s.paid ? this.save({ ...s, stage: "terms-pending" }, read) : this.save({ ...s, stage: "escrow-locked" }, `${read}; unpaid rehearsal: no Masumi payment`);
      }
      case "terms-pending": {
        // No purchase was posted yet, so fresh terms are always safe to request again.
        const nonce = newPurchaserNonce();
        const windows = paymentWindows(now, config.treeWindowMs);
        const terms = await mps.requestTerms(termsRequest({ registration, quote: config.quote, input: s.input, nonce, windows, taskId: s.taskId }));
        return this.save({ ...s, stage: "terms-saved", nonce, windows, terms }, `signed terms ${terms.blockchainIdentifier.slice(0, 16)}…`);
      }
      case "terms-saved": {
        if (s.terms === undefined || s.nonce === undefined) throw new Error("terms missing");
        const payload = masumiPaymentPayload({ terms: s.terms, nonce: s.nonce, registration, quote: config.quote, inputHash: sha256Hex(s.input) });
        if (now >= Number(s.terms.payByTime)) return this.save({ ...s, stage: "terms-pending" }, "terms expired before the purchase; requesting fresh terms");
        const pending = this.save({ ...s, stage: "purchase-pending" });
        const amount = `${Number(config.quote.amount) / 1_000_000} test USDM`;
        let event;
        try {
          event = await sokosumi.postEvent(s.taskId, { comment: `Payment requested: ${amount}, held in Masumi escrow until the result is delivered.`, masumiPayment: payload });
        } catch (e) {
          // A 4xx is a definite refusal (for example insufficient credits): nothing was charged, so the
          // same signed terms may be offered again. Anything else leaves purchase-pending for inspection.
          if (e instanceof SokosumiError && e.status >= 400 && e.status < 500) return this.save({ ...s, stage: "terms-saved", error: message(e) }, `Core refused the masumiPayment event (${e.status}${e.kind === null ? "" : ` ${e.kind}`})`);
          throw e;
        }
        return this.save({ ...pending, stage: "awaiting-escrow", purchaseEventId: event.id, error: undefined }, `masumiPayment event ${event.id}`);
      }
      case "purchase-pending":
        return this.save({ ...s, stage: "blocked", error: "masumiPayment event outcome unknown" }, "uncertain masumiPayment post; inspect the Task events before any retry");
      case "awaiting-escrow": {
        const terms = need(s.terms);
        const observed = await mps.resolve(terms.blockchainIdentifier);
        if (observed.onChainState === "FundsLocked" && confirmedState(observed, "FundsLocked")) {
          return this.save({ ...s, stage: "escrow-locked", escrowTx: confirmedTxHash(observed, "FundsLocked") }, "escrow FundsLocked and confirmed");
        }
        if (now > Number(terms.payByTime) + 5 * MINUTE && observed.onChainState === null) {
          await sokosumi.postEvent(s.taskId, { status: "FAILED", comment: "The Masumi escrow for this Task was not funded before its pay-by time, so no work was started and nothing was charged by the Coworker." });
          return this.save({ ...s, stage: "failed", error: "escrow not funded by payByTime" }, "escrow not funded in time");
        }
        return s;
      }
      case "escrow-locked": {
        const pending = this.save({ ...s, stage: "plan-pending" });
        const deadline = s.windows === undefined ? now + config.treeWindowMs : Math.min(now + config.treeWindowMs, s.windows.submitResult - 10 * MINUTE);
        const intake = this.intake(s);
        if (!intake.ok) {
          await sokosumi.postEvent(s.taskId, { status: "FAILED", comment: `${intake.message} ${s.paid ? "The escrowed payment returns to the buyer through Masumi after the result deadline." : ""}`.trim() });
          return this.save({ ...pending, stage: "failed", error: `intake refused: ${intake.reason}` }, `intake refused (${intake.reason})`);
        }
        // A light job starts on a smaller budget; after a failed draft it gets the configured cap.
        const budgetLovelace = (s.planAttempts ?? 0) > 0 ? config.treeBudgetLovelace : intake.budgetLovelace;
        let planId: string;
        try {
          planId = await cascade.draftPlan({ goal: intake.goal, budgetLovelace, deadline, maxDepth: intake.maxDepth, nativeOnly: intake.nativeOnly });
        } catch (e) {
          const attempts = (s.planAttempts ?? 0) + 1;
          // The signed result deadline cannot move: when no plan fits it, say so and let Masumi refund the buyer.
          if (message(e).includes("deadline too short") || attempts >= 5) {
            const why = message(e).includes("deadline too short") ? "the Cascade plan for it needs more time than this Task's signed result deadline allows" : "the Conductor could not plan it after 5 attempts";
            await sokosumi.postEvent(s.taskId, { status: "FAILED", comment: `No work was started: ${why}. ${s.paid ? "The escrowed payment returns to the buyer through Masumi after the result deadline." : ""}`.trim() });
            return this.save({ ...pending, stage: "failed", planAttempts: attempts, error: message(e) }, `planning failed: ${message(e)}`);
          }
          return this.save({ ...pending, stage: "escrow-locked", planAttempts: attempts, error: message(e) }, `planning failed (attempt ${attempts}): ${message(e)}`);
        }
        return this.save({ ...pending, stage: "plan-drafted", planId, planDraftedAt: now, error: undefined }, `plan ${planId}`);
      }
      case "plan-pending":
        // A drafted but unfunded plan simply expires, so drafting again is safe.
        return this.save({ ...s, stage: "escrow-locked" }, "plan draft outcome unknown; drafting again");
      case "plan-drafted": {
        if (this.fundingBusy(s.taskId)) return s;
        const pending = this.save({ ...s, stage: "fund-pending", fundPendingAt: now });
        const { treeId, fundTx } = await cascade.fund(need(s.planId));
        return this.save({ ...pending, stage: "tree-running", treeId, fundTx }, `FundRoot ${fundTx} tree ${treeId}`);
      }
      case "fund-pending": {
        const plan = await cascade.planStatus(need(s.planId));
        if (plan.status === "funded" && plan.tree_id !== null) return this.save({ ...s, stage: "tree-running", treeId: plan.tree_id, treeIndexed: true }, "FundRoot found on chain");
        if (plan.status === "expired") return this.save({ ...s, stage: "escrow-locked" }, "plan expired unfunded; drafting again");
        if (now - (s.fundPendingAt ?? now) > 10 * MINUTE) return this.save({ ...s, stage: "plan-drafted" }, "FundRoot not seen for 10 minutes; building it again");
        return s;
      }
      case "tree-running": {
        const treeId = need(s.treeId);
        if (s.treeIndexed !== true) {
          const plan = await cascade.planStatus(need(s.planId));
          if (plan.status !== "funded") return s;
          s = this.save({ ...s, treeIndexed: true }, "tree funded and indexed; agents are being hired");
        }
        if (s.progressPosted !== true) {
          await sokosumi.postEvent(s.taskId, { comment: `Working: Cascade funded an escrow tree for this Task and is hiring agents now. Watch it live: ${config.publicSite}/tree/${treeId}` }).catch((e: unknown) => this.log(`progress comment failed: ${message(e)}`));
          s = this.save({ ...s, progressPosted: true });
        }
        const outcome = await cascade.rootOutcome(treeId);
        if (outcome !== null) return this.save({ ...s, stage: "accept-pending", outcome, acceptAttempts: 0 }, `root delivered${outcome.partial ? " (partial)" : ""}`);
        if (s.windows !== undefined && now > s.windows.submitResult - 8 * MINUTE) {
          return this.save({ ...s, stage: "summarizing", outcome: null, acceptTx: null, summarizeAttempts: 0, error: "tree still running at the result deadline" }, "result deadline near; reporting what the tree has done so far");
        }
        return s;
      }
      case "accept-pending": {
        try {
          const acceptTx = await cascade.acceptRoot(need(s.treeId));
          return this.save({ ...s, stage: "summarizing", acceptTx, summarizeAttempts: 0 }, `root Accept ${acceptTx}`);
        } catch (e) {
          const attempts = (s.acceptAttempts ?? 0) + 1;
          if (attempts >= 6) return this.save({ ...s, stage: "summarizing", acceptTx: null, summarizeAttempts: 0 }, `root Accept skipped after ${attempts} tries: ${message(e)}`);
          return this.save({ ...s, acceptAttempts: attempts }, `root Accept not ready yet: ${message(e)}`);
        }
      }
      case "summarizing": {
        const treeId = need(s.treeId);
        const [tree, receipt] = await Promise.all([cascade.tree(treeId), cascade.receipt(treeId).catch(() => null)]);
        const attempts = (s.summarizeAttempts ?? 0) + 1;
        const root = tree.nodes.find((n) => n.node_id === treeId);
        const acceptIndexed = s.acceptTx === null || s.acceptTx === undefined || root?.tx_ids.includes(s.acceptTx) === true;
        if (!acceptIndexed && attempts < 10) return this.save({ ...s, summarizeAttempts: attempts });
        const intake = this.intake(s);
        const result = renderReport({
          goal: s.input.trim(),
          ...(intake.ok ? { title: intake.title } : {}),
          treeId,
          outcome: s.outcome ?? null,
          tree,
          receipt,
          fundTx: need(s.fundTx),
          acceptTx: s.acceptTx ?? null,
          site: config.publicSite,
          masumi: s.terms === undefined ? null : { blockchainIdentifier: s.terms.blockchainIdentifier, lockTx: s.escrowTx ?? null },
          ...(s.outcome === null ? { failure: "The tree had not delivered by this Task's result deadline. What it did so far, and every refund, is on chain at the links below." } : {}),
        });
        return this.save({ ...s, stage: "result-saved", result, resultHash: sha256Hex(result) }, `result saved (${Buffer.byteLength(result)} bytes, sha256 ${sha256Hex(result).slice(0, 12)}…)`);
      }
      case "result-saved": {
        if (!s.paid) return this.save({ ...s, stage: "complete-pending" });
        const terms = need(s.terms);
        if (now >= Number(terms.submitResultTime)) return this.save({ ...s, stage: "failed", error: "result ready after submitResultTime" }, "missed the signed result deadline; the buyer is refunded by Masumi");
        const pending = this.save({ ...s, stage: "submit-pending" });
        await mps.submitResult(terms.blockchainIdentifier, need(s.resultHash));
        return this.save({ ...pending, stage: "awaiting-result" }, "result hash sent to MPS");
      }
      case "submit-pending": {
        const observed = await mps.resolve(need(s.terms).blockchainIdentifier);
        if (observed.resultHash === s.resultHash || observed.NextAction?.requestedAction === "SubmitResultRequested") return this.save({ ...s, stage: "awaiting-result" }, "MPS holds the result hash");
        return this.save({ ...s, stage: "result-saved" }, "MPS has no result hash; sending it again");
      }
      case "awaiting-result": {
        const observed = await mps.resolve(need(s.terms).blockchainIdentifier);
        if (observed.onChainState === "ResultSubmitted" && observed.resultHash === s.resultHash && confirmedState(observed, "ResultSubmitted")) {
          return this.save({ ...s, stage: "complete-pending", resultSubmitTx: confirmedTxHash(observed, "ResultSubmitted") }, "result hash confirmed on chain");
        }
        if (observed.NextAction?.errorType) return this.save({ ...s, error: `${observed.NextAction.errorType}: ${observed.NextAction.errorNote ?? ""}` }, "MPS reports an error on SubmitResult");
        return s;
      }
      case "complete-pending": {
        const task = await sokosumi.getTask(s.taskId);
        if (task.status === "COMPLETED") return this.save({ ...s, stage: s.paid ? "awaiting-withdrawal" : "completed" }, "Task already COMPLETED");
        const event = await sokosumi.postEvent(s.taskId, { status: "COMPLETED", comment: need(s.result) });
        return this.save({ ...s, stage: s.paid ? "awaiting-withdrawal" : "completed", completionEventId: event.id }, `COMPLETED event ${event.id}`);
      }
      case "awaiting-withdrawal": {
        const observed = await mps.resolve(need(s.terms).blockchainIdentifier);
        const state = observed.onChainState ?? "null";
        if (!(SELLER_PAID_STATES as readonly string[]).includes(state)) return s;
        const receipt = await sokosumi.receipt(s.taskId).catch(() => null);
        const txHash = confirmedTxHash(observed, state);
        return this.save({ ...s, stage: "settled", settlement: { txHash, receiptSettled: receipt?.settled === true, withdrawnState: state } }, `seller collected: ${state} ${txHash ?? ""}`);
      }
      default:
        return s;
    }
  }
}

function need<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error("journal is missing a value this stage needs");
  return v;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);
