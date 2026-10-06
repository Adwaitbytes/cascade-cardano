/**
 * HTTP client for Cascade and MIP-003 agents (PRD 9.1, 9.2, 10.1 steps 4 and 9). Every response
 * is parsed before use; signed bodies are verified against the agent's payment address.
 */
import { QuoteSchema, signedBodyHash, verifyCose1, verifyQuote, type NodeSpec, type Quote, specHash } from "@cascade/shared/browser";
import { decodeHeader, type PaymentPayload, type PaymentRequired, encodeHeader } from "@cascade/agent";

export class AgentHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    what: string,
  ) {
    super(`${what} returned ${status}: ${body.slice(0, 200)}`);
    this.name = "AgentHttpError";
  }
}

export interface MasumiStartJob {
  id: string;
  blockchainIdentifier: string;
  payByTime: number;
  submitResultTime: number;
  unlockTime: number;
  externalDisputeUnlockTime: number;
  agentIdentifier: string;
  sellerVKey: string;
  input_hash: string;
  /** Lovelace price the seller echoes in `amounts`, when it does. */
  amount: string | null;
}

export type PurchaseResult =
  | { kind: "payment_required"; required: PaymentRequired }
  | { kind: "started"; job_id: string; input_hash: string; tx_id: string | null; payment_response: unknown };

export interface ResultBundle {
  job_id: string;
  result: unknown;
  result_hash: unknown;
  evidence: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class AgentClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
  }

  private async jsonOf(res: Response, what: string): Promise<unknown> {
    const text = await res.text();
    if (!res.ok) throw new AgentHttpError(res.status, text, what);
    return JSON.parse(text) as unknown;
  }

  /** Requests a signed quote and checks it: schema, COSE signature and the spec hash it answers. */
  async quote(spec: NodeSpec, window: { start_by: number; submit_by: number }): Promise<Quote> {
    const hash = specHash(spec);
    const res = await this.call("/cascade/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec, spec_hash: hash, window }),
    });
    const quote = QuoteSchema.parse(await this.jsonOf(res, "quote"));
    if (quote.spec_hash !== hash) throw new Error("quote answers a different spec_hash");
    const check = verifyQuote(quote);
    if (!check.ok) throw new Error(`quote signature invalid: ${check.reason}`);
    return quote;
  }

  /** MIP-003 `POST /start_job` (an unmodified Masumi agent's purchase flow). Times are POSIX ms. */
  async startJob(body: { identifier_from_purchaser: string; input_data: Record<string, string> }): Promise<MasumiStartJob> {
    const res = await this.call("/start_job", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await this.jsonOf(res, "start_job");
    if (!isObject(json)) throw new Error("malformed /start_job response");
    const str = (k: string): string => {
      const v = json[k];
      if (typeof v !== "string" || v.length === 0) throw new Error(`/start_job response lacks ${k}`);
      return v;
    };
    const ms = (k: string): number => {
      const v = json[k];
      const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : typeof v === "string" ? Date.parse(v) : NaN;
      if (!Number.isFinite(n)) throw new Error(`/start_job response lacks ${k}`);
      return n;
    };
    // MIP-003 names the job `id`; the CrewAI template returns `job_id` (docs/research/crewai-quickstart.md).
    const id = typeof json["id"] === "string" ? json["id"] : str("job_id");
    const amounts = Array.isArray(json["amounts"]) ? (json["amounts"] as { amount?: unknown; unit?: unknown }[]) : [];
    const lovelace = amounts.find((a) => a.unit === "lovelace" || a.unit === "");
    return {
      id,
      blockchainIdentifier: str("blockchainIdentifier"),
      payByTime: ms("payByTime"),
      submitResultTime: ms("submitResultTime"),
      unlockTime: ms("unlockTime"),
      externalDisputeUnlockTime: ms("externalDisputeUnlockTime"),
      agentIdentifier: str("agentIdentifier"),
      sellerVKey: str("sellerVKey"),
      input_hash: str("input_hash"),
      amount: lovelace === undefined || (typeof lovelace.amount !== "string" && typeof lovelace.amount !== "number") ? null : String(lovelace.amount),
    };
  }

  /** `POST /jobs`: without `payment` returns the 402 offer; with it, the started job. */
  async purchase(body: { identifier_from_purchaser: string; input_data: Record<string, unknown>; spec_hash?: string; quote_id?: string }, payment?: PaymentPayload): Promise<PurchaseResult> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (payment !== undefined) headers["PAYMENT-SIGNATURE"] = encodeHeader(payment);
    const res = await this.call("/jobs", { method: "POST", headers, body: JSON.stringify(body) });
    if (res.status === 402) {
      const header = res.headers.get("PAYMENT-REQUIRED");
      const required = (header === null ? await res.json() : decodeHeader(header)) as PaymentRequired;
      if (required.x402Version !== 2 || !Array.isArray(required.accepts)) throw new Error("malformed 402 PaymentRequired");
      return { kind: "payment_required", required };
    }
    const json = await this.jsonOf(res, "jobs");
    if (!isObject(json) || typeof json["job_id"] !== "string" || typeof json["input_hash"] !== "string") throw new Error("malformed /jobs response");
    const pr = res.headers.get("PAYMENT-RESPONSE");
    return {
      kind: "started",
      job_id: json["job_id"],
      input_hash: json["input_hash"],
      tx_id: typeof json["tx_id"] === "string" ? json["tx_id"] : null,
      payment_response: pr === null ? null : decodeHeader(pr),
    };
  }

  async status(jobId: string): Promise<{ status: string; input_schema?: unknown; result?: string }> {
    const json = await this.jsonOf(await this.call(`/status?job_id=${encodeURIComponent(jobId)}`), "status");
    if (!isObject(json) || typeof json["status"] !== "string") throw new Error("malformed /status response");
    return json as { status: string };
  }

  async result(jobId: string): Promise<ResultBundle> {
    const json = await this.jsonOf(await this.call(`/cascade/result?job_id=${encodeURIComponent(jobId)}`), "result");
    if (!isObject(json)) throw new Error("malformed /cascade/result response");
    return { job_id: String(json["job_id"]), result: json["result"], result_hash: json["result_hash"], evidence: json["evidence"] };
  }

  /** Sends a challenge notice and verifies the signed rebuttal against the agent's address. */
  async challenge(notice: { tree_id: string; node_id: string; reason_hash: string; reason: Record<string, unknown> }, agentAddress: string): Promise<{ concede: boolean; rebuttal_hash: string }> {
    const res = await this.call("/cascade/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(notice) });
    const json = await this.jsonOf(res, "challenge");
    if (!isObject(json) || typeof json["signature"] !== "string" || typeof json["key"] !== "string") throw new Error("malformed rebuttal");
    const check = verifyCose1({ signature: json["signature"], key: json["key"] }, { payload: signedBodyHash(json), address: agentAddress });
    if (!check.ok) throw new Error(`rebuttal signature invalid: ${check.reason}`);
    return { concede: json["concede"] === true, rebuttal_hash: String(json["rebuttal_hash"]) };
  }
}
