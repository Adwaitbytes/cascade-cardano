/**
 * Tree receipts (PRD 17.2, invariant 1): reconciliation computed from the tree's non-rolled-back
 * events and their ledger flows, signed by the indexer oracle key as CIP-8 COSE_Sign1 over
 * SHA-256(JCS(receipt without signature)).
 */
import { jcsSha256 } from "@cascade/shared/browser";
import { coseKeyOf, coseSign1, type CoseSigner } from "@cascade/service-kit/cose";
import type { Flow, FlowKind } from "./projector.js";

export type ReceiptLineKind = "deposit" | "fee" | "masumi" | "refund" | "protocol_fee" | "bond_return" | "bond_slash" | "structural";

export interface ReceiptLine {
  node_id: string;
  kind: ReceiptLineKind;
  to: string;
  value: { asset: string; amount: string };
  tx_id: string;
  /** Masumi lock lines only: the lock's blockchainIdentifier (A3). */
  blockchain_identifier?: string;
  /** `masumi` lines (ADR 0001 8.1): the payment to P (`tx_id` is the Draw), P's lock tx and the outcome. */
  payment_out_ref?: string;
  lock_tx?: string | null;
  outcome?: "awaiting_lock" | "locked" | "refunded" | "withdrawn";
  outcome_tx?: string | null;
  /** Payment lines of a Draw that paid an x402 endpoint (A5): the endpoint's PAYMENT-RESPONSE. */
  payment_response?: unknown;
}

/**
 * Invariant 1 (PRD 7.6) as the explorer checks it: deposits = payouts + refunds + fees +
 * structural_returned_lovelace. For an ADA tree structural ADA is the same asset, so `deposits`
 * includes the structural ADA put in (root reserve, config min-ADA) and `payouts` the structural ADA
 * paid out with payouts (payee and escrow min-ADA). For a token tree the token totals balance on
 * their own and the structural lovelace balances separately:
 * structural_deposited_lovelace = structural_paid_lovelace + structural_returned_lovelace.
 */
export interface UnsignedReceipt {
  tree_id: string;
  deposits: { asset: string; amount: string };
  payouts: { asset: string; amount: string };
  refunds: { asset: string; amount: string };
  fees: { asset: string; amount: string };
  structural_deposited_lovelace: string;
  structural_paid_lovelace: string;
  structural_returned_lovelace: string;
  balanced: boolean;
  lines: ReceiptLine[];
}

export interface Receipt extends UnsignedReceipt {
  key: string;
  signature: string;
}

export interface FlowRecord {
  txId: string;
  flow: Flow;
}

const LINE_KIND: Record<FlowKind, ReceiptLineKind> = {
  deposit: "deposit",
  fee: "fee",
  masumi: "masumi",
  refund: "refund",
  protocol_fee: "protocol_fee",
  structural_in: "structural",
  structural_out: "structural",
  structural_returned: "structural",
};

export interface ReconcileInput {
  treeId: string;
  asset: string;
  closed: boolean;
  flows: FlowRecord[];
}

export interface Reconciliation {
  receipt: UnsignedReceipt;
  totals: {
    deposits: bigint;
    payouts: bigint;
    refunds: bigint;
    protocolFees: bigint;
    structuralIn: bigint;
    structuralOut: bigint;
    structuralReturned: bigint;
  };
}

export function reconcile(input: ReconcileInput): Reconciliation {
  const t = { deposits: 0n, payouts: 0n, refunds: 0n, protocolFees: 0n, structuralIn: 0n, structuralOut: 0n, structuralReturned: 0n };
  const lines: ReceiptLine[] = [];
  for (const { txId, flow } of input.flows) {
    switch (flow.kind) {
      case "deposit":
        t.deposits += flow.amount;
        break;
      case "fee":
      case "masumi":
        t.payouts += flow.amount;
        break;
      case "refund":
        t.refunds += flow.amount;
        break;
      case "protocol_fee":
        t.protocolFees += flow.amount;
        break;
      case "structural_in":
        t.structuralIn += flow.amount;
        break;
      case "structural_out":
        t.structuralOut += flow.amount;
        break;
      case "structural_returned":
        t.structuralReturned += flow.amount;
        break;
    }
    lines.push({
      node_id: flow.node_id,
      kind: LINE_KIND[flow.kind],
      to: flow.to,
      value: { asset: flow.asset, amount: flow.amount.toString() },
      tx_id: txId,
      ...(flow.blockchain_identifier === undefined ? {} : { blockchain_identifier: flow.blockchain_identifier }),
      ...(flow.out_ref === undefined ? {} : { payment_out_ref: flow.out_ref }),
    });
  }
  const valueBalanced = t.deposits === t.payouts + t.refunds + t.protocolFees;
  const structuralBalanced = t.structuralIn === t.structuralOut + t.structuralReturned;
  const v = (amount: bigint) => ({ asset: input.asset, amount: amount.toString() });
  const adaTree = input.asset === "lovelace";
  return {
    receipt: {
      tree_id: input.treeId,
      deposits: v(t.deposits + (adaTree ? t.structuralIn : 0n)),
      payouts: v(t.payouts + (adaTree ? t.structuralOut : 0n)),
      refunds: v(t.refunds),
      fees: v(t.protocolFees),
      structural_deposited_lovelace: t.structuralIn.toString(),
      structural_paid_lovelace: t.structuralOut.toString(),
      structural_returned_lovelace: t.structuralReturned.toString(),
      balanced: input.closed && valueBalanced && structuralBalanced,
      lines,
    },
    totals: t,
  };
}

export function signReceipt(receipt: UnsignedReceipt, oracle: CoseSigner): Receipt {
  const body = { ...receipt, key: coseKeyOf(oracle) };
  const { signature } = coseSign1(jcsSha256(body), oracle);
  return { ...body, signature };
}
