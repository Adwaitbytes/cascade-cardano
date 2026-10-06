"use client";

import { useQuery } from "@tanstack/react-query";
import { AmountTicker, CountTicker } from "@/components/ticker";
import { getDataSource } from "@/lib/api";
import { formatAmount } from "@/lib/assets";
import { plural } from "@/lib/console/history";
import type { LandingData } from "@/lib/landing/data";
import { landingSnapshot } from "@/lib/landing/snapshot";

const loadLanding = async (): Promise<LandingData> => (await getDataSource()).getLanding();

const OUTCOMES = [
  { key: "closed", label: "Closed with payouts", bar: "bg-accepted" },
  { key: "refunded", label: "Refunded at the root deadline", bar: "bg-refunded" },
  { key: "open", label: "Still open", bar: "bg-working" },
] as const;

const capturedOn = (ms: number): string => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Preprod totals, led by what settled: payouts to agents, then every tree by outcome, then what
 * went back to buyers with the reason. Server-rendered data when given, else read in the browser.
 */
export function LiveStats({ data }: { data?: LandingData }) {
  const query = useQuery({ queryKey: ["landing"], queryFn: loadLanding, initialData: data, refetchInterval: 60_000, staleTime: 30_000 });
  // A failed refresh keeps the data already shown; the snapshot is only for a first read that fails.
  const d = query.data ?? (query.isError ? landingSnapshot() : undefined);
  if (d === undefined) {
    return (
      <div className="grid gap-3" role="status" aria-label="Loading preprod totals" data-testid="live-stats">
        {[0, 1, 2].map((i) => <span key={i} className="h-24 animate-pulse rounded-[18px] bg-surface-2" />)}
      </div>
    );
  }
  const t = d.totals;
  const lovelace = t.asset === "lovelace";
  const structural = BigInt(t.structural_returned);
  const returned = BigInt(t.returned) + (lovelace ? structural : 0n);
  const counts = { closed: t.closed, refunded: t.refunded, open: t.open };
  return (
    <div className="grid min-w-0 gap-3" data-testid="live-stats">
      <dl className="grid min-w-0 grid-cols-2 gap-px overflow-hidden rounded-[22px] border border-line bg-line" aria-label="Payouts settled on preprod">
        <div className="min-w-0 bg-surface px-4 py-4 sm:px-6 sm:py-5">
          <dt className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3 uppercase">Agent payouts settled</dt>
          <dd className="mt-2 font-display text-[1.5rem] leading-tight tracking-[-0.02em] sm:text-[2.1rem]"><CountTicker value={t.payouts} /></dd>
          <dd className="mt-1 text-[0.8125rem] text-ink-3">to {plural(t.agents_paid, "payee")}, {plural(t.settled_nodes, "node")} settled</dd>
        </div>
        <div className="min-w-0 bg-surface px-4 py-4 sm:px-6 sm:py-5">
          <dt className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3 uppercase">Paid to agents</dt>
          <dd className="mt-2 min-w-0 font-display [overflow-wrap:anywhere] text-[1.5rem] leading-tight tracking-[-0.02em] sm:text-[2.1rem]"><AmountTicker value={BigInt(t.paid)} asset={t.asset} /></dd>
          <dd className="mt-1 text-[0.8125rem] text-ink-3">only for verified work</dd>
        </div>
      </dl>

      <section aria-label="Trees by outcome" className="rounded-[22px] border border-line bg-surface px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3 uppercase">Trees funded</h3>
          <span className="font-display text-[1.25rem] tracking-[-0.02em] tabular-nums sm:text-[1.5rem]"><CountTicker value={t.trees} /></span>
        </div>
        <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          {OUTCOMES.map((o) => (counts[o.key] > 0 ? <span key={o.key} className={`${o.bar} h-full first:rounded-l-full last:rounded-r-full`} style={{ width: `${(counts[o.key] / Math.max(1, t.trees)) * 100}%` }} /> : null))}
        </div>
        <ul className="mt-3 grid gap-1.5 text-[0.8125rem]">
          {OUTCOMES.map((o) => (
            <li key={o.key} className="flex items-baseline gap-2">
              <span aria-hidden className={`size-2 shrink-0 translate-y-[-1px] rounded-full ${o.bar}`} />
              <span className="min-w-0 flex-1 text-ink-2">
                {o.label}
                {o.key === "refunded" && t.refunded_after_payouts > 0 ? <span className="text-ink-3">, {t.refunded_after_payouts} paid agents first</span> : null}
              </span>
              <span className="font-mono tabular-nums">{counts[o.key]}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Returned to buyers" className="rounded-[22px] border border-line bg-surface px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3 uppercase">Returned to buyers</h3>
          <span className="font-display text-[1.25rem] tracking-[-0.02em] sm:text-[1.5rem]"><AmountTicker value={returned} asset={t.asset} /></span>
        </div>
        <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-2">
          Unspent budget at close and trees refunded at their deadline, including the protocol&apos;s refund-path and dispute tests
          {lovelace && structural > 0n ? <>, plus {formatAmount(structural, "lovelace")} of structural ADA the escrows held, returned as they closed</> : null}.
        </p>
      </section>

      <p className="px-1 font-mono text-[0.6875rem] leading-relaxed text-ink-3">
        {plural(t.txs, "transaction")}, each one checkable on Cardanoscan.{" "}
        {d.source === "live" ? "Read from the preprod indexer." : `Saved ${capturedOn(d.generated_at)}; the indexer did not answer.`}
        {d.complete ? "" : ` Covers the newest ${t.trees} trees.`}
      </p>
    </div>
  );
}
