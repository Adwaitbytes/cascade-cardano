"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { AgentAvatar } from "@/components/avatar";
import { Amount } from "@/components/amount";
import { Hash } from "@/components/hash";
import { Rail, type RailName } from "@/components/rail";
import { StateBadge } from "@/components/state-badge";
import { EmptyState, ErrorState, Skeleton } from "@/components/states";
import { Panel } from "@/components/ui/panel";
import { getDataSource } from "@/lib/api";
import type { AgentProfile } from "@/lib/api/schemas";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/plan/summary";
import { BigStat, Eyebrow, SectionTitle } from "./heading";
import { ReputationSignals } from "./reputation-signals";
import { listingOf } from "@/lib/provider/listing";
import { ScoreGauge } from "./score-gauge";

/** Public agent page: identity, reputation with its signals, and the work behind them (PRD 12, 14.4). */
export function AgentProfileView({ assetId }: { assetId: string }) {
  const profile = useQuery({ queryKey: ["agent", assetId], queryFn: async () => (await getDataSource()).getAgent(assetId) });
  const work = useQuery({ queryKey: ["provider-work", assetId], queryFn: async () => (await getDataSource()).getProviderWork(assetId) });
  if (profile.isLoading) return <ProfileSkeleton />;
  if (profile.error !== null || profile.data === undefined) return <Panel><ErrorState error={profile.error} what="agent" /></Panel>;
  const a = profile.data;
  const w = work.data;
  const decided = w === undefined ? 0 : w.earnings.jobs_settled + w.earnings.jobs_refunded;
  const acceptance = w === undefined || decided === 0 ? null : w.earnings.jobs_settled / decided;
  const now = Date.now();

  return (
    <div className="grid gap-12">
      <AgentHeader agent={a} />

      <section aria-labelledby="agent-record-title">
        <SectionTitle id="agent-record-title" title="Record" note="From indexed trees" />
        {work.isLoading ? (
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[22px] border border-line bg-line sm:grid-cols-3" role="status" aria-live="polite">
            <span className="sr-only">Loading record</span>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="grid gap-3 bg-surface px-5 py-5"><Skeleton className="h-3 w-20" /><Skeleton className="h-7 w-16" /></div>
            ))}
          </div>
        ) : w === undefined ? (
          <Panel><p className="p-5 text-sm text-ink-3">The work record is not available.</p></Panel>
        ) : (
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[22px] border border-line bg-line shadow-card sm:grid-cols-3" data-testid="agent-record">
            <BigStat label="Jobs settled" value={w.earnings.jobs_settled} />
            <BigStat label="Jobs refunded" value={w.earnings.jobs_refunded} />
            <BigStat className="max-sm:col-span-2" label="Acceptance rate" value={acceptance === null ? "None yet" : `${Math.round(acceptance * 100)}%`} sub={acceptance === null ? "No decided jobs" : `of ${decided} decided jobs`} />
            <BigStat className="max-sm:col-span-2" label="Paid" value={<Amount value={w.earnings.paid.amount} asset={w.earnings.paid.asset} />} />
            <BigStat className="max-sm:col-span-2" label="In escrow now" value={<Amount value={w.earnings.pending.amount} asset={w.earnings.pending.asset} />} />
            <BigStat className="max-sm:col-span-2" label="Bonds at risk" value={<Amount value={w.bonds_at_risk_lovelace} asset="lovelace" />} />
          </dl>
        )}
      </section>

      <section aria-labelledby="agent-signals">
        <SectionTitle id="agent-signals" title="Reputation signals" note="From settled trees" />
        <Panel className="p-5 sm:p-6">
          <p className="mb-5 max-w-prose text-[0.875rem] text-ink-2">Each figure is the data behind the score.</p>
          <ReputationSignals profile={a} />
        </Panel>
      </section>

      <section aria-labelledby="agent-jobs">
        <SectionTitle id="agent-jobs" title="Jobs" note="Newest first" />
        <Panel className="overflow-hidden">
          {w === undefined || w.active_jobs.length === 0 ? (
            <EmptyState title="No open jobs" body="Settled and refunded jobs are counted in the record above." />
          ) : (
            <ul className="divide-y divide-line">
              {w.active_jobs.map((j) => (
                <li key={j.node_id} className="flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4 sm:px-6">
                  <div className="min-w-0 flex-1 basis-full sm:basis-0">
                    <p className="text-[0.9375rem] leading-snug">{j.task === "" ? "Private task" : j.task}</p>
                    <p className="mt-1 font-mono text-[0.75rem] text-ink-3">{j.next_deadline > now ? `Next deadline in ${formatDuration(j.next_deadline - now)}` : "No pending deadline"}</p>
                  </div>
                  <Amount value={j.fee.amount} asset={j.fee.asset} className="text-sm font-semibold" />
                  <StateBadge state={j.state} txId={j.state_tx} className="relative before:absolute before:-inset-y-2.5 before:inset-x-0 before:content-['']" />
                  <Link href={`/tree/${j.tree_id}`} className="group inline-flex h-11 items-center gap-1 rounded-full border border-line px-4 active:bg-surface-2 sm:h-8 sm:px-3 text-[0.8125rem] font-medium text-ink-2 transition-colors hover:border-line-strong hover:bg-surface-2 hover:text-ink">
                    Open tree <ArrowUpRight className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </section>
    </div>
  );
}

function AgentHeader({ agent: a }: { agent: AgentProfile }) {
  const available = a.availability === "available";
  return (
    <header className="relative overflow-hidden rounded-[28px] border border-line bg-surface shadow-card">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-2/3 opacity-80"
        style={{
          backgroundImage: "radial-gradient(circle at center, var(--dot) 1px, transparent 1.4px)",
          backgroundSize: "6px 6px",
          maskImage: "radial-gradient(ellipse 60% 70% at 85% 50%, black, transparent 75%)",
        }}
      />
      <div className="relative grid gap-8 p-6 sm:p-8 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div className="min-w-0 motion-safe:animate-[rise_600ms_var(--ease-out-quint)_both]">
          <Eyebrow>Agent · {a.capabilities.roles.join(", ")}</Eyebrow>
          <div className="mt-5 flex items-center gap-4">
            <AgentAvatar name={a.name} size={60} />
            <h1 className="min-w-0 truncate text-[clamp(2rem,4.4vw,3rem)] leading-none">{a.name}</h1>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <span className={cn("inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-semibold", available ? "bg-accepted-bg text-accepted" : "bg-surface-2 text-ink-2")}>
              <span aria-hidden className={cn("size-1.5 rounded-full", available ? "bg-accepted" : "bg-refunded")} />
              {available ? "Available" : a.availability === "unavailable" ? "Unavailable" : "Not checked"}
            </span>
            {listingOf(a).rails.map((r) => (
              <span key={r} className="inline-flex h-7 items-center rounded-full border border-line bg-surface px-3"><Rail rail={r as RailName} /></span>
            ))}
            {listingOf(a).categories.map((c) => (
              <span key={c} className="inline-flex h-7 items-center rounded-full border border-line bg-surface px-3 text-xs text-ink-2 first-letter:uppercase">{c.replace(/-/g, " ")}</span>
            ))}
          </div>
          <dl className="mt-6 grid gap-2 text-[0.8125rem] sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-5">
            <dt className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3 uppercase sm:pt-0.5">Masumi registry asset</dt>
            <dd className="-mt-1 mb-1 min-w-0 sm:m-0"><Hash value={a.agent_asset_id} label="registry asset id" className="[&_button]:relative [&_button]:before:absolute [&_button]:before:-inset-3 [&_button]:before:content-['']" /></dd>
            <dt className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3 uppercase sm:pt-0.5">Payment key hash</dt>
            <dd className="-mt-1 min-w-0 sm:m-0"><Hash value={a.payment_vkh} label="payment key hash" className="[&_button]:relative [&_button]:before:absolute [&_button]:before:-inset-3 [&_button]:before:content-['']" /></dd>
          </dl>
        </div>
        <div className="flex items-center gap-5 md:flex-col md:gap-3 motion-safe:animate-[rise_600ms_var(--ease-out-quint)_120ms_both]">
          <Eyebrow className="hidden md:block">Reputation</Eyebrow>
          <ScoreGauge score={a.reputation.score}>
            <p className="tabular font-display text-[2.6rem] leading-none tracking-[-0.03em]" data-testid="agent-score">{Math.round(a.reputation.score * 100)}</p>
            <p className="mt-1 font-mono text-[0.6875rem] text-ink-3">of 100</p>
          </ScoreGauge>
          <div>
            <Eyebrow className="mb-1.5 md:hidden">Reputation</Eyebrow>
            <p className="text-[0.8125rem] text-ink-2"><span className="tabular font-semibold text-ink">{Math.round(a.reputation.confidence * 100)}%</span> confidence</p>
          </div>
        </div>
      </div>
    </header>
  );
}

function ProfileSkeleton() {
  return (
    <div className="grid gap-12" role="status" aria-live="polite">
      <span className="sr-only">Loading agent</span>
      <div className="flex flex-wrap items-center justify-between gap-8 rounded-[28px] border border-line bg-surface p-6 shadow-card sm:p-8">
        <div className="grid flex-1 gap-5">
          <Skeleton className="h-3 w-32" />
          <div className="flex items-center gap-4"><Skeleton className="size-[60px] rounded-xl" /><Skeleton className="h-10 w-48" /></div>
          <div className="flex gap-2"><Skeleton className="h-7 w-24 rounded-full" /><Skeleton className="h-7 w-24 rounded-full" /><Skeleton className="h-7 w-32 rounded-full" /></div>
          <Skeleton className="h-3.5 w-64" />
        </div>
        <Skeleton className="size-[8.5rem] rounded-full" />
      </div>
      <Skeleton className="h-28 w-full rounded-[22px]" />
    </div>
  );
}
