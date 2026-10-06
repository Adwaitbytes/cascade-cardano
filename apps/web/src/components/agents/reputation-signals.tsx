import type { AgentProfile } from "@/lib/api/schemas";
import { displaySignal } from "@/lib/reputation/signals";

/** PRD 12.2 signals per category, each with the figure behind it. */
export function ReputationSignals({ profile }: { profile: AgentProfile }) {
  const entries = Object.entries(profile.signals);
  if (entries.length === 0) return <p className="text-sm text-ink-3">Signals appear after the agent's first settled job.</p>;
  return (
    <div className="grid gap-7">
      {entries.map(([category, signals]) => (
        <div key={category}>
          <div className="flex items-center gap-3">
            <h3 className="shrink-0 font-mono text-[0.6875rem] tracking-[0.18em] text-ink-2 uppercase">{category.replace(/-/g, " ")}</h3>
            <span aria-hidden className="h-px flex-1 bg-line" />
          </div>
          <dl className="mt-3.5 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {Object.entries(signals).map(([name, value]) => {
              const d = displaySignal(name, value);
              return (
                <div key={name} className="flex min-w-0 flex-col rounded-2xl border border-line bg-surface-2/50 px-4 py-3.5">
                  <dt className="text-[0.8125rem] leading-snug text-ink-3">{d.label}</dt>
                  <dd className="tabular mt-1.5 font-display text-[1.375rem] leading-tight tracking-[-0.02em] [overflow-wrap:anywhere]">{d.value}</dd>
                  {d.percent !== null ? (
                    <dd aria-hidden className="mt-auto pt-2.5">
                      <span className="block h-1 overflow-hidden rounded-full bg-line">
                        <span className="block h-full rounded-full bg-ink-2" style={{ width: `${d.percent}%` }} />
                      </span>
                    </dd>
                  ) : null}
                </div>
              );
            })}
          </dl>
        </div>
      ))}
    </div>
  );
}
