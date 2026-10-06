import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** The ring leaves a gap at the bottom, like a dial, so 0 and 100 never touch. */
const SWEEP = 0.78;

/** Reputation dial: the arc is the score, the figure in the middle is the same number. */
export function ScoreGauge({ score, children, className }: { score: number; children: ReactNode; className?: string }) {
  const value = Math.max(0, Math.min(1, score));
  const track = CIRCUMFERENCE * SWEEP;
  const low = value < 0.55;
  return (
    <div className={cn("relative grid size-[8.5rem] place-items-center", className)}>
      <svg viewBox="0 0 120 120" aria-hidden className="absolute inset-0 size-full" style={{ transform: `rotate(${90 + (360 * (1 - SWEEP)) / 2}deg)` }}>
        <circle cx="60" cy="60" r={RADIUS} fill="none" stroke="var(--line)" strokeWidth="7" strokeLinecap="round" strokeDasharray={`${track} ${CIRCUMFERENCE}`} />
        <circle
          cx="60"
          cy="60"
          r={RADIUS}
          fill="none"
          stroke={low ? "var(--s-challenged)" : "var(--accent)"}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${track * value} ${CIRCUMFERENCE}`}
          className="motion-safe:animate-[fade-in_700ms_var(--ease-out-quint)_both]"
        />
      </svg>
      <div className="relative text-center">{children}</div>
    </div>
  );
}
