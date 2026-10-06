import type { Receipt } from "@/lib/api/schemas";

export interface Reconciliation {
  asset: string;
  deposits: bigint;
  payouts: bigint;
  refunds: bigint;
  fees: bigint;
  /** Structural ADA returned, in lovelace. Part of the equation only for ADA trees. */
  structuralLovelace: bigint;
  structuralInEquation: boolean;
  /** Right-hand side of the equation in the tree asset. */
  accounted: bigint;
  /** deposits minus accounted; zero when balanced. */
  difference: bigint;
  balanced: boolean;
  /** The indexer's own `balanced` flag agrees with this recomputation. */
  indexerAgrees: boolean;
  /** deposited = paid + returned, when the indexer reports the structural split. */
  structural: { deposited: bigint; paid: bigint; returned: bigint; balanced: boolean } | null;
  errors: string[];
}

/**
 * PRD 7.6 invariant 1: deposits = payouts + refunds + fees + structural ADA returned. For a tUSDM
 * tree the structural ADA is a separate asset, so the tUSDM side must balance on its own and the
 * structural lovelace is reported next to it; for an ADA tree it is part of the same sum.
 */
export function reconcile(receipt: Receipt): Reconciliation {
  const errors: string[] = [];
  const asset = receipt.deposits.asset;
  for (const [name, v] of [["payouts", receipt.payouts], ["refunds", receipt.refunds], ["fees", receipt.fees]] as const) {
    if (v.asset !== asset) errors.push(`${name} are in ${v.asset}, deposits are in ${asset}`);
  }
  const deposits = BigInt(receipt.deposits.amount);
  const payouts = BigInt(receipt.payouts.amount);
  const refunds = BigInt(receipt.refunds.amount);
  const fees = BigInt(receipt.fees.amount);
  const structuralLovelace = BigInt(receipt.structural_returned_lovelace);
  const structuralInEquation = asset === "lovelace";
  const accounted = payouts + refunds + fees + (structuralInEquation ? structuralLovelace : 0n);
  const difference = deposits - accounted;
  const structural =
    receipt.structural_deposited_lovelace === undefined || receipt.structural_paid_lovelace === undefined
      ? null
      : (() => {
          const deposited = BigInt(receipt.structural_deposited_lovelace);
          const paid = BigInt(receipt.structural_paid_lovelace);
          return { deposited, paid, returned: structuralLovelace, balanced: deposited === paid + structuralLovelace };
        })();
  const balanced = errors.length === 0 && difference === 0n && (structural?.balanced ?? true);
  return {
    asset,
    deposits,
    payouts,
    refunds,
    fees,
    structuralLovelace,
    structuralInEquation,
    accounted,
    difference,
    balanced,
    indexerAgrees: receipt.balanced === balanced,
    structural,
    errors,
  };
}

/** Sums the receipt lines of one kind in one asset, for cross-checking the totals. */
export function sumLines(receipt: Receipt, kinds: Receipt["lines"][number]["kind"][], asset: string): bigint {
  return receipt.lines.filter((l) => kinds.includes(l.kind) && l.value.asset === asset).reduce((sum, l) => sum + BigInt(l.value.amount), 0n);
}
