/**
 * Transaction-level chain reads that Lucid's providers do not offer: the inputs (and spent outputs)
 * of a transaction. The watchtower uses it to tell a Draw payment to the purchase wallet P apart
 * from P's own change and float top-ups (ADR 0001 section 8.1, items 4a and 4b).
 */
import type { Assets } from "@lucid-evolution/lucid";

export interface TxIo {
  txHash: string;
  outputIndex: number;
  address: string;
  assets: Assets;
  /** Inline datum CBOR hex, or null. */
  inlineDatum: string | null;
}

export interface ChainTxReader {
  /** Resolved inputs and all outputs (spent or not) of a confirmed transaction. */
  tx(txHash: string): Promise<{ inputs: TxIo[]; outputs: TxIo[] }>;
}

interface BlockfrostIo {
  tx_hash?: string;
  output_index: number;
  address: string;
  amount: { unit: string; quantity: string }[];
  inline_datum: string | null;
  reference?: boolean;
  collateral?: boolean;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Reader over a Blockfrost-shaped API (`GET /txs/{hash}/utxos`): Blockfrost on preprod, or Yaci
 * DevKit's Blockfrost-compatible store locally. Reference and collateral inputs are excluded.
 */
export function blockfrostTxReader(baseUrl: string, projectId?: string): ChainTxReader {
  const root = baseUrl.replace(/\/$/, "");
  const io = (txHash: string, r: BlockfrostIo): TxIo => ({
    txHash,
    outputIndex: r.output_index,
    address: r.address,
    assets: Object.fromEntries(r.amount.map((a) => [a.unit, BigInt(a.quantity)])),
    inlineDatum: r.inline_datum,
  });
  return {
    async tx(txHash) {
      if (!HEX64.test(txHash)) throw new Error(`not a transaction id: ${txHash}`);
      const res = await fetch(`${root}/txs/${txHash}/utxos`, { headers: projectId === undefined ? {} : { project_id: projectId }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`chain reader: ${txHash} answered HTTP ${res.status}`);
      const body = (await res.json()) as { inputs: BlockfrostIo[]; outputs: BlockfrostIo[] };
      return {
        inputs: body.inputs.filter((i) => i.reference !== true && i.collateral !== true).map((i) => io(i.tx_hash ?? "", i)),
        outputs: body.outputs.filter((o) => o.collateral !== true).map((o) => io(txHash, o)),
      };
    },
  };
}
