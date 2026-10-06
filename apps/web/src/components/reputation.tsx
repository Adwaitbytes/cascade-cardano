import { cn } from "@/lib/cn";

/** Reputation as a 0 to 100 score; the arc makes low scores visible at a glance. */
export function Reputation({ score, className }: { score: number; className?: string }) {
  const value = Math.round(Math.max(0, Math.min(1, score)) * 100);
  const tone = value >= 55 ? "text-ink-2" : "text-challenged";
  const circumference = 2 * Math.PI * 7;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-semibold tabular", tone, className)} title={`Reputation ${value} of 100`}>
      <svg viewBox="0 0 18 18" className="size-4 -rotate-90" aria-hidden>
        <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.4" />
        <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeDasharray={`${(value / 100) * circumference} ${circumference}`} />
      </svg>
      <span>{value}</span>
      <span className="sr-only">reputation out of 100</span>
    </span>
  );
}
