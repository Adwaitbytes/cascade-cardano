"use client";

import type { CascadeEvent } from "@cascade/shared/browser";
import { useMemo } from "react";
import { STATE_STYLE } from "@/components/state-badge";
import type { Tree } from "@/lib/api/schemas";
import { cn } from "@/lib/cn";
import { formatDurationShort } from "@/lib/plan/summary";
import { computeWaterfall } from "@/lib/tree/waterfall";
import { timeOf } from "./event-style";

/**
 * How long each node worked and how the nested work fits inside its parent: one bar per node from
 * hire to close, coloured by how it ended, with a tick at its submit deadline when that falls in view.
 */
export function Waterfall({ tree, events, now, nameOf, onOpen }: { tree: Tree; events: readonly CascadeEvent[]; now: number; nameOf: (id: string) => string; onOpen: (id: string) => void }) {
  const w = useMemo(() => computeWaterfall(tree, events, now), [tree, events, now]);
  const span = w.to - w.from;
  const pct = (t: number): number => ((t - w.from) / span) * 100;
  if (w.rows.length === 0) return <p className="p-5 text-sm text-ink-3">The waterfall appears when the buyer funds the root.</p>;

  return (
    <div className="p-4 sm:p-5" data-testid="waterfall">
      <div className="mb-2 grid grid-cols-[minmax(8rem,14rem)_1fr] gap-3 text-xs text-ink-3">
        <span>Node</span>
        <span className="flex justify-between">
          <span>{timeOf(w.from)}</span>
          <span>{formatDurationShort(span)} in total</span>
          <span>{timeOf(w.to)}</span>
        </span>
      </div>
      <ol className="grid gap-1">
        {w.rows.map((r) => {
          const style = STATE_STYLE[r.state];
          const left = pct(r.start);
          const width = Math.max(0.6, pct(r.end) - left);
          const deadlineInView = r.submitBy >= w.from && r.submitBy <= w.to;
          const label = `${nameOf(r.nodeId)}: ${formatDurationShort(r.end - r.start)}${r.open ? " so far" : ""}, ${r.state.toLowerCase()}`;
          return (
            <li key={r.nodeId}>
              <button
                type="button"
                onClick={() => onOpen(r.nodeId)}
                className="grid w-full grid-cols-[minmax(8rem,14rem)_1fr] items-center gap-3 rounded-md py-1 text-left hover:bg-surface-2"
                aria-label={`${label}. Open details`}
                title={`${timeOf(r.start)} to ${r.open ? "now" : timeOf(r.end)}${r.submittedAt === null ? "" : `, submitted ${timeOf(r.submittedAt)}`}, submit deadline ${timeOf(r.submitBy)}`}
              >
                <span className="flex min-w-0 items-center gap-2 text-sm" style={{ paddingLeft: `${Math.min(r.depth, 5) * 0.9}rem` }}>
                  <span aria-hidden className={cn("size-2 shrink-0 rounded-full", style.bar)} />
                  <span className="truncate">{nameOf(r.nodeId)}</span>
                </span>
                <span className="relative h-6 rounded bg-surface-2/60">
                  <span
                    className={cn("absolute inset-y-1 rounded", style.bar, r.open && "opacity-60", r.state === "Refunded" && "opacity-50")}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                  {r.submittedAt !== null ? <span aria-hidden className="absolute inset-y-0.5 w-0.5 rounded bg-ink" style={{ left: `${pct(r.submittedAt)}%` }} /> : null}
                  {deadlineInView ? <span aria-hidden className="absolute inset-y-0 w-px border-l border-dashed border-challenged" style={{ left: `${pct(r.submitBy)}%` }} /> : null}
                  {/* Labels sit after the bar, or before it when the bar reaches the right edge. */}
                  <span
                    className="tabular absolute top-1/2 -translate-y-1/2 px-1.5 text-[0.7rem] text-ink-2"
                    style={left + width > 88 ? { right: `${100 - left}%` } : { left: `${left + width}%` }}
                  >
                    {formatDurationShort(r.end - r.start)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-3 w-0.5 rounded bg-ink" />Result submitted</span>
        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-3 w-px border-l border-dashed border-challenged" />Submit deadline, when in view</span>
      </p>
    </div>
  );
}
