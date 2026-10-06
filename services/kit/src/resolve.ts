/** Resolves output references to their address and value, from Ogmios or Blockfrost. */
import type { BlockfrostClient } from "./blockfrost.js";
import { parseOutRef } from "./chaintx.js";
import { ogmiosValue, type OgmiosClient } from "./ogmios.js";

export interface ResolvedOutput {
  address: string;
  lovelace: bigint;
  /** `policy.nameHex` to quantity. */
  assets: Record<string, bigint>;
  /** Inline datum CBOR hex, when the output has one. */
  datum?: string | null;
}

export type OutRefResolver = (refs: string[]) => Promise<Map<string, ResolvedOutput>>;

export function ogmiosResolver(ogmios: OgmiosClient): OutRefResolver {
  return async (refs) => {
    const out = new Map<string, ResolvedOutput>();
    if (refs.length === 0) return out;
    for (const u of await ogmios.utxosByRefs([...new Set(refs)].map(parseOutRef))) {
      const v = ogmiosValue(u.value);
      out.set(`${u.transaction.id}#${u.index}`, { address: u.address, lovelace: v.lovelace, assets: v.assets, datum: u.datum ?? null });
    }
    return out;
  };
}

export function blockfrostResolver(bf: BlockfrostClient): OutRefResolver {
  return async (refs) => {
    const out = new Map<string, ResolvedOutput>();
    const byTx = new Map<string, number[]>();
    for (const r of new Set(refs)) {
      const { txId, index } = parseOutRef(r);
      byTx.set(txId, [...(byTx.get(txId) ?? []), index]);
    }
    for (const [txId, idx] of byTx) {
      const u = await bf.get<{
        outputs: { address: string; output_index: number; amount: { unit: string; quantity: string | number }[]; collateral?: boolean | null; inline_datum?: string | null }[];
      }>(
        `/txs/${txId}/utxos`,
      );
      for (const o of u?.outputs ?? []) {
        if (!idx.includes(o.output_index) || o.collateral === true) continue;
        let lovelace = 0n;
        const assets: Record<string, bigint> = {};
        for (const a of o.amount) {
          if (a.unit === "lovelace") lovelace = BigInt(a.quantity);
          else assets[`${a.unit.slice(0, 56)}.${a.unit.slice(56)}`] = BigInt(a.quantity);
        }
        out.set(`${txId}#${o.output_index}`, { address: o.address, lovelace, assets, datum: o.inline_datum ?? null });
      }
    }
    return out;
  };
}
