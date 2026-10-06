/**
 * Runs job handlers: status transitions, `awaiting_input` round trips, timeouts, output schema
 * validation, result hashing and the evidence journal.
 */
import { jcs, jcsSha256Hex } from "@cascade/shared/browser";
import type { Mip003InputSchema } from "./input-schema.js";
import { mip004OutputHash, resultHash } from "./mip004.js";
import type { SchemaCheck } from "./schema-validator.js";
import { assertTransition, type JobStatus } from "./status.js";
import type { StartJobPayments } from "./start-job-payments.js";
import type { JobStore } from "./store.js";
import type { JobRecord, JournalEntry, JsonValue, Source, SubtreeChild, ToolLogEntry } from "./types.js";

export interface JobContext {
  readonly jobId: string;
  readonly identifierFromPurchaser: string;
  readonly inputHash: string;
  readonly node: JobRecord["node"];
  /** Aborted when the job times out or the server shuts down. */
  readonly signal: AbortSignal;
  /** Records a tool or LLM call by the hashes of its input and output. */
  log(entry: Omit<ToolLogEntry, "at">): void;
  addSource(source: Source): void;
  /** Moves the job to `awaiting_input` and resolves with validated input from `/provide_input`. */
  requestInput(schema: Mip003InputSchema): Promise<Record<string, JsonValue>>;
  /** Upserts a child node this agent hired, for `/cascade/subtree`. */
  reportChild(child: SubtreeChild): void;
}

export interface HandlerResult {
  result: JsonValue;
  sources?: Source[];
}

export type JobHandler = (input: Record<string, JsonValue>, ctx: JobContext) => Promise<HandlerResult>;

export interface RunnerOptions {
  store: JobStore;
  handler: JobHandler;
  checkOutput: (value: unknown) => SchemaCheck;
  timeoutMs: number;
  now: () => number;
  startJobPayments?: StartJobPayments;
  onError?: (jobId: string, error: unknown) => void;
  /** Agent label (e.g. a test agent notice) prefixed to every failure reason. */
  notice?: string;
  /**
   * Runs after the result passes the output schema and before the job is marked completed: for a
   * job bound to a tree node, the agent's on-chain Submit of `result_hash`. Returns the tx id.
   */
  onResult?: (job: JobRecord, resultHash: string) => Promise<string | null>;
}

const MAX_ERROR_CHARS = 500;

export function journal(job: JobRecord, at: number, event: string, detail?: JournalEntry["detail"]): JournalEntry[] {
  const entry: JournalEntry = detail === undefined ? { seq: job.journal.length, at, event } : { seq: job.journal.length, at, event, detail };
  return [...job.journal, entry];
}

export function transition(job: JobRecord, to: JobStatus, at: number, detail?: JournalEntry["detail"]): JobRecord {
  assertTransition(job.status, to);
  return { ...job, status: to, updated_at: at, journal: journal(job, at, `status.${to}`, detail) };
}

export const toolLogHash = (job: Pick<JobRecord, "tool_log">): string => jcsSha256Hex(job.tool_log);
export const journalHash = (job: Pick<JobRecord, "journal">): string => jcsSha256Hex(job.journal);

interface PendingInput {
  schema: Mip003InputSchema;
  resolve: (data: Record<string, JsonValue>) => void;
  reject: (e: Error) => void;
}

export class JobRunner {
  private readonly pendingInput = new Map<string, PendingInput>();
  private readonly running = new Map<string, AbortController>();
  private readonly settled = new Map<string, Promise<void>>();

  constructor(private readonly options: RunnerOptions) {}

  /** Starts the handler in the background. The returned promise settles when the job is terminal. */
  start(jobId: string): Promise<void> {
    const existing = this.settled.get(jobId);
    if (existing !== undefined) return existing;
    const done = this.run(jobId).catch((e: unknown) => this.options.onError?.(jobId, e));
    this.settled.set(jobId, done);
    return done;
  }

  /** Waits for a started job (tests and graceful shutdown). */
  async whenDone(jobId: string): Promise<void> {
    await this.settled.get(jobId);
  }

  isAwaitingInput(jobId: string): boolean {
    return this.pendingInput.has(jobId);
  }

  /** Hands validated input to a waiting handler. Returns false when no handler in this process waits. */
  provideInput(jobId: string, data: Record<string, JsonValue>): boolean {
    const pending = this.pendingInput.get(jobId);
    if (pending === undefined) return false;
    this.pendingInput.delete(jobId);
    pending.resolve(data);
    return true;
  }

  shutdown(): void {
    for (const controller of this.running.values()) controller.abort(new Error("agent shutting down"));
  }

  private async fail(jobId: string, why: string): Promise<void> {
    const at = this.options.now();
    const notice = this.options.notice;
    const reason = notice === undefined || why.includes(notice) ? why : `${notice} ${why}`;
    await this.options.store.update(jobId, (job) =>
      job.status === "completed" || job.status === "failed" ? job : { ...transition(job, "failed", at, { reason: reason.slice(0, MAX_ERROR_CHARS) }), error: reason.slice(0, MAX_ERROR_CHARS) },
    );
  }

  private async run(jobId: string): Promise<void> {
    const { store, now } = this.options;
    const job = await store.update(jobId, (j) => transition(j, "running", now()));
    const controller = new AbortController();
    this.running.set(jobId, controller);
    const timer = setTimeout(() => controller.abort(new Error(`job exceeded ${this.options.timeoutMs} ms`)), this.options.timeoutMs);
    const toolLog: ToolLogEntry[] = [];
    const sources: Source[] = [];
    let writes = Promise.resolve();
    const queue = (mutate: (j: JobRecord) => JobRecord): void => {
      writes = writes.then(() => store.update(jobId, mutate).then(() => undefined));
    };

    const ctx: JobContext = {
      jobId,
      identifierFromPurchaser: job.identifier_from_purchaser,
      inputHash: job.input_hash,
      node: job.node,
      signal: controller.signal,
      log: (entry) => {
        const full = { ...entry, at: now() };
        toolLog.push(full);
        queue((j) => ({ ...j, tool_log: [...j.tool_log, full], updated_at: full.at }));
      },
      addSource: (source) => {
        sources.push(source);
      },
      requestInput: async (schema) => {
        await writes;
        await store.update(jobId, (j) => ({ ...transition(j, "awaiting_input", now()), awaiting_input_schema: schema }));
        const data = await new Promise<Record<string, JsonValue>>((resolve, reject) => {
          this.pendingInput.set(jobId, { schema, resolve, reject });
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason as Error), { once: true });
        });
        await store.update(jobId, (j) => ({ ...transition(j, "running", now(), { input: "provided" }), awaiting_input_schema: null }));
        return data;
      },
      reportChild: (child) => {
        queue((j) => ({ ...j, children: [...j.children.filter((c) => c.node_id !== child.node_id), child], updated_at: now() }));
      },
    };

    try {
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason as Error), { once: true });
      });
      const out = await Promise.race([this.options.handler(job.input_data, ctx), aborted]);
      await writes;
      const check = this.options.checkOutput(out.result);
      if (!check.ok) {
        await this.fail(jobId, `result does not match the output schema: ${check.errors.join("; ")}`);
        return;
      }
      const hash = resultHash(out.result);
      if (this.options.onResult !== undefined) {
        const current = await store.get(jobId);
        if (current === null) throw new Error(`job ${jobId} vanished`);
        const txId = await this.options.onResult(current, hash);
        if (txId !== null) await store.update(jobId, (j) => ({ ...j, journal: journal(j, now(), "chain.submitted", { tx_id: txId, result_hash: hash }) }));
      }
      const completed = await store.update(jobId, (j) => ({
        ...transition(j, "completed", now(), { result_hash: hash }),
        result: out.result,
        result_hash: hash,
        sources: [...sources, ...(out.sources ?? [])],
      }));
      await this.submitToMasumi(completed);
    } catch (e) {
      await writes.catch(() => undefined);
      await this.fail(jobId, e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
      this.running.delete(jobId);
      this.pendingInput.delete(jobId);
    }
  }

  /** Masumi-paid jobs report the MIP-004 output hash of the canonical result text. */
  private async submitToMasumi(job: JobRecord): Promise<void> {
    const backend = this.options.startJobPayments;
    const id = job.payment.blockchain_identifier;
    if (backend === undefined || job.payment.channel !== "masumi" || id === null || job.result === null) return;
    const hash = mip004OutputHash(job.identifier_from_purchaser, jcs(job.result));
    try {
      await backend.submitResult(id, hash);
      await this.options.store.update(job.job_id, (j) => ({ ...j, journal: journal(j, this.options.now(), "masumi.result_submitted", { submit_result_hash: hash }) }));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await this.options.store.update(job.job_id, (j) => ({ ...j, journal: journal(j, this.options.now(), "masumi.submit_failed", { reason: reason.slice(0, MAX_ERROR_CHARS) }) }));
      this.options.onError?.(job.job_id, e);
    }
  }
}
