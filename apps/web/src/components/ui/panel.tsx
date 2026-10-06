import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Primary content surface. Radius and shadow are larger than inner controls on purpose. */
export function Panel({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("rounded-[20px] border border-line bg-surface shadow-card", className)} {...props} />;
}

export function PanelHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <header className={cn("flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4", className)}>
      <div className="min-w-0">
        <h2 className="text-[0.9375rem] font-semibold tracking-tight">{title}</h2>
        {description ? <p className="mt-0.5 text-[0.8125rem] text-ink-3">{description}</p> : null}
      </div>
      {action}
    </header>
  );
}

export function Stat({ label, value, sub, className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="font-mono text-[0.6875rem] tracking-[0.12em] text-ink-3 uppercase">{label}</dt>
      <dd className="tabular mt-1.5 truncate text-lg font-semibold tracking-tight">{value}</dd>
      {sub ? <dd className="tabular mt-0.5 text-[0.8125rem] text-ink-3">{sub}</dd> : null}
    </div>
  );
}
