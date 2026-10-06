"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock, Gavel, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { Amount } from "@/components/amount";
import { Hash } from "@/components/hash";
import { SignFlow } from "@/components/sign-flow";
import { StateBadge } from "@/components/state-badge";
import { EmptyState, ErrorState, Skeleton } from "@/components/states";
import { TxLink } from "@/components/tx-link";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { getDataSource } from "@/lib/api";
import type { Dispute } from "@/lib/api/schemas";
import { buildSplit } from "@/lib/arbiter/split";
import { assetInfo, formatAmount } from "@/lib/assets";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/plan/summary";

export function ArbiterConsole() {
  const disputes = useQuery({ queryKey: ["disputes"], queryFn: async () => (await getDataSource()).listDisputes() });
  const [selected, setSelected] = useState<string | null>(null);
  const queue = useMemo(() => [...(disputes.data ?? [])].sort((a, b) => a.dispute_until - b.dispute_until), [disputes.data]);
  if (disputes.isLoading) return <ArbiterSkeleton />;
  if (disputes.error !== null) return <Panel><ErrorState error={disputes.error} what="dispute queue" /></Panel>;
  if (queue.length === 0) return <Panel><EmptyState title="No open disputes" body="Challenged and disputed native nodes appear here, soonest deadline first. Masumi leaf disputes are settled by Masumi admins and never appear here." /></Panel>;
  const current = queue.find((d) => d.node_id === selected) ?? queue[0];
  const now = Date.now();

  return (
    <div className="grid gap-5 lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start">
      <Panel className="overflow-hidden lg:sticky lg:top-24">
        <PanelHeader
          title="Queue"
          description="Soonest deadline first"
          action={<span className="tabular grid h-7 min-w-7 place-items-center rounded-full bg-challenged-bg px-2 font-mono text-xs font-medium text-challenged">{queue.length}</span>}
        />
        <ul className="divide-y divide-line" data-testid="dispute-queue">
          {queue.map((d) => {
            const left = d.dispute_until - now;
            const active = current?.node_id === d.node_id;
            return (
              <li key={d.node_id}>
                <button type="button" onClick={() => setSelected(d.node_id)} aria-current={active ? "true" : undefined} className={cn("relative grid w-full gap-1.5 px-5 py-4 text-left transition-colors hover:bg-surface-2 active:bg-surface-2", active && "bg-surface-2")}>
                  {active ? <span aria-hidden className="absolute inset-y-3 left-0 w-[3px] rounded-r bg-challenged" /> : null}
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-semibold tracking-tight">{d.agent_name}</span>
                    <Amount value={d.locked.amount} asset={d.locked.asset} className="text-[0.8125rem] font-medium" />
                  </span>
                  <span className="flex items-center gap-2 font-mono text-[0.6875rem] tracking-[0.12em] text-challenged uppercase">
                    <span aria-hidden className="size-1.5 rounded-full bg-challenged" />
                    {d.state}
                  </span>
                  <span className={cn("flex items-start gap-1.5 text-[0.8125rem] leading-snug", left < 3600_000 ? "font-medium text-challenged" : "text-ink-3")}>
                    <Clock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                    {left > 0 ? `Deadline in ${formatDuration(left)}` : "Deadline passed. Anyone can crank it in the parent's favour."}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Panel>
      {current === undefined ? null : <DisputeDetail key={current.node_id} dispute={current} />}
    </div>
  );
}

function DisputeDetail({ dispute }: { dispute: Dispute }) {
  const [mode, setMode] = useState<"amount" | "percent">("percent");
  const [amountText, setAmountText] = useState("");
  const [percent, setPercent] = useState(50);
  const [signing, setSigning] = useState(false);
  const asset = dispute.locked.asset;
  const info = assetInfo(asset);
  const locked = BigInt(dispute.locked.amount);
  const fee = BigInt(dispute.fee);
  const result = buildSplit(locked, fee, info.decimals, mode === "amount" ? { mode, workerText: amountText } : { mode, workerBps: percent * 100 });
  const sentence = result.ok ? `Pay ${dispute.agent_name} ${formatAmount(result.split.worker, asset)} and return ${formatAmount(result.split.parent, asset)} to the parent node` : "";

  return (
    <div className="grid min-w-0 gap-5 max-sm:pb-28">
      <Panel>
        <PanelHeader
          title={`${dispute.agent_name}'s result`}
          description={<span className="flex flex-wrap items-center gap-2">Node <Hash value={dispute.node_id} label="node id" /></span>}
          action={<StateBadge state={dispute.state} txId={dispute.challenge_tx} />}
        />
        <div className="grid gap-6 p-5 sm:p-6 md:grid-cols-2">
          <div className="min-w-0">
            <SubHeading>Spec</SubHeading>
            <p className="mt-2 leading-relaxed text-ink">{dispute.spec?.task ?? "The spec is private to the buyer."}</p>
            <dl className="mt-4 divide-y divide-line rounded-xl border border-line text-[0.8125rem]">
              {([["Spec", dispute.spec_hash], ["Input", dispute.input_hash], ["Result", dispute.result_hash], ["Challenge reason", dispute.reason_hash], ["Worker bundle", dispute.bundles.worker], ["Challenger bundle", dispute.bundles.challenger]] as const).map(([label, value]) => (
                <div key={label} className="grid grid-cols-[minmax(7rem,8.5rem)_1fr] items-center gap-2 px-3.5 py-2">
                  <dt className="text-ink-3">{label}</dt>
                  <dd className="min-w-0">{value === null ? <span className="text-ink-3">Not provided</span> : <Hash value={value} label={`${label} hash`} />}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 flex flex-wrap items-center gap-1.5 text-[0.8125rem] text-ink-3">Challenged in <TxLink txId={dispute.challenge_tx} /></p>
          </div>
          <div className="min-w-0">
            <SubHeading>Verifier verdicts</SubHeading>
            {dispute.verdicts.length === 0 ? <p className="mt-2 text-sm text-ink-3">No verifier verdicts on this node.</p> : (
              <ul className="mt-3 grid gap-2.5">
                {dispute.verdicts.map((v) => (
                  <li key={v.evidence_hash} className="rounded-xl border border-line bg-bg/50 p-3.5 text-sm">
                    <p className="flex items-center gap-2 font-medium">
                      {v.verdict === "accept" ? <CheckCircle2 className="size-4 shrink-0 text-accepted" aria-hidden /> : <XCircle className="size-4 shrink-0 text-challenged" aria-hidden />}
                      {v.verifier_name ?? v.verifier.slice(0, 10)} {v.verdict === "accept" ? "accepted" : "rejected"}
                      <span className="tabular ml-auto font-mono text-xs text-ink-3">score {v.score.toFixed(2)}</span>
                    </p>
                    <ul className="mt-2.5 flex flex-wrap gap-1.5">
                      {v.checks.map((c) => (
                        <li key={c.name} className={cn("rounded-md px-1.5 py-0.5 text-xs", c.passed ? "bg-accepted-bg text-accepted" : "bg-challenged-bg text-challenged")}>
                          {c.name} {c.passed ? "passed" : "failed"}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Split" description={`The worker can receive at most its fee, ${formatAmount(fee, asset)}. The rest of the ${formatAmount(locked, asset)} locked returns to the parent.`} />
        <div className="grid gap-6 p-5 sm:p-6">
          <div role="group" aria-label="Split by" className="flex w-fit rounded-full border border-line bg-surface-2 p-1">
            {(["percent", "amount"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={cn("h-11 rounded-full px-4 text-[0.875rem] transition-[background-color,color,box-shadow] active:scale-[0.98] sm:h-8 sm:text-[0.8125rem]", mode === m ? "bg-surface font-semibold text-ink shadow-card" : "text-ink-3 hover:text-ink")}>
                {m === "percent" ? "Share of fee" : "Exact amount"}
              </button>
            ))}
          </div>
          {mode === "percent" ? (
            <Field label={<span className="flex justify-between">Worker share of the fee <span className="tabular font-display text-base">{percent}%</span></span>} htmlFor="split-percent">
              <input id="split-percent" type="range" min={0} max={100} step={1} value={percent} onChange={(e) => setPercent(Number(e.target.value))} className="h-11 w-full accent-[var(--ink)] sm:h-8" />
            </Field>
          ) : (
            <Field label={`Worker receives, ${info.ticker}`} htmlFor="split-amount" error={result.ok ? null : result.error}>
              <Input id="split-amount" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="12.50" aria-invalid={!result.ok || undefined} className="h-12 text-base sm:h-10 sm:text-sm" />
            </Field>
          )}
          {result.ok ? (
            <div className="grid overflow-hidden rounded-2xl border border-line bg-bg/60 sm:grid-cols-2" data-testid="split-result">
              <div className="border-b border-line p-5 sm:border-r sm:border-b-0">
                <p className="flex items-center gap-2 font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3 uppercase"><span aria-hidden className="size-2 rounded-full bg-accepted" />To {dispute.agent_name}</p>
                <p className="mt-3 font-display text-[clamp(1.6rem,3vw,2rem)] leading-none"><Amount value={result.split.worker} asset={asset} /></p>
                <p className="mt-2 font-mono text-[0.72rem] text-ink-3">{result.split.worker.toString()} base units</p>
              </div>
              <div className="p-5">
                <p className="flex items-center gap-2 font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3 uppercase"><span aria-hidden className="size-2 rounded-full bg-refunded" />Back to the parent node</p>
                <p className="mt-3 font-display text-[clamp(1.6rem,3vw,2rem)] leading-none"><Amount value={result.split.parent} asset={asset} /></p>
                <p className="mt-2 font-mono text-[0.72rem] text-ink-3">{result.split.parent.toString()} base units</p>
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-5">
            <p className="max-w-md text-[0.8125rem] leading-relaxed text-ink-2">Needs {dispute.threshold} of {dispute.arbiters.length} arbiter signatures. Anyone can submit once enough have signed.</p>
            <Button size="lg" className="max-sm:hidden" disabled={!result.ok} onClick={() => setSigning(true)}><Gavel /> Sign this split</Button>
          </div>
        </div>
      </Panel>

      {/* Phones: the one primary action stays in reach at the bottom of the screen. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-12px_32px_-16px_rgb(11_11_12/0.3)] backdrop-blur sm:hidden">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-[0.6875rem] tracking-[0.12em] text-ink-3 uppercase">To {dispute.agent_name}</p>
            <p className="truncate font-display text-[1.25rem] leading-tight">{result.ok ? <Amount value={result.split.worker} asset={asset} /> : "Fix the amount"}</p>
          </div>
          <Button size="lg" disabled={!result.ok} onClick={() => setSigning(true)}><Gavel /> Sign this split</Button>
        </div>
      </div>

      <SignFlow
        open={signing}
        onOpenChange={setSigning}
        title="Sign the Resolve split"
        sentence={sentence}
        actionLabel="Sign as arbiter"
        build={async (wallet) => {
          if (!result.ok) throw new Error("The split is not valid.");
          return (await (await getDataSource()).buildResolveTx(dispute.tree_id, dispute.node_id, { worker: result.split.worker.toString(), parent: result.split.parent.toString(), change_address: wallet.changeAddress, utxos: wallet.utxos })).tx_cbor;
        }}
        verify={(preview) => (preview.actions.some((a) => a.type === "Resolve") ? [] : ["The transaction does not resolve this dispute."])}
      />
    </div>
  );
}

function SubHeading({ children }: { children: string }) {
  return <h3 className="font-mono text-[0.6875rem] tracking-[0.18em] text-ink-3 uppercase">{children}</h3>;
}

function ArbiterSkeleton() {
  return (
    <div className="grid gap-5 lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start" role="status" aria-label="Loading disputes">
      <Panel className="grid gap-5 p-5">
        <Skeleton className="h-4 w-16" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="grid gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </Panel>
      <div className="grid gap-5">
        <Panel className="h-80" />
        <Panel className="h-64" />
      </div>
    </div>
  );
}
