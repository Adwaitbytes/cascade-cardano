import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

const STEPS = ["Describe", "Review", "Fund and watch"] as const;

/** Where the buyer is in the three-step job flow. */
export function JobSteps({ current }: { current: 0 | 1 | 2 }) {
  return (
    <ol aria-label="Job steps" className="flex flex-wrap items-center gap-1.5 rounded-full border border-line bg-surface/80 p-1 shadow-card backdrop-blur">
      {STEPS.map((step, i) => (
        <li
          key={step}
          aria-current={i === current ? "step" : undefined}
          className={cn(
            "inline-flex h-8 items-center gap-2 rounded-full px-2.5 sm:px-3 font-mono text-[0.75rem] tracking-[0.02em]",
            i === current ? "bg-ink text-bg" : i < current ? "text-ink-2" : "text-ink-3",
          )}
        >
          <span aria-hidden className={cn("grid size-4 place-items-center rounded-full text-[0.625rem]", i === current ? "bg-bg/15" : i < current ? "bg-accent-soft text-accent" : "border border-line-strong")}>
            {i < current ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}
          </span>
          <span className={i === current ? undefined : "max-sm:sr-only"}>{step}</span>
        </li>
      ))}
    </ol>
  );
}
