import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("font-mono text-[0.6875rem] tracking-[0.22em] text-ink-3 uppercase", className)}>{children}</p>;
}

/** Page header shared by the network, provider and agent pages: eyebrow, pixel title, one plain line, pill actions. */
export function PageIntro({ eyebrow, title, description, actions, className }: { eyebrow: ReactNode; title: ReactNode; description: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cn("mb-8 flex flex-col gap-6 sm:mb-10 lg:flex-row lg:items-end lg:justify-between", className)}>
      <div className="max-w-2xl motion-safe:animate-[rise_600ms_var(--ease-out-quint)_both]">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-4 text-[clamp(2rem,4.2vw,3rem)] leading-[1.04]">{title}</h1>
        <p className="mt-3 max-w-xl text-[0.9375rem] leading-relaxed text-ink-2 sm:text-base">{description}</p>
      </div>
      {actions ? <div className="flex flex-wrap gap-2.5 motion-safe:animate-[rise_600ms_var(--ease-out-quint)_120ms_both]">{actions}</div> : null}
    </header>
  );
}

/** Section title row: title, a hairline rule, and a mono note on the right. */
export function SectionTitle({ title, note, id, className }: { title: ReactNode; note?: ReactNode; id?: string; className?: string }) {
  return (
    <div className={cn("mb-4 flex items-center gap-4", className)}>
      <h2 id={id} className="shrink-0 text-[1.0625rem] font-semibold tracking-tight">{title}</h2>
      <span aria-hidden className="h-px flex-1 bg-line" />
      {note ? <span className="hidden shrink-0 font-mono text-[0.6875rem] tracking-[0.18em] text-ink-3 uppercase sm:inline">{note}</span> : null}
    </div>
  );
}

/** Mono eyebrow over a large pixel figure. */
export function BigStat({ label, value, sub, className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 bg-surface px-5 py-5 sm:px-6", className)}>
      <dt className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3 uppercase">{label}</dt>
      <dd className="tabular mt-2.5 truncate font-display text-[1.5rem] leading-tight tracking-[-0.02em] sm:text-[1.75rem]">{value}</dd>
      {sub ? <dd className="mt-1 truncate text-[0.8125rem] text-ink-3">{sub}</dd> : null}
    </div>
  );
}
