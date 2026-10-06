/**
 * Chain access for the facilitator: Ogmios (our own node) for UTxO resolution, tip, protocol
 * parameters, evaluation and submission; a Blockfrost-compatible API (Yaci Store locally,
 * Blockfrost on preprod) for inclusion depth, which Ogmios cannot report for a past transaction.
 */
import { OgmiosClient, ogmiosEvaluator, ogmiosValue, parseOutRef, type EvaluationResult, type ProtocolParameters, type TxEvaluator } from "@cascade/service-kit";
import type { ResolvedUtxo } from "./phase1.js";

export type Evidence = { status: "unknown" | "mempool" | "confirmed"; confirmations: number };

export interface ChainAccess {
  resolve(refs: string[]): Promise<Map<string, ResolvedUtxo>>;
  currentSlot(): Promise<number>;
  params(): Promise<ProtocolParameters>;
  evaluate(cborHex: string): Promise<EvaluationResult[]>;
  submit(cborHex: string): Promise<string>;
  evidence(txId: string): Promise<Evidence>;
  /** Address of an output even after it is spent (payer lookup on settlement retries). */
  addressOf(ref: string): Promise<string | null>;
}

async function bfAddressOf(bf: { url: string; projectId: string | null } | null, ref: string): Promise<string | null> {
  if (bf === null) return null;
  const { txId, index } = parseOutRef(ref);
  const headers: Record<string, string> = bf.projectId === null ? {} : { project_id: bf.projectId };
  const res = await fetch(`${bf.url}/txs/${txId}/utxos`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const body = (await res.json()) as { outputs?: { address: string; output_index: number; collateral?: boolean | null }[] };
  return body.outputs?.find((o) => o.output_index === index && o.collateral !== true)?.address ?? null;
}

export class OgmiosChain implements ChainAccess {
  private cachedParams: { at: number; value: ProtocolParameters } | null = null;

  constructor(
    private readonly ogmios: OgmiosClient,
    private readonly blockfrost: { url: string; projectId: string | null } | null,
  ) {}

  async resolve(refs: string[]): Promise<Map<string, ResolvedUtxo>> {
    const out = new Map<string, ResolvedUtxo>();
    const unique = [...new Set(refs)];
    if (unique.length === 0) return out;
    const utxos = await this.ogmios.utxosByRefs(unique.map(parseOutRef));
    for (const u of utxos) {
      const v = ogmiosValue(u.value);
      const script = u.script as { cbor?: string } | undefined;
      out.set(`${u.transaction.id}#${u.index}`, {
        address: u.address,
        lovelace: v.lovelace,
        assets: v.assets,
        referenceScriptSize: typeof script?.cbor === "string" ? script.cbor.length / 2 : null,
      });
    }
    return out;
  }

  async currentSlot(): Promise<number> {
    return (await this.ogmios.tip()).slot;
  }

  async params(): Promise<ProtocolParameters> {
    const now = Date.now();
    if (this.cachedParams !== null && now - this.cachedParams.at < 60_000) return this.cachedParams.value;
    const value = await this.ogmios.protocolParameters();
    this.cachedParams = { at: now, value };
    return value;
  }

  evaluate(cborHex: string): Promise<EvaluationResult[]> {
    return this.ogmios.evaluate(cborHex);
  }

  submit(cborHex: string): Promise<string> {
    return this.ogmios.submit(cborHex);
  }

  async addressOf(ref: string): Promise<string | null> {
    return (await this.resolve([ref])).get(ref)?.address ?? (await bfAddressOf(this.blockfrost, ref));
  }

  async evidence(txId: string): Promise<Evidence> {
    if (this.blockfrost === null) return { status: "unknown", confirmations: -1 };
    const headers: Record<string, string> = this.blockfrost.projectId === null ? {} : { project_id: this.blockfrost.projectId };
    const txRes = await fetch(`${this.blockfrost.url}/txs/${txId}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (txRes.status === 404) return { status: "unknown", confirmations: -1 };
    if (!txRes.ok) throw new Error(`evidence lookup returned HTTP ${txRes.status}`);
    const tx = (await txRes.json()) as { block_height?: number | null };
    if (typeof tx.block_height !== "number" || tx.block_height < 0) return { status: "unknown", confirmations: -1 };
    const tipRes = await fetch(`${this.blockfrost.url}/blocks/latest`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!tipRes.ok) throw new Error(`tip lookup returned HTTP ${tipRes.status}`);
    const tip = (await tipRes.json()) as { height?: number };
    if (typeof tip.height !== "number") throw new Error("tip lookup returned no height");
    return { status: "confirmed", confirmations: Math.max(0, tip.height - tx.block_height) };
  }
}

// ---------------------------------------------------------------------------------------------
// Preprod without our own node: Blockfrost for chain queries, Koios `/ogmios` (evaluate and submit
// only) for phase 2 and broadcast.

interface BfAmount {
  unit: string;
  quantity: string;
}
interface BfUtxoOut {
  address: string;
  amount: BfAmount[];
  output_index: number;
  reference_script_hash?: string | null;
  consumed_by_tx?: string | null;
  collateral?: boolean;
}

/** Converts a decimal price like 0.0577 into an exact ratio. */
export function decimalToRatio(x: number | string): { num: bigint; den: bigint } {
  const s = typeof x === "number" ? x.toString() : x;
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(s);
  if (m === null) throw new TypeError(`not a decimal: ${s}`);
  const frac = m[2] ?? "";
  const exp = Number(m[3] ?? "0") - frac.length;
  const digits = BigInt(`${m[1] as string}${frac}`);
  return exp >= 0 ? { num: digits * 10n ** BigInt(exp), den: 1n } : { num: digits, den: 10n ** BigInt(-exp) };
}

export class BlockfrostChain implements ChainAccess {
  private cachedParams: { at: number; value: ProtocolParameters } | null = null;
  private readonly evidenceChain: OgmiosChain;

  constructor(
    private readonly bf: { url: string; projectId: string | null },
    private readonly ogmiosProxy: OgmiosClient,
    /** Script evaluation (main.ts passes Blockfrost then Koios with failover); defaults to the proxy alone. */
    private readonly evaluator: TxEvaluator = ogmiosEvaluator("koios", ogmiosProxy),
  ) {
    this.evidenceChain = new OgmiosChain(ogmiosProxy, bf);
  }

  private async get<T>(path: string): Promise<{ status: number; body: T | null }> {
    const headers: Record<string, string> = this.bf.projectId === null ? {} : { project_id: this.bf.projectId };
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.bf.url}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
        continue;
      }
      if (res.status === 404) return { status: 404, body: null };
      if (!res.ok) throw new Error(`Blockfrost ${path.split("?")[0]} returned HTTP ${res.status}`);
      return { status: res.status, body: (await res.json()) as T };
    }
  }

  private async unspentAt(address: string, ref: string): Promise<boolean> {
    for (let page = 1; page <= 20; page++) {
      const r = await this.get<{ tx_hash: string; output_index: number }[]>(`/addresses/${address}/utxos?count=100&page=${page}`);
      const list = r.body ?? [];
      if (list.some((u) => `${u.tx_hash}#${u.output_index}` === ref)) return true;
      if (list.length < 100) return false;
    }
    return false;
  }

  async resolve(refs: string[]): Promise<Map<string, ResolvedUtxo>> {
    const out = new Map<string, ResolvedUtxo>();
    const byTx = new Map<string, number[]>();
    for (const ref of new Set(refs)) {
      const { txId, index } = parseOutRef(ref);
      byTx.set(txId, [...(byTx.get(txId) ?? []), index]);
    }
    for (const [txId, indices] of byTx) {
      const r = await this.get<{ outputs: BfUtxoOut[] }>(`/txs/${txId}/utxos`);
      if (r.body === null) continue;
      for (const i of indices) {
        const o = r.body.outputs.find((x) => x.output_index === i && x.collateral !== true);
        if (o === undefined) continue;
        const ref = `${txId}#${i}`;
        // Blockfrost reports `consumed_by_tx`; Blockfrost-compatible stores without it are checked by address.
        const spent = o.consumed_by_tx !== undefined ? o.consumed_by_tx !== null : !(await this.unspentAt(o.address, ref));
        if (spent) continue;
        let lovelace = 0n;
        const assets: Record<string, bigint> = {};
        for (const a of o.amount) {
          if (a.unit === "lovelace") lovelace = BigInt(a.quantity);
          else assets[`${a.unit.slice(0, 56)}.${a.unit.slice(56)}`] = BigInt(a.quantity);
        }
        let refSize: number | null = null;
        if (typeof o.reference_script_hash === "string") {
          const s = await this.get<{ cbor: string }>(`/scripts/${o.reference_script_hash}/cbor`);
          refSize = s.body === null ? null : s.body.cbor.length / 2;
        }
        out.set(ref, { address: o.address, lovelace, assets, referenceScriptSize: refSize });
      }
    }
    return out;
  }

  async currentSlot(): Promise<number> {
    const r = await this.get<{ slot: number }>("/blocks/latest");
    if (r.body === null) throw new Error("no latest block");
    return r.body.slot;
  }

  async params(): Promise<ProtocolParameters> {
    const now = Date.now();
    if (this.cachedParams !== null && now - this.cachedParams.at < 60_000) return this.cachedParams.value;
    const r = await this.get<Record<string, unknown>>("/epochs/latest/parameters");
    const p = r.body;
    if (p === null) throw new Error("no protocol parameters");
    const n = (k: string) => BigInt(String(p[k] ?? "0"));
    const value: ProtocolParameters = {
      minFeeCoefficient: n("min_fee_a"),
      minFeeConstant: n("min_fee_b"),
      coinsPerUtxoByte: n("coins_per_utxo_size"),
      maxTransactionSize: Number(p.max_tx_size),
      stakeCredentialDeposit: n("key_deposit"),
      maxExecutionUnitsPerTransaction: { memory: n("max_tx_ex_mem"), cpu: n("max_tx_ex_steps") },
      minFeeReferenceScripts: { base: Number(p.min_fee_ref_script_cost_per_byte ?? 15), range: 25_600, multiplier: 1.2 },
      collateralPercentage: Number(p.collateral_percent ?? 150),
      maxCollateralInputs: Number(p.max_collateral_inputs ?? 3),
      scriptExecutionPrices: { memory: decimalToRatio(String(p.price_mem)), cpu: decimalToRatio(String(p.price_step)) },
    };
    this.cachedParams = { at: now, value };
    return value;
  }

  evaluate(cborHex: string): Promise<EvaluationResult[]> {
    return this.evaluator.evaluate(cborHex);
  }

  submit(cborHex: string): Promise<string> {
    return this.ogmiosProxy.submit(cborHex);
  }

  evidence(txId: string): Promise<Evidence> {
    return this.evidenceChain.evidence(txId);
  }

  addressOf(ref: string): Promise<string | null> {
    return bfAddressOf(this.bf, ref);
  }
}
