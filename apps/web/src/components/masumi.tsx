import { Hash } from "@/components/hash";
import { TxLink } from "@/components/tx-link";
import type { MasumiOutcome } from "@/lib/api/schemas";
import { cn } from "@/lib/cn";

const OUTCOME: Record<MasumiOutcome, { label: string; tone: string }> = {
  awaiting_lock: { label: "Waiting for the lock", tone: "bg-working-bg text-working" },
  locked: { label: "Locked in Masumi escrow", tone: "bg-funded-bg text-funded" },
  withdrawn: { label: "Paid to the seller", tone: "bg-accepted-bg text-accepted" },
  refunded: { label: "Refunded to the buyer", tone: "bg-refunded-bg text-refunded" },
};

export interface MasumiHire {
  drawTx: string;
  lockTx: string | null;
  blockchainIdentifier: string | null;
  outcome: MasumiOutcome;
  outcomeTx: string | null;
}

/**
 * ADR 0001 8.1: the Draw pays the purchase wallet, which makes a plain vested_pay lock the Masumi
 * seller recognises; the outcome is the seller's withdrawal or the refund to the buyer.
 */
export function MasumiHireDetail({ hire, className }: { hire: MasumiHire; className?: string }) {
  const outcome = OUTCOME[hire.outcome];
  return (
    <dl className={cn("grid gap-1 text-[0.8125rem]", className)} data-testid="masumi-hire">
      <div className="grid grid-cols-[8.5rem_1fr] items-baseline gap-2">
        <dt className="text-ink-3">Paid to purchaser</dt>
        <dd><TxLink txId={hire.drawTx} /></dd>
      </div>
      <div className="grid grid-cols-[8.5rem_1fr] items-baseline gap-2">
        <dt className="text-ink-3">Masumi lock</dt>
        <dd>{hire.lockTx === null ? <span className="text-ink-3">Not locked yet</span> : <TxLink txId={hire.lockTx} />}</dd>
      </div>
      <div className="grid grid-cols-[8.5rem_1fr] items-baseline gap-2">
        <dt className="text-ink-3">blockchainIdentifier</dt>
        <dd className="min-w-0">{hire.blockchainIdentifier === null ? <span className="text-ink-3">Not known yet</span> : <Hash value={hire.blockchainIdentifier} label="blockchainIdentifier" />}</dd>
      </div>
      <div className="grid grid-cols-[8.5rem_1fr] items-center gap-2">
        <dt className="text-ink-3">Outcome</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-semibold", outcome.tone)}>{outcome.label}</span>
          {hire.outcomeTx !== null ? <TxLink txId={hire.outcomeTx} /> : null}
        </dd>
      </div>
    </dl>
  );
}
