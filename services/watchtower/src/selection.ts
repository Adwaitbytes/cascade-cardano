/**
 * Which permissionless transition each live node needs (PRD 11.5, 7.5, ADR 5.1). Pure: the loop
 * feeds it the indexer's view of live nodes and the chain's current time.
 *
 * Order of precedence per node:
 *   1. SettleChild  child Native, Accepted, or Submitted after challenge_until; children_open 0;
 *                   parent Funded
 *   2. Accept       child Submitted after challenge_until whose parent is not Funded (deadline
 *                   Accept, so it can settle once the parent is)
 *   3. CloseRoot    root Accepted, or Submitted after challenge_until (anyone after the window)
 *   4. Resolve      Challenged or Disputed after dispute_until (deadline split: all to the parent)
 *   5. CloseReceipt Masumi or metered receipt after its dispute_until (late close)
 *   6. Refund       Native, Funded, children_open 0, after refund_after
 *
 * Every time-gated crank waits `graceMs` past the deadline, because the validity lower bound must
 * be strictly after it and the tip lags wall-clock time.
 */
export const CRANK_KINDS = ["SettleChild", "Accept", "CloseRoot", "Resolve", "CloseReceipt", "Refund", "MasumiRefund", "MasumiReturn"] as const;
export type CrankKind = (typeof CRANK_KINDS)[number];

export interface LiveNode {
  nodeId: string;
  treeId: string;
  parentId: string | null;
  kind: "Native" | "MasumiReceipt" | "MeteredReceipt";
  state: "Funded" | "Submitted" | "Challenged" | "Disputed" | "Accepted";
  childrenOpen: number;
  submitBy: bigint;
  challengeUntil: bigint;
  refundAfter: bigint;
  disputeUntil: bigint;
  /** The UTxO the crank spends; the idempotency key. */
  currentUtxo: string;
}

export interface Crank {
  kind: CrankKind;
  nodeId: string;
  treeId: string;
  utxoRef: string;
  /** The deadline that made the node crankable (POSIX ms), for ordering and logs. */
  dueAt: bigint;
  /** Purchase-wallet cranks (ADR 0001 8.1): what the SDK driver needs to find the UTxO. */
  masumi?: { drawTx: string } | { escrowAddress: string; referenceSignature: string };
}

/** An AddressPayment the purchase wallet P holds and never locked. */
export interface PurchaserPayment {
  outRef: string;
  drawTx: string;
  treeId: string;
  /** The node that drew it. */
  nodeId: string;
  /** When P may return it (Draw time plus work window plus margin, as the signer's fence computes); null if unknown. */
  returnDueAt: bigint | null;
  /** The Masumi slot was marked failed: returnable at once. */
  failed: boolean;
}

/** One of P's vested_pay locks, as the indexer tracks it. */
export interface PurchaserLock {
  outRef: string;
  treeId: string;
  nodeId: string;
  escrowAddress: string;
  referenceSignature: string;
  state: string;
  resultHash: string;
  submitResultTime: bigint;
}

/**
 * Purchase-wallet cranks, so a failed Masumi leaf refunds the buyer without the operator:
 *   MasumiRefund  a lock with no result, FundsLocked or RefundRequested, after submit_result_time
 *                 (vested_pay lets the buyer WithdrawRefund directly then), or RefundAuthorized
 *   MasumiReturn  a payment P never locked, after its return time or once marked failed
 * Both are signed by P through the signer's masumi-purchaser fence, which only pays buyer_refund.
 */
export function selectPurchaserCranks(payments: readonly PurchaserPayment[], locks: readonly PurchaserLock[], o: SelectOptions): Crank[] {
  const past = (t: bigint) => o.now > t + o.graceMs;
  const out: Crank[] = [];
  for (const l of locks) {
    const noResult = l.resultHash === "";
    const due = l.state === "RefundAuthorized" || (noResult && (l.state === "FundsLocked" || l.state === "RefundRequested") && past(l.submitResultTime));
    if (!due) continue;
    out.push({ kind: "MasumiRefund", nodeId: l.nodeId, treeId: l.treeId, utxoRef: l.outRef, dueAt: l.submitResultTime, masumi: { escrowAddress: l.escrowAddress, referenceSignature: l.referenceSignature } });
  }
  for (const p of payments) {
    if (!p.failed && (p.returnDueAt === null || !past(p.returnDueAt))) continue;
    out.push({ kind: "MasumiReturn", nodeId: p.nodeId, treeId: p.treeId, utxoRef: p.outRef, dueAt: p.failed ? 0n : (p.returnDueAt ?? 0n), masumi: { drawTx: p.drawTx } });
  }
  return out;
}

export interface SelectOptions {
  now: bigint;
  graceMs: bigint;
}

export function selectCranks(nodes: readonly LiveNode[], o: SelectOptions): Crank[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const past = (t: bigint) => o.now > t + o.graceMs;
  const out: Crank[] = [];
  for (const n of nodes) {
    const crank = (kind: CrankKind, dueAt: bigint): void => {
      out.push({ kind, nodeId: n.nodeId, treeId: n.treeId, utxoRef: n.currentUtxo, dueAt });
    };
    const isRoot = n.parentId === null;
    const receipt = n.kind !== "Native";

    if (!isRoot && !receipt && n.childrenOpen === 0) {
      const parent = n.parentId === null ? undefined : byId.get(n.parentId);
      const windowLapsed = n.state === "Submitted" && past(n.challengeUntil);
      if (n.state === "Accepted" || windowLapsed) {
        if (parent?.state === "Funded") crank("SettleChild", n.state === "Accepted" ? 0n : n.challengeUntil);
        else if (windowLapsed) crank("Accept", n.challengeUntil);
        continue;
      }
    }
    if (isRoot && (n.state === "Accepted" || n.state === "Submitted") && past(n.challengeUntil)) {
      crank("CloseRoot", n.challengeUntil);
      continue;
    }
    if ((n.state === "Challenged" || n.state === "Disputed") && past(n.disputeUntil)) {
      crank("Resolve", n.disputeUntil);
      continue;
    }
    if (receipt && past(n.disputeUntil)) {
      crank("CloseReceipt", n.disputeUntil);
      continue;
    }
    if (!receipt && n.state === "Funded" && n.childrenOpen === 0 && past(n.refundAfter)) {
      crank("Refund", n.refundAfter);
    }
  }
  // Oldest deadlines first; children before parents so settlements free parents for their own cranks.
  return out.sort((a, b) => (a.dueAt === b.dueAt ? 0 : a.dueAt < b.dueAt ? -1 : 1));
}

export interface CrankResult {
  txId: string;
}

/** Builds, signs with the watchtower's own wallet (fees only) and submits one crank. */
export interface CrankExecutor {
  supports(kind: CrankKind): boolean;
  /** False while the executor cannot fund this kind yet (its fee wallet is settling); the crank waits unclaimed. */
  ready?(kind: CrankKind): Promise<boolean>;
  execute(crank: Crank): Promise<CrankResult>;
}

export interface DisputeAlert {
  nodeId: string;
  treeId: string;
  utxoRef: string;
  disputeUntil: bigint;
  msLeft: bigint;
}

/**
 * Disputed nodes inside `windowMs` of `dispute_until`. After that deadline anyone can resolve a
 * Disputed node and the worker is paid its fee by default (ADR 1.5 F5), so arbiters must act first.
 */
export function selectDisputeAlerts(nodes: readonly LiveNode[], now: bigint, windowMs: bigint): DisputeAlert[] {
  return nodes
    .filter((n) => n.state === "Disputed" && now <= n.disputeUntil && n.disputeUntil - now <= windowMs)
    .map((n) => ({ nodeId: n.nodeId, treeId: n.treeId, utxoRef: n.currentUtxo, disputeUntil: n.disputeUntil, msLeft: n.disputeUntil - now }))
    .sort((a, b) => (a.msLeft < b.msLeft ? -1 : 1));
}
