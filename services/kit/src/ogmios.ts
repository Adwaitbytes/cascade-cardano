/**
 * Ogmios JSON-RPC client (v6 on Yaci, v7 on preprod; method names are identical). HTTP for
 * request/response queries, WebSocket for chain sync (see chainsync.ts).
 *
 * Numbers above 2^53 are parsed losslessly as bigint via JSON.parse source access (Node 21+).
 */

export class OgmiosError extends Error {
  override readonly name = "OgmiosError";
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data: unknown,
  ) {
    super(`${method} failed (${code}): ${message}`);
  }
}

export class OgmiosTransportError extends Error {
  override readonly name = "OgmiosTransportError";
  constructor(
    message: string,
    /** HTTP status when the provider answered at all; undefined for network errors and timeouts. */
    readonly status?: number,
  ) {
    super(message);
  }
}

type Reviver = (key: string, value: unknown, context?: { source?: string }) => unknown;

/** Integers outside the safe range become bigint; everything else parses as usual. */
export const losslessReviver: Reviver = (_key, value, context) => {
  if (typeof value === "number" && !Number.isSafeInteger(value) && context?.source !== undefined && /^-?\d+$/.test(context.source)) {
    return BigInt(context.source);
  }
  return value;
};

export function parseJsonLossless(text: string): unknown {
  return JSON.parse(text, losslessReviver as (this: unknown, key: string, value: unknown) => unknown);
}

/** Converts an Ogmios quantity (number or lossless bigint) to bigint. */
export function toBigInt(v: unknown, what = "quantity"): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  throw new TypeError(`${what} is not an integer`);
}

export interface Point {
  slot: number;
  id: string;
}

export interface Tip extends Point {
  height?: number;
}

export interface ProtocolParameters {
  minFeeCoefficient: bigint;
  minFeeConstant: bigint;
  coinsPerUtxoByte: bigint;
  maxTransactionSize: number;
  stakeCredentialDeposit: bigint;
  maxExecutionUnitsPerTransaction: { memory: bigint; cpu: bigint };
  minFeeReferenceScripts: { base: number; range: number; multiplier: number } | null;
  collateralPercentage: number;
  maxCollateralInputs: number;
  /** Prices per execution unit as exact ratios. */
  scriptExecutionPrices: { memory: Ratio; cpu: Ratio };
}

export interface Ratio {
  num: bigint;
  den: bigint;
}

export function parseRatio(v: unknown, what: string): Ratio {
  if (typeof v === "string" && /^\d+\/\d+$/.test(v)) {
    const [n, d] = v.split("/") as [string, string];
    return { num: BigInt(n), den: BigInt(d) };
  }
  if (typeof v === "number" || typeof v === "bigint") return { num: BigInt(v), den: 1n };
  throw new TypeError(`${what} is not a ratio`);
}

export interface EvaluationResult {
  validator: { purpose: string; index: number };
  budget: { memory: bigint; cpu: bigint };
}

export interface OgmiosUtxo {
  transaction: { id: string };
  index: number;
  address: string;
  value: Record<string, Record<string, unknown>>;
  datum?: string;
  datumHash?: string;
  script?: unknown;
}

export interface OgmiosClientOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

let rpcId = 0;

export class OgmiosClient {
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(
    readonly url: string,
    options: OgmiosClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchFn = options.fetch ?? fetch;
  }

  async rpc<T>(method: string, params?: unknown): Promise<T> {
    const id = ++rpcId;
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params === undefined ? { jsonrpc: "2.0", method, id } : { jsonrpc: "2.0", method, params, id }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new OgmiosTransportError(`${method}: ${(e as Error).message}`);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = parseJsonLossless(text);
    } catch {
      throw new OgmiosTransportError(`${method}: HTTP ${res.status} with a non-JSON body`, res.status);
    }
    const msg = body as { result?: T; error?: { code: number; message: string; data?: unknown } };
    if (msg.error !== undefined) throw new OgmiosError(method, msg.error.code, msg.error.message, msg.error.data);
    if (!("result" in msg)) throw new OgmiosTransportError(`${method}: HTTP ${res.status} without result`, res.status);
    return msg.result as T;
  }

  tip(): Promise<Point> {
    return this.rpc<Point>("queryNetwork/tip");
  }

  async blockHeight(): Promise<number> {
    const h = await this.rpc<number | bigint>("queryNetwork/blockHeight");
    return Number(h);
  }

  async protocolParameters(): Promise<ProtocolParameters> {
    const p = await this.rpc<Record<string, unknown>>("queryLedgerState/protocolParameters");
    const lovelace = (v: unknown, what: string) => toBigInt((v as { ada?: { lovelace?: unknown } } | undefined)?.ada?.lovelace, what);
    const maxEx = p.maxExecutionUnitsPerTransaction as { memory: unknown; cpu: unknown } | undefined;
    const refs = p.minFeeReferenceScripts as { base: number; range: number; multiplier: number } | undefined;
    return {
      minFeeCoefficient: toBigInt(p.minFeeCoefficient, "minFeeCoefficient"),
      minFeeConstant: lovelace(p.minFeeConstant, "minFeeConstant"),
      coinsPerUtxoByte: toBigInt(p.minUtxoDepositCoefficient, "minUtxoDepositCoefficient"),
      maxTransactionSize: Number((p.maxTransactionSize as { bytes: number }).bytes),
      stakeCredentialDeposit: lovelace(p.stakeCredentialDeposit, "stakeCredentialDeposit"),
      maxExecutionUnitsPerTransaction: {
        memory: toBigInt(maxEx?.memory ?? 0, "maxExecutionUnits.memory"),
        cpu: toBigInt(maxEx?.cpu ?? 0, "maxExecutionUnits.cpu"),
      },
      minFeeReferenceScripts: refs ?? null,
      collateralPercentage: Number(p.collateralPercentage ?? 150),
      maxCollateralInputs: Number(p.maxCollateralInputs ?? 3),
      scriptExecutionPrices: {
        memory: parseRatio((p.scriptExecutionPrices as { memory?: unknown } | undefined)?.memory ?? "0/1", "scriptExecutionPrices.memory"),
        cpu: parseRatio((p.scriptExecutionPrices as { cpu?: unknown } | undefined)?.cpu ?? "0/1", "scriptExecutionPrices.cpu"),
      },
    };
  }

  /** Dry-runs every script in a tx. Throws OgmiosError 3010 with per-validator failures. */
  async evaluate(cborHex: string, additionalUtxo?: unknown[]): Promise<EvaluationResult[]> {
    const params: Record<string, unknown> = { transaction: { cbor: cborHex } };
    if (additionalUtxo !== undefined && additionalUtxo.length > 0) params.additionalUtxo = additionalUtxo;
    const out = await this.rpc<Array<{ validator: { purpose: string; index: number }; budget: { memory: unknown; cpu: unknown } }>>(
      "evaluateTransaction",
      params,
    );
    return out.map((r) => ({
      validator: r.validator,
      budget: { memory: toBigInt(r.budget.memory, "memory"), cpu: toBigInt(r.budget.cpu, "cpu") },
    }));
  }

  async submit(cborHex: string): Promise<string> {
    const out = await this.rpc<{ transaction: { id: string } }>("submitTransaction", { transaction: { cbor: cborHex } });
    return out.transaction.id;
  }

  utxosByRefs(refs: { txId: string; index: number }[]): Promise<OgmiosUtxo[]> {
    return this.rpc<OgmiosUtxo[]>("queryLedgerState/utxo", {
      outputReferences: refs.map((r) => ({ transaction: { id: r.txId }, index: r.index })),
    });
  }

  utxosByAddresses(addresses: string[]): Promise<OgmiosUtxo[]> {
    return this.rpc<OgmiosUtxo[]>("queryLedgerState/utxo", { addresses });
  }
}

/** Ogmios submit error codes that mean the ledger definitively rejected the tx (never retried). */
export const DEFINITIVE_SUBMIT_REJECTIONS: ReadonlySet<number> = new Set([
  3005, 3100, 3101, 3102, 3103, 3104, 3105, 3106, 3107, 3108, 3109, 3110, 3111, 3112, 3113, 3114, 3115, 3116, 3117, 3118, 3119, 3120, 3121,
  3122, 3123, 3124, 3125, 3126, 3127, 3128, 3129, 3130, 3131, 3132, 3133, 3134, 3135, 3136, 3137, 3138, 3139, 3140, 3141, 3142, 3143,
  3144, 3145, 3146, 3147, 3148, 3149, 3150, 3151, 3152, 3153, 3154, 3155, 3156, 3157, 3158, 3159, 3160, 3161, 3162, 3163, 3164, 3165,
  3166, 3010, 3011, 3012, 3013, -32602,
]);

export function isDefinitiveRejection(e: unknown): boolean {
  return e instanceof OgmiosError && DEFINITIVE_SUBMIT_REJECTIONS.has(e.code);
}

/** Flattens an Ogmios value (`{ ada: { lovelace }, <policy>: { <name>: qty } }`) into lovelace + units. */
export function ogmiosValue(value: Record<string, Record<string, unknown>>): { lovelace: bigint; assets: Record<string, bigint> } {
  let lovelace = 0n;
  const assets: Record<string, bigint> = {};
  for (const [policy, names] of Object.entries(value)) {
    if (policy === "ada") {
      lovelace = toBigInt(names.lovelace ?? 0, "lovelace");
      continue;
    }
    for (const [name, qty] of Object.entries(names)) assets[`${policy}.${name}`] = toBigInt(qty, "asset quantity");
  }
  return { lovelace, assets };
}
