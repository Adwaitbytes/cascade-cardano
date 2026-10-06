/**
 * The only way the orchestrator gets a signature: the signer service (W3), which signs a
 * transaction for a role only when all eight Cedar gates pass (PRD 13.2). No key is ever loaded here.
 */
import { CML } from "@lucid-evolution/lucid";
import { SignerDeniedError as SdkSignerDeniedError, type KeySigner } from "@cascade/sdk";

export interface GateResult {
  gate: number | string;
  passed: boolean;
  detail?: string;
  details?: string[];
}

/**
 * The signer's retryable refusals, neither a policy decision: a spent input is not in the indexer
 * yet (the Draw that made it landed moments ago), or no script evaluation provider answered so gate
 * 8 never ran. Every other refusal is final.
 */
export const INPUT_NOT_INDEXED = "input_not_indexed";
export const EVALUATOR_UNAVAILABLE = "evaluator_unavailable";
const RETRYABLE_CODES: ReadonlySet<string> = new Set([INPUT_NOT_INDEXED, EVALUATOR_UNAVAILABLE]);

function retryableCode(code: string | undefined): string | null {
  return code !== undefined && RETRYABLE_CODES.has(code) ? code : null;
}

export class SignerDeniedError extends Error {
  constructor(
    readonly txBodyHash: string,
    readonly gates: GateResult[],
    readonly reasons: string[],
    /** `input_not_indexed` or `evaluator_unavailable` for a retryable refusal, null for a gate decision. */
    readonly code: string | null = null,
  ) {
    const failed = gates.filter((g) => !g.passed).map((g) => `gate ${String(g.gate)}: ${[g.detail, ...(g.details ?? [])].filter((x) => x !== undefined).join("; ")}`);
    super(`signer refused ${txBodyHash}: ${[...reasons, ...failed].join(" | ")}`);
    this.name = "SignerDeniedError";
  }
}

export interface TxSigner {
  /** Returns the transaction CBOR with the role's witness added; throws `SignerDeniedError` on a gate refusal. */
  sign(role: string, txCbor: string): Promise<string>;
}

export interface NotIndexedRetry {
  /** Total time to keep asking while the signer answers a retryable refusal. */
  budgetMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** A preprod indexer polls Blockfrost; three minutes covers several blocks of lag. */
export const DEFAULT_NOT_INDEXED_RETRY: NotIndexedRetry = { budgetMs: 180_000, initialDelayMs: 2_000, maxDelayMs: 20_000 };

/**
 * Asks again, with exponential backoff, only while the signer answers a retryable refusal. The
 * signer re-runs every gate on each attempt, so this never signs anything a gate would refuse; an
 * input that never gets indexed, or an evaluator that never comes back, still fails when the budget runs out.
 */
async function retryWhileNotIndexed(signOnce: () => Promise<string>, retry: NotIndexedRetry): Promise<string> {
  const now = retry.now ?? Date.now;
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + retry.budgetMs;
  for (let delay = retry.initialDelayMs; ; delay = Math.min(delay * 2, retry.maxDelayMs)) {
    try {
      return await signOnce();
    } catch (e) {
      if (!(e instanceof SignerDeniedError) || e.code === null) throw e;
      const left = deadline - now();
      if (left <= 0) throw e;
      await sleep(Math.min(delay, left));
    }
  }
}

export class HttpTxSigner implements TxSigner {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly retry: NotIndexedRetry = DEFAULT_NOT_INDEXED_RETRY,
  ) {}

  sign(role: string, txCbor: string): Promise<string> {
    return retryWhileNotIndexed(() => this.signOnce(role, txCbor), this.retry);
  }

  private async signOnce(role: string, txCbor: string): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/v1/sign`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.token === null ? {} : { authorization: `Bearer ${this.token}` }) },
      body: JSON.stringify({ role, tx_cbor: txCbor }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json()) as { decision?: string; code?: string; signed_tx?: string; tx_body_hash?: string; gates?: GateResult[]; reasons?: string[]; error?: unknown };
    if (res.ok && body.decision === "allow" && typeof body.signed_tx === "string") return body.signed_tx;
    if (body.decision === "deny") {
      const reasons = [...(body.reasons ?? []), ...(typeof body.error === "string" && !(body.reasons ?? []).includes(body.error) ? [body.error] : [])];
      throw new SignerDeniedError(body.tx_body_hash ?? "", body.gates ?? [], reasons, retryableCode(body.code));
    }
    throw new Error(`signer answered ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 300)}`);
  }
}

/** Adapter for an in-process `@cascade/signer` `Signer` (tests and single-process local runs). */
export function inProcessSigner(
  signer: {
    sign(role: string, txCbor: string): Promise<{ decision: "allow"; signedTx: string } | { decision: "deny"; txBodyHash: string; report: { gates: GateResult[]; reasons?: string[] } | null; error?: string; code?: string }>;
  },
  retry: NotIndexedRetry = DEFAULT_NOT_INDEXED_RETRY,
): TxSigner {
  const signOnce = async (role: string, txCbor: string): Promise<string> => {
    const r = await signer.sign(role, txCbor);
    if (r.decision === "allow") return r.signedTx;
    throw new SignerDeniedError(r.txBodyHash, r.report?.gates ?? [], [...(r.report?.reasons ?? []), ...(r.error === undefined ? [] : [r.error])], retryableCode(r.code));
  };
  return { sign: (role, txCbor) => retryWhileNotIndexed(() => signOnce(role, txCbor), retry) };
}

/**
 * A key-witness signer for one role's key, through the signer service: signs the whole transaction
 * for `role` and returns only the vkey witness whose key hashes to `keyHash` (the SDK's purchase
 * wallet drivers attach witnesses themselves, ADR 0001 section 8.1).
 */
export function witnessSigner(signer: TxSigner, role: string, keyHash: string): KeySigner {
  return async (txCbor) => {
    let signedCbor: string;
    try {
      signedCbor = await signer.sign(role, txCbor);
    } catch (e) {
      // The SDK drivers retry by reason (e.g. `received-funds` while the indexer catches up).
      if (e instanceof SignerDeniedError) throw new SdkSignerDeniedError(role, [...e.reasons, ...e.gates.filter((g) => !g.passed).map((g) => String(g.gate))], e.message);
      throw e;
    }
    const signed = CML.Transaction.from_cbor_hex(signedCbor);
    const witnesses = signed.witness_set().vkeywitnesses();
    for (let i = 0; i < (witnesses?.len() ?? 0); i++) {
      const w = witnesses?.get(i);
      if (w !== undefined && w.vkey().hash().to_hex() === keyHash) return w.to_cbor_hex();
    }
    throw new Error(`the signer returned no witness for ${role} (${keyHash})`);
  };
}

/** `POST /v1/masumi/failed` on the signer service: marks a Masumi slot failed (ADR 0001 8.1 exit). */
export function signerMarkMasumiFailed(baseUrl: string, token: string | null, fetchImpl: typeof fetch = fetch): (paymentOutRef: string, reason: string) => Promise<void> {
  return async (paymentOutRef, reason) => {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/v1/masumi/failed`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify({ payment_out_ref: paymentOutRef, reason: reason.slice(0, 500) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`signer refused to mark ${paymentOutRef} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  };
}
