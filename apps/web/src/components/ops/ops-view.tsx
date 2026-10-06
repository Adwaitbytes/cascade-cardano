"use client";

import { useQuery } from "@tanstack/react-query";
import { Database, RadioTower, ShieldAlert, Timer, Zap, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState, ErrorState, Skeleton } from "@/components/states";
import { TxLink } from "@/components/tx-link";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { getDataSource } from "@/lib/api";
import type { OpsStatus } from "@/lib/api/schemas";
import { cn } from "@/lib/cn";
import { explainFailure } from "@/lib/ops/failure";
import { timeOf } from "@/components/explorer/event-style";

type Health = "ok" | "warn" | "idle";

const HEALTH: Record<Health, { dot: string; text: string; bg: string }> = {
  ok: { dot: "bg-accepted", text: "text-accepted", bg: "bg-accepted-bg" },
  warn: { dot: "bg-working", text: "text-working", bg: "bg-working-bg" },
  idle: { dot: "bg-refunded", text: "text-refunded", bg: "bg-refunded-bg" },
};

function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("font-mono text-[0.6875rem] tracking-[0.18em] text-ink-3 uppercase", className)}>{children}</p>;
}

function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = Math.min(100, (value / Math.max(1, max)) * 100);
  return (
    <div>
      <div className="flex justify-between gap-2 font-mono text-[0.72rem] text-ink-3">
        <span>{label}</span>
        <span className={cn("tabular", pct > 85 ? "text-challenged" : pct > 65 ? "text-working" : undefined)}>{pct.toFixed(1)}%</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <div className={cn("h-full rounded-full transition-[width] duration-700 ease-out-quint", pct > 85 ? "bg-challenged" : pct > 65 ? "bg-working" : "bg-ink/75")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Service({ icon: Icon, name, health, status, detail }: { icon: LucideIcon; name: string; health: Health; status: string; detail: string }) {
  const tone = HEALTH[health];
  return (
    <li className="flex items-center gap-3.5 px-5 py-4 sm:px-6">
      <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-surface-2 text-ink-2">
        <Icon className="size-[1.125rem]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium tracking-tight">{name}</p>
        <p className="tabular truncate text-[0.8125rem] text-ink-3">{detail}</p>
      </div>
      <span className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold", tone.text, tone.bg)}>
        <span aria-hidden className={cn("size-1.5 rounded-full", tone.dot)} />
        {status}
      </span>
    </li>
  );
}

function OpsSkeleton() {
  return (
    <div className="grid gap-5" role="status" aria-label="Loading operations status">
      <Panel className="p-6">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="mt-4 h-8 w-64" />
        <Skeleton className="mt-3 h-3.5 w-80 max-w-full" />
      </Panel>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Panel key={i} className="p-5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-4 h-8 w-16" />
            <Skeleton className="mt-3 h-3 w-24" />
          </Panel>
        ))}
      </div>
      <Panel className="h-72" />
    </div>
  );
}

function FailedTx({ failure }: { failure: OpsStatus["failed_txs"][number] }) {
  const { cause, detail } = explainFailure(failure.error);
  return (
    <li className="flex gap-3 px-5 py-3.5">
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-challenged-bg text-challenged"><ShieldAlert className="size-4" /></span>
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-1.5">
        <span className="flex items-center justify-between gap-3">
          <span className="font-mono text-[0.875rem] font-medium">{failure.action}</span>
          <span className="tabular shrink-0 text-xs text-ink-3">{timeOf(failure.at)}</span>
        </span>
        <p className="text-[0.8125rem] leading-relaxed text-ink-2">{cause}</p>
        {detail === null ? null : (
          <details className="group min-w-0 text-xs">
            <summary className="w-fit cursor-pointer rounded text-ink-3 underline decoration-line-strong underline-offset-2 select-none hover:text-ink focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:py-2">Raw error</summary>
            <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg bg-challenged-bg/60 px-2.5 py-1.5 font-mono text-[0.72rem] leading-relaxed break-all whitespace-pre-wrap text-challenged">{detail}</pre>
          </details>
        )}
        {failure.tx_id !== null ? <TxLink txId={failure.tx_id} className="min-h-11 w-fit sm:min-h-0" /> : <span className="text-xs text-ink-3">Not submitted</span>}
      </div>
    </li>
  );
}

export function OpsView() {
  const ops = useQuery({ queryKey: ["ops"], queryFn: async () => (await getDataSource()).getOpsStatus(), refetchInterval: 10_000 });
  if (ops.isLoading) return <OpsSkeleton />;
  if (ops.error !== null || ops.data === undefined) return <Panel><ErrorState error={ops.error} what="operations status" /></Panel>;
  const o = ops.data;
  const lagSlots = o.indexer.tip_slot - o.indexer.indexed_slot;
  const indexerBehind = o.indexer.lag_ms > 60_000;
  const facilitatorBacklog = o.facilitator.queued > 20;
  const degraded = indexerBehind || facilitatorBacklog;
  const lastCrank = o.cranks.reduce<number | null>((latest, c) => (latest === null || c.at > latest ? c.at : latest), null);
  const stats: [string, string, string, boolean][] = [
    ["Indexer lag", `${lagSlots} slots`, `${(o.indexer.lag_ms / 1000).toFixed(1)} s behind the tip`, indexerBehind],
    ["Rollbacks, 24 h", String(o.indexer.rollbacks_24h), `tip slot ${o.indexer.tip_slot.toLocaleString("en-US")}`, false],
    ["Facilitator queue", String(o.facilitator.queued), `${o.facilitator.settlement_pending} settlement pending`, facilitatorBacklog],
    ["Settled, 24 h", String(o.facilitator.settled_24h), `${o.facilitator.rejected_24h} rejected`, false],
  ];
  const overall = HEALTH[degraded ? "warn" : "ok"];

  return (
    <div className="grid grid-cols-1 gap-5">
      <Panel className="relative overflow-hidden" aria-label="Overall status">
        <div aria-hidden className={cn("absolute inset-x-0 top-0 h-1", overall.dot)} />
        <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="flex flex-col justify-center gap-3 border-b border-line p-6 sm:p-7 lg:border-r lg:border-b-0">
            <span className={cn("inline-flex w-fit items-center gap-2 rounded-full px-2.5 py-1 font-mono text-[0.6875rem] tracking-[0.14em] uppercase", overall.text, overall.bg)}>
              <span aria-hidden className="relative flex size-2">
                <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:hidden", overall.dot)} />
                <span className={cn("relative size-2 rounded-full", overall.dot)} />
              </span>
              {degraded ? "Degraded" : "Operational"}
            </span>
            <p className="font-display text-[clamp(1.6rem,3vw,2.2rem)] leading-tight tracking-[-0.02em]">{degraded ? "Some services are slow" : "All systems normal"}</p>
            <p className="tabular text-[0.875rem] text-ink-3">
              Checked {timeOf(ops.dataUpdatedAt)}. Refreshes every 10 seconds.
              {o.failed_txs.length > 0 ? ` ${o.failed_txs.length} failed ${o.failed_txs.length === 1 ? "transaction" : "transactions"} in the retained window.` : ""}
            </p>
          </div>
          <ul className="divide-y divide-line" aria-label="Services">
            <Service icon={Database} name="Indexer" health={indexerBehind ? "warn" : "ok"} status={indexerBehind ? "Behind" : "In sync"} detail={`${(o.indexer.lag_ms / 1000).toFixed(1)} s behind slot ${o.indexer.tip_slot.toLocaleString("en-US")}`} />
            <Service icon={Zap} name="x402 facilitator" health={facilitatorBacklog ? "warn" : "ok"} status={facilitatorBacklog ? "Backlog" : "Settling"} detail={`${o.facilitator.queued} queued, ${o.facilitator.settled_24h} settled in 24 h`} />
            <Service icon={RadioTower} name="Watchtower" health={lastCrank === null ? "idle" : "ok"} status={lastCrank === null ? "Idle" : "Cranking"} detail={lastCrank === null ? "No deadline actions submitted yet" : `Last crank ${timeOf(lastCrank)}`} />
          </ul>
        </div>
      </Panel>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4" aria-label="Service health">
        {stats.map(([label, value, sub, bad]) => (
          // Phones: one row per figure, label and detail on the left, the number on the right.
          <dl key={label} className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 rounded-[20px] border bg-surface px-5 py-4 shadow-card sm:flex sm:flex-col sm:items-stretch sm:p-5", bad ? "border-working/40" : "border-line")}>
            <dt className="flex items-center justify-between gap-2 font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3 uppercase">
              <span className="inline-flex items-center gap-2">
                <span aria-hidden className={cn("size-2 rounded-full sm:hidden", bad ? "bg-working" : "bg-accepted")} />
                {label}
              </span>
              {bad ? <span className="size-2 rounded-full bg-working max-sm:hidden"><span className="sr-only">Needs attention</span></span> : null}
            </dt>
            <dd className={cn("tabular row-span-2 text-right font-display text-[1.75rem] leading-none sm:mt-3 sm:text-left sm:text-[clamp(1.6rem,3vw,2.1rem)]", bad ? "text-working" : "text-ink")}>{value}</dd>
            <dd className="tabular mt-1.5 text-[0.8125rem] text-ink-3 sm:mt-2.5">{sub}</dd>
          </dl>
        ))}
      </section>

      <Panel>
        <PanelHeader
          title="Execution units per redeemer"
          description="Largest recent usage against the 14M memory budget every action is held to."
          action={
            <span className="flex items-center gap-3 font-mono text-[0.6875rem] text-ink-3">
              <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-2 rounded-full bg-working" />over 65%</span>
              <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-2 rounded-full bg-challenged" />over 85%</span>
            </span>
          }
        />
        {o.exec_units.length === 0 ? <EmptyState title="No script runs yet" body="Memory and CPU use per redeemer appear after the first Cascade transaction is indexed." /> : null}
        <ul className="grid grid-cols-1 gap-3 p-4 empty:hidden sm:grid-cols-2 sm:p-5" data-testid="exec-units">
          {o.exec_units.map((u) => (
            <li key={u.redeemer} className="grid gap-3 rounded-2xl border border-line bg-bg/50 p-4">
              <p className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-mono text-[0.875rem] font-medium text-ink">{u.redeemer}</span>
                <span className="tabular shrink-0 text-xs text-ink-3">{u.samples} {u.samples === 1 ? "sample" : "samples"}</span>
              </p>
              <Meter value={u.mem} max={u.max_mem} label={`Memory ${u.mem.toLocaleString("en-US")}`} />
              <Meter value={u.steps} max={u.max_steps} label={`CPU steps ${u.steps.toLocaleString("en-US")}`} />
            </li>
          ))}
        </ul>
      </Panel>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel className="min-w-0">
          <PanelHeader title="Watchtower cranks" description="Permissionless deadline actions the watchtower submitted." />
          {o.cranks.length === 0 ? <EmptyState title="No cranks yet" body="Refunds and deadline accepts appear here when the watchtower submits them." /> : (
            <ul className="divide-y divide-line">
              {o.cranks.map((c) => (
                <li key={c.tx_id} className="flex items-center gap-3 px-5 py-3.5">
                  <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"><Timer className="size-4" /></span>
                  <span className="grid min-w-0 flex-1 gap-0.5 sm:flex sm:items-center sm:justify-between sm:gap-3">
                    <span className="font-mono text-[0.875rem] font-medium">{c.action}</span>
                    <span className="tabular text-xs text-ink-3">{timeOf(c.at)}</span>
                  </span>
                  <TxLink txId={c.tx_id} className="min-h-11 shrink-0 sm:min-h-0" />
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel className="min-w-0">
          <PanelHeader title="Failed transactions" description="Rejected before or at submission, with the reason." />
          {o.failed_txs.length === 0 ? <EmptyState title="No failures" body="Nothing failed in the retained window." /> : (
            <ul className="divide-y divide-line">
              {o.failed_txs.map((f, i) => (
                <FailedTx key={`${f.at}-${i}`} failure={f} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
