import type { Quote } from "@cascade/shared/browser";
import type { JobRecord } from "./types.js";
import type { JobStatus } from "./status.js";

export class JobNotFoundError extends Error {
  constructor(readonly jobId: string) {
    super(`job ${jobId} does not exist`);
    this.name = "JobNotFoundError";
  }
}

export class DuplicateJobError extends Error {
  constructor(readonly key: string) {
    super(`a job already exists for ${key}`);
    this.name = "DuplicateJobError";
  }
}

/**
 * Durable job and quote store. `update` is atomic per job: the mutator sees the latest record and
 * its result is written as one unit, so concurrent status changes cannot interleave.
 */
export interface JobStore {
  create(job: JobRecord): Promise<void>;
  get(jobId: string): Promise<JobRecord | null>;
  update(jobId: string, mutate: (job: JobRecord) => JobRecord): Promise<JobRecord>;
  findByPaymentKey(paymentKey: string): Promise<JobRecord | null>;
  findByNode(treeId: string, nodeId: string): Promise<JobRecord | null>;
  listByStatus(statuses: readonly JobStatus[]): Promise<JobRecord[]>;
  putQuote(quote: Quote): Promise<void>;
  getQuote(quoteId: string): Promise<Quote | null>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly quotes = new Map<string, Quote>();

  async create(job: JobRecord): Promise<void> {
    if (this.jobs.has(job.job_id)) throw new DuplicateJobError(job.job_id);
    const key = job.payment.payment_key;
    if (key !== null && [...this.jobs.values()].some((j) => j.payment.payment_key === key)) throw new DuplicateJobError(key);
    this.jobs.set(job.job_id, clone(job));
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const job = this.jobs.get(jobId);
    return job === undefined ? null : clone(job);
  }

  async update(jobId: string, mutate: (job: JobRecord) => JobRecord): Promise<JobRecord> {
    const current = this.jobs.get(jobId);
    if (current === undefined) throw new JobNotFoundError(jobId);
    const next = mutate(clone(current));
    this.jobs.set(jobId, clone(next));
    return clone(next);
  }

  async findByPaymentKey(paymentKey: string): Promise<JobRecord | null> {
    for (const job of this.jobs.values()) if (job.payment.payment_key === paymentKey) return clone(job);
    return null;
  }

  async findByNode(treeId: string, nodeId: string): Promise<JobRecord | null> {
    for (const job of this.jobs.values()) if (job.node?.tree_id === treeId && job.node.node_id === nodeId) return clone(job);
    return null;
  }

  async listByStatus(statuses: readonly JobStatus[]): Promise<JobRecord[]> {
    return [...this.jobs.values()].filter((j) => statuses.includes(j.status)).map(clone);
  }

  async putQuote(quote: Quote): Promise<void> {
    this.quotes.set(quote.quote_id, clone(quote));
  }

  async getQuote(quoteId: string): Promise<Quote | null> {
    const quote = this.quotes.get(quoteId);
    return quote === undefined ? null : clone(quote);
  }
}
