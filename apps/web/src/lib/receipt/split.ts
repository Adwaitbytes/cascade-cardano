import type { Receipt, Tree } from "@/lib/api/schemas";
import type { Reconciliation } from "./reconcile";

export interface PayoutSplit {
  /** Payouts in the tree asset that reached agents. */
  toAgents: bigint;
  /** Structural ADA paid into Masumi escrow outputs: part of payouts, but not an agent's fee. */
  toEscrow: bigint;
  structuralByNode: Map<string, bigint>;
  /** Distinct agents with a non-zero payout. */
  agents: number;
}

/** Separates agent fees from the structural ADA that rides along with Masumi escrow outputs, so the totals add up line by line. */
export function splitPayouts(receipt: Receipt, rec: Reconciliation, tree: Tree, paidByNode: Map<string, bigint>): PayoutSplit {
  const structuralByNode = new Map<string, bigint>();
  for (const l of receipt.lines) {
    if (l.kind !== "structural" || l.value.asset !== "lovelace" || l.node_id === tree.tree_id) continue;
    structuralByNode.set(l.node_id, (structuralByNode.get(l.node_id) ?? 0n) + BigInt(l.value.amount));
  }
  // For an ADA tree the escrow min-ADA is inside `payouts`; for a token tree it is a separate asset.
  const toEscrow = rec.structural?.paid ?? [...structuralByNode.values()].reduce((a, b) => a + b, 0n);
  const toAgents = rec.structuralInEquation ? rec.payouts - toEscrow : rec.payouts;
  const agentKeys = new Set<string>();
  for (const [nodeId, amount] of paidByNode) {
    if (amount <= 0n) continue;
    const node = tree.nodes.find((n) => n.node_id === nodeId);
    agentKeys.add(node?.agent_asset_id ?? node?.agent_name ?? nodeId);
  }
  return { toAgents, toEscrow, structuralByNode, agents: agentKeys.size };
}
