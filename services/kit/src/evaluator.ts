/**
 * Script evaluation across the providers a network already has (Blockfrost `utils/txs/evaluate`,
 * then Ogmios or Koios' `/ogmios` proxy). A provider that is rate limiting, down, or answering
 * garbage tells us nothing about the transaction, so those failures are retried and failed over;
 * only a real evaluation answer (an Ogmios JSON-RPC error about the scripts) is final.
 */
import { OgmiosError, OgmiosTransportError, parseJsonLossless, type EvaluationResult } from "./ogmios.js";

/** Every configured evaluation provider failed for transport reasons; the caller may retry later. */
export class EvaluatorUnavailableError extends Error {
  override readonly name = "EvaluatorUnavailableError";
}

export interface TxEvaluator {
  readonly name: string;
  evaluate(cborHex: string): Promise<EvaluationResult[]>;
}

/**
 * JSON-RPC internal and server errors (-32603, -32000..-32099) come from the provider, not the
 * ledger; every other Ogmios error code is an answer about the transaction.
 */
export function isEvaluatorTransportFailure(e: unknown): boolean {
  if (e instanceof OgmiosTransportError) return true;
  if (e instanceof OgmiosError) return e.code === -32603 || (e.code <= -32000 && e.code >= -32099);
  return false;
}

/** Blockfrost's evaluator in Ogmios v6 response form (`?version=6`). */
export class BlockfrostEvaluator implements TxEvaluator {
  readonly name = "blockfrost";
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly url: string,
    private readonly projectId: string | null,
    options: { fetch?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async evaluate(cborHex: string): Promise<EvaluationResult[]> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.url.replace(/\/+$/, "")}/utils/txs/evaluate?version=6`, {
        method: "POST",
        headers: { "content-type": "application/cbor", ...(this.projectId === null ? {} : { project_id: this.projectId }) },
        body: cborHex,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new OgmiosTransportError(`blockfrost evaluate: ${(e as Error).message}`);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = parseJsonLossless(text);
    } catch {
      throw new OgmiosTransportError(`blockfrost evaluate: HTTP ${res.status} with a non-JSON body`);
    }
    const msg = body as { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
    if (msg.error !== undefined && typeof msg.error.code === "number") {
      throw new OgmiosError("evaluateTransaction", msg.error.code, String(msg.error.message ?? ""), msg.error.data);
    }
    // Blockfrost's own errors (402 quota, 403, 429, 5xx, and 400 it raises before evaluating) carry no JSON-RPC body.
    if (!res.ok || !Array.isArray(msg.result)) throw new OgmiosTransportError(`blockfrost evaluate: HTTP ${res.status} without an evaluation result`);
    return (msg.result as Array<{ validator: { purpose: string; index: number }; budget: { memory: unknown; cpu: unknown } }>).map((r) => ({
      validator: r.validator,
      budget: { memory: BigInt(r.budget.memory as bigint | number | string), cpu: BigInt(r.budget.cpu as bigint | number | string) },
    }));
  }
}

/** A token bucket shared by every evaluation call of one process, so retries never burst a provider. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (capacity < 1 || refillPerSecond <= 0) throw new RangeError("token bucket needs capacity >= 1 and a positive refill rate");
    this.tokens = capacity;
    this.last = now();
  }

  /** Resolves once a token is taken. Waiters are served in arrival order. */
  take(): Promise<void> {
    const turn = this.queue.then(() => this.takeNow());
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async takeNow(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSecond);
      this.last = t;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000));
    }
  }
}

export interface ResilientEvaluatorOptions {
  /** Passes over all providers before giving up (default 3). */
  rounds?: number;
  /** Backoff before the second pass; doubles each pass (default 1 s). */
  initialBackoffMs?: number;
  bucket?: TokenBucket;
  sleep?: (ms: number) => Promise<void>;
  onFailure?: (provider: string, message: string) => void;
}

/**
 * Tries providers healthiest first (fewest consecutive transport failures, then configured order).
 * A transport failure moves on to the next provider; an evaluation answer is returned or thrown as is.
 */
export class ResilientEvaluator implements TxEvaluator {
  readonly name = "resilient";
  private readonly failures = new Map<string, number>();
  private readonly bucket: TokenBucket;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly providers: readonly TxEvaluator[],
    private readonly options: ResilientEvaluatorOptions = {},
  ) {
    if (providers.length === 0) throw new RangeError("at least one evaluation provider is required");
    this.bucket = options.bucket ?? new TokenBucket(5, 2);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async evaluate(cborHex: string): Promise<EvaluationResult[]> {
    const rounds = this.options.rounds ?? 3;
    let backoff = this.options.initialBackoffMs ?? 1_000;
    const seen: string[] = [];
    for (let round = 0; round < rounds; round++) {
      if (round > 0) {
        await this.sleep(backoff);
        backoff *= 2;
      }
      const order = this.providers.map((p, i) => ({ p, i })).sort((a, b) => (this.failures.get(a.p.name) ?? 0) - (this.failures.get(b.p.name) ?? 0) || a.i - b.i);
      for (const { p } of order) {
        await this.bucket.take();
        try {
          const r = await p.evaluate(cborHex);
          this.failures.set(p.name, 0);
          return r;
        } catch (e) {
          if (!isEvaluatorTransportFailure(e)) {
            this.failures.set(p.name, 0);
            throw e;
          }
          this.failures.set(p.name, (this.failures.get(p.name) ?? 0) + 1);
          const message = (e as Error).message.slice(0, 200);
          seen.push(`${p.name}: ${message}`);
          this.options.onFailure?.(p.name, message);
        }
      }
    }
    throw new EvaluatorUnavailableError(`evaluator_unavailable: every evaluation provider failed (${seen.slice(-this.providers.length).join("; ")})`);
  }
}

/** An Ogmios endpoint (our own, or Koios' `/ogmios` proxy) as an evaluation provider. */
export function ogmiosEvaluator(name: string, client: { evaluate(cborHex: string): Promise<EvaluationResult[]> }): TxEvaluator {
  return { name, evaluate: (cborHex) => client.evaluate(cborHex) };
}
