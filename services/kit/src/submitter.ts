/**
 * Transaction submission across the providers a network already has (Blockfrost `tx/submit`, then
 * Ogmios or Koios' `/ogmios` proxy). A provider that is out of quota, rate limiting or down says
 * nothing about the transaction, so it is failed over, never reported as a rejection.
 *
 * Resubmitting a transaction is harmless (same id, the ledger applies it once). The one trap is a
 * provider that may have relayed it before failing (timeout, 5xx): a later "inputs already spent"
 * from the next provider could then be our own transaction, so after such a failure a rejection is
 * reported as an unknown outcome instead of a definitive one.
 */
import { OgmiosError, OgmiosTransportError, isDefinitiveRejection } from "./ogmios.js";

export interface TxSubmitter {
  readonly name: string;
  /** Resolves to the transaction id once a provider accepted the transaction. */
  submit(cborHex: string): Promise<string>;
}

/** A provider refused the transaction itself (Blockfrost HTTP 400): final, never retried. */
export class SubmitRejectedError extends Error {
  override readonly name = "SubmitRejectedError";
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Every provider failed for transport reasons. `relayed` is "no" when each failure proves the
 * transaction never reached a node (quota, rate limit, auth), so the caller may submit again;
 * "maybe" when a provider might have relayed it, so the caller must observe instead.
 */
export class SubmitUnavailableError extends Error {
  override readonly name = "SubmitUnavailableError";
  constructor(
    message: string,
    readonly relayed: "no" | "maybe",
  ) {
    super(message);
  }
}

/** HTTP answers that prove the provider turned the request away before any node saw it. */
const NOT_RELAYED_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 404, 405, 418, 425, 429]);

export function isDefinitiveSubmitRejection(e: unknown): boolean {
  return e instanceof SubmitRejectedError || isDefinitiveRejection(e);
}

/** True when the error proves the transaction was not relayed (a refusal by the provider, not the ledger). */
export function provedNotRelayed(e: unknown): boolean {
  return e instanceof OgmiosTransportError && e.status !== undefined && NOT_RELAYED_STATUSES.has(e.status);
}

/** Blockfrost's submit endpoint: raw CBOR bytes in, the transaction id as a JSON string out. */
export class BlockfrostSubmitter implements TxSubmitter {
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

  async submit(cborHex: string): Promise<string> {
    if (!/^(?:[0-9a-f]{2})+$/i.test(cborHex)) throw new TypeError("transaction CBOR must be non-empty hex");
    let res: Response;
    try {
      res = await this.fetchFn(`${this.url.replace(/\/+$/, "")}/tx/submit`, {
        method: "POST",
        headers: { "content-type": "application/cbor", ...(this.projectId === null ? {} : { project_id: this.projectId }) },
        body: Buffer.from(cborHex, "hex"),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new OgmiosTransportError(`blockfrost submit: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (res.status === 400) {
      let detail = text;
      try {
        const body = JSON.parse(text) as { message?: unknown };
        if (typeof body.message === "string") detail = body.message;
      } catch {
        // Not JSON: keep the raw text as the detail.
      }
      throw new SubmitRejectedError(this.name, `blockfrost submit rejected the transaction: ${detail.slice(0, 500)}`);
    }
    if (!res.ok) throw new OgmiosTransportError(`blockfrost submit: HTTP ${res.status}`, res.status);
    let txId: unknown;
    try {
      txId = JSON.parse(text);
    } catch {
      throw new OgmiosTransportError(`blockfrost submit: HTTP ${res.status} with a non-JSON body`, res.status);
    }
    if (typeof txId !== "string" || !/^[0-9a-f]{64}$/.test(txId)) {
      throw new OgmiosTransportError(`blockfrost submit: HTTP ${res.status} without a transaction id`, res.status);
    }
    return txId;
  }
}

/** An Ogmios endpoint (our own, or Koios' `/ogmios` proxy) as a submission provider. */
export function ogmiosSubmitter(name: string, client: { submit(cborHex: string): Promise<string> }): TxSubmitter {
  return { name, submit: (cborHex) => client.submit(cborHex) };
}

export interface ResilientSubmitterOptions {
  /** Passes over all providers before giving up (default 2). */
  rounds?: number;
  /** Backoff before the second pass; doubles each pass (default 1 s). */
  initialBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onFailure?: (provider: string, message: string) => void;
}

function isTransportFailure(e: unknown): boolean {
  if (e instanceof OgmiosTransportError) return true;
  // Ogmios codes outside the ledger rejection set (JSON-RPC internal or server errors) come from the provider.
  return e instanceof OgmiosError && !isDefinitiveRejection(e);
}

/** Tries providers in configured order (Blockfrost first); transport failures fail over. */
export class ResilientSubmitter implements TxSubmitter {
  readonly name = "resilient";
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly providers: readonly TxSubmitter[],
    private readonly options: ResilientSubmitterOptions = {},
  ) {
    if (providers.length === 0) throw new RangeError("at least one submission provider is required");
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async submit(cborHex: string): Promise<string> {
    const rounds = this.options.rounds ?? 2;
    let backoff = this.options.initialBackoffMs ?? 1_000;
    let mayHaveRelayed = false;
    const seen: string[] = [];
    for (let round = 0; round < rounds; round++) {
      if (round > 0) {
        await this.sleep(backoff);
        backoff *= 2;
      }
      for (const p of this.providers) {
        try {
          return await p.submit(cborHex);
        } catch (e) {
          if (!isTransportFailure(e)) {
            if (!mayHaveRelayed) throw e;
            throw new SubmitUnavailableError(
              `submission outcome unknown: ${p.name} refused after an earlier provider may have relayed the transaction (${(e as Error).message.slice(0, 200)})`,
              "maybe",
            );
          }
          if (!provedNotRelayed(e)) mayHaveRelayed = true;
          const message = (e as Error).message.slice(0, 200);
          seen.push(`${p.name}: ${message}`);
          this.options.onFailure?.(p.name, message);
        }
      }
    }
    throw new SubmitUnavailableError(
      `submit_unavailable: every submission provider failed (${seen.slice(-this.providers.length).join("; ")})`,
      mayHaveRelayed ? "maybe" : "no",
    );
  }
}
