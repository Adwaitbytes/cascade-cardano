"use client";

import type { CascadeEvent } from "@cascade/shared/browser";
import { Amount } from "@/components/amount";
import { TxLink } from "@/components/tx-link";
import { cn } from "@/lib/cn";
import { EVENT_TONE, timeOf } from "./event-style";

/** Newest first. Selecting an event moves the replay cursor to it. */
export function EventFeed({ events, cursor, onSelect, describe, className }: { events: readonly CascadeEvent[]; cursor: number; onSelect: (cursor: number) => void; describe: (e: CascadeEvent) => string; className?: string }) {
  const items = events.map((event, index) => ({ event, index })).reverse();
  return (
    <ol className={cn("divide-y divide-line", className)} aria-label="Tree events, newest first" data-testid="event-feed">
      {items.map(({ event, index }) => {
        const applied = index < cursor;
        const moved = BigInt(event.value.amount) > 0n;
        return (
          <li key={event.event_id} className={cn("group relative flex gap-3 px-4 py-3 transition-[opacity,background-color] active:bg-surface-2 sm:px-5 sm:py-2.5", !applied && "opacity-45", index + 1 === cursor && "bg-surface-2")}>
            {index + 1 === cursor ? <span aria-hidden className={cn("absolute inset-y-0 left-0 w-0.5", EVENT_TONE[event.type])} /> : null}
            <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", EVENT_TONE[event.type])} />
            <div className="min-w-0 flex-1">
              <button type="button" onClick={() => onSelect(index + 1)} className="block text-left text-sm leading-snug after:absolute after:inset-0 after:content-[''] hover:underline hover:underline-offset-2 focus-visible:outline-none focus-visible:after:rounded-md focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus" aria-current={index + 1 === cursor ? "step" : undefined}>
                {describe(event)}
              </button>
              <p className="tabular mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-ink-3">
                <span>{timeOf(event.emitted_at)}</span>
                {moved ? <Amount value={event.value.amount} asset={event.value.asset} className="text-ink-2" /> : null}
                <TxLink txId={event.tx_id} className="relative z-10" />
                {event.confirmations < 3 ? <span className="text-working">{event.confirmations} confirmations</span> : null}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
