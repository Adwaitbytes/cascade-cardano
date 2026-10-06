/**
 * Payment side of MIP-003 `/start_job`. MIP-003 returns a `blockchainIdentifier` and four deadlines
 * that come from the seller's payment backend. Two backends:
 *
 * - `MasumiPaymentServiceBackend`: the seller's own Masumi Payment Service (`POST /payment`,
 *   `resolve-blockchain-identifier`, `submit-result`), for agents registered on Masumi.
 * - Any other backend implementing `StartJobPayments`, e.g. a Cascade tree watcher that marks a job
 *   paid when the indexer sees the node that funds it.
 */
import type { JobRecord } from "./types.js";

export interface StartJobTerms {
  blockchainIdentifier: string;
  /** POSIX milliseconds, as Masumi stores them. */
  payByTime: number;
  submitResultTime: number;
  unlockTime: number;
  externalDisputeUnlockTime: number;
  agentIdentifier: string;
  sellerVKey: string;
  amounts?: { amount: string; unit: string }[];
}

export type PaymentState = "pending" | "paid" | "expired" | "refunded";

export interface StartJobPayments {
  create(job: Pick<JobRecord, "job_id" | "identifier_from_purchaser" | "input_hash">): Promise<StartJobTerms>;
  /** Polled by the server until it returns something other than `pending`. */
  state(blockchainIdentifier: string): Promise<PaymentState>;
  /** Called once with the result hash after the job completes. */
  submitResult(blockchainIdentifier: string, resultHash: string): Promise<void>;
}

export interface MasumiPaymentServiceOptions {
  /** e.g. `http://localhost:3001/api/v1` */
  baseUrl: string;
  /** Payment Service API key, sent as the `token` header. Read from the environment, never logged. */
  apiKey: string;
  agentIdentifier: string;
  sellerVKey: string;
  network: "Preprod" | "Mainnet";
  /** V2 sources need `supportedPaymentSourceIndex` (docs/research/crewai-quickstart.md). */
  paymentSourceType: "Web3CardanoV1" | "Web3CardanoV2";
  supportedPaymentSourceIndex?: number;
  /** Work time the seller needs; the deadlines keep Masumi's 5/15/15 minute minimums. */
  workMs: number;
  fetch?: typeof fetch;
  now?: () => number;
}

const MINUTE = 60_000;

/** Masumi requires `identifierFromPurchaser` to be 14 to 26 hex chars (masumi-payment-service.md). */
export function isMasumiPurchaserId(id: string): boolean {
  return /^[0-9a-fA-F]{14,26}$/.test(id);
}

export class MasumiPaymentServiceBackend implements StartJobPayments {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: MasumiPaymentServiceOptions) {
    if (options.paymentSourceType === "Web3CardanoV2" && options.supportedPaymentSourceIndex === undefined) {
      throw new Error("Web3CardanoV2 payment sources need supportedPaymentSourceIndex");
    }
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetch(`${this.options.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", token: this.options.apiKey },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Masumi Payment Service ${path} returned ${res.status}: ${text.slice(0, 300)}`);
    const parsed = JSON.parse(text) as { data?: T };
    if (parsed.data === undefined) throw new Error(`Masumi Payment Service ${path} returned no data`);
    return parsed.data;
  }

  async create(job: Pick<JobRecord, "job_id" | "identifier_from_purchaser" | "input_hash">): Promise<StartJobTerms> {
    if (!isMasumiPurchaserId(job.identifier_from_purchaser)) throw new Error("identifier_from_purchaser must be 14 to 26 hex characters for Masumi");
    const now = this.now();
    const payBy = now + 10 * MINUTE;
    const submit = Math.max(payBy + 5 * MINUTE, now + 15 * MINUTE, payBy + this.options.workMs);
    const unlock = submit + 15 * MINUTE;
    const dispute = unlock + 15 * MINUTE;
    const iso = (ms: number) => new Date(ms).toISOString();
    const body: Record<string, unknown> = {
      inputHash: job.input_hash,
      network: this.options.network,
      agentIdentifier: this.options.agentIdentifier,
      identifierFromPurchaser: job.identifier_from_purchaser,
      paymentSourceType: this.options.paymentSourceType,
      payByTime: iso(payBy),
      submitResultTime: iso(submit),
      unlockTime: iso(unlock),
      externalDisputeUnlockTime: iso(dispute),
    };
    if (this.options.supportedPaymentSourceIndex !== undefined) body["supportedPaymentSourceIndex"] = this.options.supportedPaymentSourceIndex;
    const data = await this.call<Record<string, unknown>>("/payment", body);
    const ms = (key: string): number => {
      const v = data[key];
      const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN;
      if (!Number.isFinite(n)) throw new Error(`Masumi Payment Service returned no ${key}`);
      return n;
    };
    const id = data["blockchainIdentifier"];
    if (typeof id !== "string" || id.length === 0) throw new Error("Masumi Payment Service returned no blockchainIdentifier");
    return {
      blockchainIdentifier: id,
      payByTime: ms("payByTime"),
      submitResultTime: ms("submitResultTime"),
      unlockTime: ms("unlockTime"),
      externalDisputeUnlockTime: ms("externalDisputeUnlockTime"),
      agentIdentifier: this.options.agentIdentifier,
      sellerVKey: this.options.sellerVKey,
    };
  }

  async state(blockchainIdentifier: string): Promise<PaymentState> {
    const data = await this.call<{ onChainState?: string | null }>("/payment/resolve-blockchain-identifier", {
      blockchainIdentifier,
      network: this.options.network,
    });
    switch (data.onChainState) {
      case null:
      case undefined:
        return "pending";
      case "FundsLocked":
      case "ResultSubmitted":
      case "Withdrawn":
      case "Disputed":
      case "DisputedWithdrawn":
        return "paid";
      case "RefundRequested":
      case "RefundWithdrawn":
        return "refunded";
      case "FundsOrDatumInvalid":
        return "expired";
      default:
        throw new Error(`unknown Masumi onChainState ${data.onChainState}`);
    }
  }

  async submitResult(blockchainIdentifier: string, resultHash: string): Promise<void> {
    await this.call("/payment/submit-result", { network: this.options.network, blockchainIdentifier, submitResultHash: resultHash });
  }
}
