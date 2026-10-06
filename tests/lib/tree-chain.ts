/**
 * Reads a Cascade tree back from chain transactions: node datums by thread token, escrow address
 * matching by script hash, and the token check that proves a tree fully closed.
 */
import { readFileSync } from "node:fs";
import { getAddressDetails } from "@lucid-evolution/lucid";
import { decodeNodeDatum, plutusAddressToBech32, type NodeDatum } from "@cascade/shared";
import { z } from "zod";
import { getAssetHolding, type ChainTx } from "./chain.js";
import { repoPath } from "./repo.js";

const Scripts = z.looseObject({
  scripts: z.object({
    cascade_node: z.object({ hash: z.string() }),
    cascade_config: z.object({ hash: z.string() }),
    cascade_bond: z.object({ hash: z.string() }),
    cascade_channel: z.object({ hash: z.string() }),
  }),
});

export interface CascadeHashes {
  node: string;
  config: string;
  bond: string;
  channel: string;
}

export function preprodHashes(): CascadeHashes {
  const s = Scripts.parse(JSON.parse(readFileSync(repoPath("deployments", "preprod.json"), "utf8"))).scripts;
  return { node: s.cascade_node.hash, config: s.cascade_config.hash, bond: s.cascade_bond.hash, channel: s.cascade_channel.hash };
}

/** True when the address's payment credential is a Cascade script (or one of `extra`, e.g. the Masumi lock). */
export function escrowMatcher(h: CascadeHashes, extra: string[] = []): (address: string) => boolean {
  const set = new Set([h.node, h.config, h.bond, h.channel, ...extra]);
  return (address) => {
    try {
      const cred = getAddressDetails(address).paymentCredential;
      return cred?.type === "Script" && set.has(cred.hash);
    } catch {
      return false;
    }
  };
}

/** Every node datum seen in `txs`, keyed by node id, in the order given (later txs override earlier). */
export function nodeDatums(txs: ChainTx[], policyId: string): Map<string, NodeDatum> {
  const out = new Map<string, NodeDatum>();
  for (const tx of txs) {
    for (const o of tx.outputs) {
      const token = o.assets.find((a) => a.unit.startsWith(policyId) && a.unit.length === 56 + 56);
      if (token === undefined || o.inlineDatum === null) continue;
      try {
        out.set(token.unit.slice(56), decodeNodeDatum(o.inlineDatum));
      } catch {
        // Not a node datum (a config or channel output); skip.
      }
    }
  }
  return out;
}

export const payeeAddress = (d: NodeDatum): string => plutusAddressToBech32(d.payee, 0);

/** Lovelace into and out of escrow across `txs`; equal values mean nothing was created or lost. */
export function escrowFlows(txs: Iterable<ChainTx>, isEscrow: (address: string) => boolean): { deposited: bigint; released: bigint } {
  let deposited = 0n;
  let released = 0n;
  for (const tx of txs) {
    const into = tx.outputs.filter((o) => isEscrow(o.address)).reduce((s, o) => s + o.lovelace, 0n);
    const from = tx.inputs.filter((i) => isEscrow(i.address)).reduce((s, i) => s + i.lovelace, 0n);
    if (into > from) deposited += into - from;
    else released += from - into;
  }
  return { deposited, released };
}

/** True when no UTxO holds the token `policyId ++ name` any more. */
export async function tokenBurned(policyId: string, name: string): Promise<boolean> {
  return (await getAssetHolding(policyId + name)) === null;
}
