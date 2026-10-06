import { CheckCircle2, XCircle } from "lucide-react";
import { formatLovelace } from "@/lib/assets";
import { cn } from "@/lib/cn";
import type { Reconciliation } from "@/lib/receipt/reconcile";

/**
 * PRD 7.6 invariant 1 as one exact line in base units, under the invoice total:
 * deposits = payouts + returned to buyer + fees (+ structural ADA for an ADA tree).
 */
export function ReconciliationLine({ r }: { r: Reconciliation }) {
  const unit = r.asset === "lovelace" ? "lovelace" : "base units";
  // In an ADA tree the min-ADA sent into Masumi escrow is part of payouts; it gets its own term so the line matches the invoice rows.
  const escrow = r.structuralInEquation ? (r.structural?.paid ?? 0n) : 0n;
  const terms = [r.payouts - escrow, ...(escrow > 0n ? [escrow] : []), r.refunds, r.fees, ...(r.structuralInEquation ? [r.structuralLovelace] : [])];
  const names = ["paid to agents", ...(escrow > 0n ? ["structural in escrow"] : []), "returned", "fees", ...(r.structuralInEquation ? ["structural returned"] : [])];
  return (
    <div className="grid gap-1.5" data-testid="reconciliation">
      <p className={cn("inline-flex items-center gap-1.5 text-sm font-semibold", r.balanced ? "text-accepted" : "text-challenged")}>
        {r.balanced ? <CheckCircle2 className="size-4" aria-hidden /> : <XCircle className="size-4" aria-hidden />}
        {r.balanced ? `Balanced to the last ${r.asset === "lovelace" ? "lovelace" : "base unit"}` : `Off by ${r.difference.toLocaleString("en-US")} ${unit}`}
      </p>
      <p className="font-mono text-[0.75rem] break-words text-ink-2" title={`deposits = ${names.join(" + ")}, in ${unit}`}>
        {r.deposits.toLocaleString("en-US")} = {terms.map((t) => t.toLocaleString("en-US")).join(" + ")}
      </p>
      {!r.structuralInEquation ? (
        <p className="text-xs text-ink-3">
          Structural ADA returned separately: <span className="font-mono">{formatLovelace(r.structuralLovelace)}</span>
          {r.structural !== null && !r.structural.balanced ? <span className="font-semibold text-challenged"> (does not balance)</span> : null}
        </p>
      ) : null}
      {!r.indexerAgrees ? <p className="text-xs font-semibold text-challenged">The indexer's balanced flag disagrees with this check.</p> : null}
      {r.errors.map((e) => (
        <p key={e} className="text-xs text-challenged">{e}</p>
      ))}
    </div>
  );
}
