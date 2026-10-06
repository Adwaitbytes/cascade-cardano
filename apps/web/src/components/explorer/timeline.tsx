"use client";

import type { CascadeEvent } from "@cascade/shared/browser";
import { Pause, Play, Radio, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useId } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { EVENT_TONE, timeOf } from "./event-style";

export interface TimelineProps {
  events: readonly CascadeEvent[];
  cursor: number;
  onCursor: (cursor: number) => void;
  playing: boolean;
  onPlaying: (playing: boolean) => void;
  following: boolean;
  onFollow: () => void;
  describe: (event: CascadeEvent) => string;
  closed: boolean;
  /** Milliseconds per event while playing; stage mode slows it down for the projector. */
  stepMs?: number;
}

const STEP_MS = 1500;

/** Replays the tree from funding to close, one indexed event at a time (PRD 14.3). */
export function Timeline({ events, cursor, onCursor, playing, onPlaying, following, onFollow, describe, closed, stepMs = STEP_MS }: TimelineProps) {
  const inputId = useId();
  const total = events.length;
  const current = cursor > 0 ? events[cursor - 1] : undefined;

  useEffect(() => {
    if (!playing) return;
    if (cursor >= total) {
      onPlaying(false);
      return;
    }
    const id = setTimeout(() => onCursor(cursor + 1), stepMs);
    return () => clearTimeout(id);
  }, [playing, cursor, total, onCursor, onPlaying, stepMs]);

  const play = (): void => {
    if (cursor >= total) onCursor(1);
    onPlaying(!playing);
  };

  // J and K step through events, Space plays or pauses; ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target !== null && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "J") onCursor(Math.max(0, cursor - 1));
      else if (e.key === "k" || e.key === "K") onCursor(Math.min(total, cursor + 1));
      else if (e.key === " " && target?.tagName !== "BUTTON") {
        e.preventDefault();
        if (cursor >= total) onCursor(1);
        onPlaying(!playing);
      } else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cursor, total, playing, onCursor, onPlaying]);

  const markers = events.flatMap((e, i) => (e.type === "node.refunded" ? [{ i, label: "Refund" }] : e.type === "tree.closed" ? [{ i, label: "Close" }] : []));

  return (
    // On phones the controls stay pinned to the bottom of the screen while the explorer is in view.
    <div
      className="grid grid-cols-1 gap-3 border-t border-line bg-surface px-4 py-3.5 max-sm:sticky max-sm:bottom-0 max-sm:z-20 max-sm:bg-surface/95 max-sm:pb-[max(0.875rem,env(safe-area-inset-bottom))] max-sm:shadow-[0_-12px_24px_-16px_rgb(11_11_12/0.25)] max-sm:backdrop-blur sm:px-5"
      data-testid="timeline"
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2.5">
        <Button variant="secondary" size="icon" className="size-11 rounded-full sm:size-8" onClick={() => onCursor(Math.max(0, cursor - 1))} disabled={cursor === 0} aria-label="Previous event">
          <SkipBack />
        </Button>
        <Button variant="primary" size="icon" className="size-11 rounded-full sm:size-9" onClick={play} disabled={total === 0} aria-label={playing ? "Pause replay" : "Replay from the start"}>
          {playing ? <Pause /> : <Play />}
        </Button>
        <Button variant="secondary" size="icon" className="size-11 rounded-full sm:size-8" onClick={() => onCursor(Math.min(total, cursor + 1))} disabled={cursor >= total} aria-label="Next event">
          <SkipForward />
        </Button>
        <div className="order-first min-w-0 basis-full sm:order-none sm:ml-2 sm:flex-1 sm:basis-0" aria-live="polite">
          <p key={cursor} className="swap-in truncate text-sm font-medium tracking-tight">{current === undefined ? "Before funding" : describe(current)}</p>
          <p className="tabular mt-0.5 truncate font-mono text-[0.72rem] text-ink-3">
            {current === undefined ? `${total} events indexed` : `Event ${cursor} of ${total}, ${timeOf(current.emitted_at)}`}
          </p>
        </div>
        <Button variant={following ? "secondary" : "ghost"} size="sm" onClick={onFollow} className={cn("ml-auto h-11 shrink-0 px-4 sm:ml-0 sm:h-8 sm:px-3", following && "border-accepted/50 bg-accepted-bg/40")} aria-pressed={following}>
          <Radio className={cn(following && !closed && "text-accepted")} />
          <span>{closed ? "End" : "Live"}</span>
        </Button>
      </div>
      <div className="relative">
        {markers.length > 0 ? (
          <div aria-hidden className="relative mx-[7px] h-4" data-testid="timeline-markers">
            {markers.map((m) => (
              <button
                key={m.i}
                type="button"
                tabIndex={-1}
                onClick={() => onCursor(m.i + 1)}
                className="pointer-events-auto absolute bottom-0 -translate-x-1/2 font-mono text-[0.65rem] leading-none tracking-[0.06em] text-ink-2 hover:text-ink"
                style={{ left: `${((m.i + 0.5) / Math.max(1, total)) * 100}%` }}
              >
                {m.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="relative">
        <div aria-hidden className="pointer-events-none absolute inset-x-[7px] top-1/2 flex h-3 -translate-y-1/2 items-center gap-px">
          {events.map((e, i) => (
            <span key={e.event_id} className={cn("h-full flex-1 rounded-[2px] transition-opacity duration-300", EVENT_TONE[e.type], i < cursor ? "opacity-90" : "opacity-20")} />
          ))}
        </div>
        <label htmlFor={inputId} className="sr-only">
          Timeline position
        </label>
        <input
          id={inputId}
          type="range"
          min={0}
          max={total}
          step={1}
          value={cursor}
          onChange={(e) => {
            onPlaying(false);
            onCursor(Number(e.target.value));
          }}
          aria-valuetext={current === undefined ? "Before funding" : `Event ${cursor} of ${total}: ${describe(current)}`}
          className="timeline-range relative h-6 w-full cursor-pointer appearance-none bg-transparent"
        />
        </div>
      </div>
    </div>
  );
}
