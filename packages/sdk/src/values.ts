import type { Assets } from "@lucid-evolution/lucid";
import type { AssetClass, NodeDatum } from "@cascade/shared";

export const isLovelace = (a: AssetClass): boolean => a.policy === "" && a.name === "";
export const assetUnit = (a: AssetClass): string => (isLovelace(a) ? "lovelace" : a.policy + a.name);

export function addAssets(...values: Assets[]): Assets {
  const out: Assets = {};
  for (const v of values) {
    for (const [unit, q] of Object.entries(v)) {
      const next = (out[unit] ?? 0n) + q;
      if (next === 0n) delete out[unit];
      else out[unit] = next;
    }
  }
  return out;
}

export const negate = (v: Assets): Assets => Object.fromEntries(Object.entries(v).map(([u, q]) => [u, -q]));

export function assertNonNegative(v: Assets, what: string): Assets {
  for (const [unit, q] of Object.entries(v)) if (q < 0n) throw new Error(`${what}: negative ${unit} ${q}`);
  return v;
}

/** `from_asset(asset, q) + from_lovelace(l)`, merged, zero entries dropped. */
export const assetPlusLovelace = (asset: AssetClass, quantity: bigint, lovelace: bigint): Assets =>
  addAssets({ [assetUnit(asset)]: quantity }, { lovelace });

/** Value a node holds of the tree asset: `budget - committed - spent` (ADR 1.5); receipts hold none. */
export const heldOf = (d: NodeDatum): bigint => (d.kind === "Native" ? d.budget - d.committed - d.spent : 0n);

/** Mirror of `value.expected_value`: held asset + structural lovelace + thread token. */
export function nodeValue(asset: AssetClass, policyId: string, d: NodeDatum): Assets {
  const escrow = heldOf(d);
  return addAssets(assetPlusLovelace(asset, escrow, d.structural), { [policyId + d.node_id]: 1n });
}
