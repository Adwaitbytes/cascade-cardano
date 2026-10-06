/**
 * Blockfrost (and Blockfrost-compatible Yaci Store) reads, and the ChainTx model built from them,
 * for networks where the services run without their own Ogmios node (preprod on Blockfrost).
 */
import { outRef, rewardCredential, sortOutRefs, type ChainTx, type RedeemerPurpose, type TxOutput } from "./chaintx.js";

interface BfAmount {
  unit: string;
  quantity: string | number;
}
interface BfInput {
  tx_hash: string;
  output_index: number;
  reference?: boolean | null;
  collateral?: boolean | null;
}
interface BfOutput {
  address: string;
  amount: BfAmount[];
  output_index: number;
  data_hash?: string | null;
  inline_datum?: string | null;
  reference_script_hash?: string | null;
  collateral?: boolean | null;
}
interface BfTx {
  hash: string;
  block_height: number;
  slot: number;
  index?: number;
  fees?: string | number;
  valid_contract?: boolean;
  invalid?: boolean;
  reference_inputs?: BfInput[];
  collateral_inputs?: BfInput[];
}
interface BfRedeemer {
  tx_index: number;
  purpose: string;
  redeemer_data_hash: string;
  unit_mem: string | number;
  unit_steps: string | number;
}

export class BlockfrostClient {
  constructor(
    readonly url: string,
    private readonly projectId: string | null,
  ) {}

  async get<T>(path: string): Promise<T | null> {
    const headers: Record<string, string> = this.projectId === null ? {} : { project_id: this.projectId };
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.url}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Blockfrost ${path.split("?")[0]} returned HTTP ${res.status}`);
      return (await res.json()) as T;
    }
  }

  async latestBlock(): Promise<{ height: number; slot: number; hash: string }> {
    const b = await this.get<{ height: number; slot: number; hash: string }>("/blocks/latest");
    if (b === null) throw new Error("no latest block");
    return b;
  }

  blockAt(height: number): Promise<{ height: number; slot: number; hash: string } | null> {
    return this.get(`/blocks/${height}`);
  }
}

const PURPOSES: Record<string, RedeemerPurpose> = { spend: "spend", mint: "mint", cert: "publish", reward: "withdraw", withdraw: "withdraw", vote: "vote", propose: "propose" };

function toOutput(o: BfOutput): TxOutput {
  let lovelace = 0n;
  const assets: Record<string, bigint> = {};
  for (const a of o.amount) {
    if (a.unit === "lovelace") lovelace = BigInt(a.quantity);
    else assets[`${a.unit.slice(0, 56)}.${a.unit.slice(56)}`] = BigInt(a.quantity);
  }
  return {
    address: o.address,
    lovelace,
    assets,
    datum: o.inline_datum ?? null,
    datumHash: o.inline_datum ? null : (o.data_hash ?? null),
    hasScriptRef: typeof o.reference_script_hash === "string",
    size: null,
  };
}

/** Fetches one transaction as a ChainTx plus its block position. */
export async function chainTxFromBlockfrost(bf: BlockfrostClient, hash: string): Promise<{ tx: ChainTx; height: number; slot: number; index: number } | null> {
  const tx = await bf.get<BfTx>(`/txs/${hash}`);
  if (tx === null) return null;
  const utxos = await bf.get<{ inputs: BfInput[]; outputs: BfOutput[] }>(`/txs/${hash}/utxos`);
  if (utxos === null) return null;
  const reds = (await bf.get<BfRedeemer[]>(`/txs/${hash}/redeemers`)) ?? [];
  const wds = (await bf.get<{ address: string; amount: string | number }[]>(`/txs/${hash}/withdrawals`)) ?? [];
  const redeemers = [];
  for (const r of reds) {
    const d = await bf.get<{ cbor: string }>(`/scripts/datum/${r.redeemer_data_hash}/cbor`);
    if (d === null) continue;
    redeemers.push({
      purpose: PURPOSES[r.purpose] ?? "spend",
      index: r.tx_index,
      data: d.cbor,
      exUnits: { memory: BigInt(r.unit_mem), cpu: BigInt(r.unit_steps) },
    });
  }
  const ref = (i: BfInput) => outRef(i.tx_hash, i.output_index);
  const referenceInputs = [...(tx.reference_inputs ?? []).map(ref), ...utxos.inputs.filter((i) => i.reference === true).map(ref)];
  const collateralInputs = [...(tx.collateral_inputs ?? []).map(ref), ...utxos.inputs.filter((i) => i.collateral === true).map(ref)];
  const inputs = utxos.inputs.filter((i) => i.reference !== true && i.collateral !== true).map(ref);
  const outputs = utxos.outputs
    .filter((o) => o.collateral !== true)
    .sort((a, b) => a.output_index - b.output_index)
    .map(toOutput);
  const valid = tx.valid_contract ?? tx.invalid !== true;
  return {
    height: tx.block_height,
    slot: tx.slot,
    index: tx.index ?? 0,
    tx: {
      id: tx.hash,
      valid,
      inputs: sortOutRefs([...new Set(inputs)]),
      referenceInputs: sortOutRefs([...new Set(referenceInputs)]),
      collateralInputs: sortOutRefs([...new Set(collateralInputs)]),
      collateralReturn: null,
      totalCollateral: null,
      outputs,
      mint: {},
      withdrawals: wds.map((w) => ({ rewardAddress: w.address, credential: rewardCredential(w.address), amount: BigInt(w.amount) })),
      redeemers,
      requiredSigners: [],
      validFrom: null,
      validTo: null,
      fee: BigInt(tx.fees ?? 0),
      networkId: null,
      certificateCount: 0,
      hasGovernance: false,
      donation: 0n,
      vkeyWitnessHashes: [],
      sizeBytes: null,
    },
  };
}
