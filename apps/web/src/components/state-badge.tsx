import { ArrowUpRight } from "lucide-react";
import { txUrl } from "@/lib/explorer";
import type { DisplayState } from "@/lib/tree/replay";
import { cn } from "@/lib/cn";

/** PRD 14.3 colours: Funded blue, Working amber, Submitted violet, Accepted green, Refunded grey, Challenged or Disputed red. */
export const STATE_STYLE: Record<DisplayState, { text: string; bg: string; bar: string }> = {
  Funded: { text: "text-funded", bg: "bg-funded-bg", bar: "bg-funded" },
  Working: { text: "text-working", bg: "bg-working-bg", bar: "bg-working" },
  Submitted: { text: "text-submitted", bg: "bg-submitted-bg", bar: "bg-submitted" },
  Accepted: { text: "text-accepted", bg: "bg-accepted-bg", bar: "bg-accepted" },
  Settled: { text: "text-accepted", bg: "bg-accepted-bg", bar: "bg-accepted" },
  Refunded: { text: "text-refunded", bg: "bg-refunded-bg", bar: "bg-refunded" },
  Challenged: { text: "text-challenged", bg: "bg-challenged-bg", bar: "bg-challenged" },
  Disputed: { text: "text-challenged", bg: "bg-challenged-bg", bar: "bg-challenged" },
};

/** A state badge is a link to the transaction that set the state (PRD 14.7). */
export function StateBadge({ state, txId, className }: { state: DisplayState; txId: string | null; className?: string }) {
  const style = STATE_STYLE[state];
  const body = (
    <>
      <span aria-hidden className={cn("size-1.5 rounded-full", style.bar)} />
      {state}
    </>
  );
  const base = cn("inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-semibold", style.text, style.bg, className);
  if (txId === null) {
    return (
      <span className={base} title="Waiting for a confirmed transaction">
        {body}
      </span>
    );
  }
  return (
    <a
      href={txUrl(txId, "contracts")}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(base, "group nodrag hover:underline hover:underline-offset-2")}
      aria-label={`${state}: open the transaction on Cardanoscan`}
      title="Open the redeemer and datum of the transaction that set this state"
      onClick={(e) => e.stopPropagation()}
    >
      {body}
      <ArrowUpRight aria-hidden className="size-3 opacity-60 group-hover:opacity-100" />
    </a>
  );
}
