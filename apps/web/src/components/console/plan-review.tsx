"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Lock, XCircle } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { Eyebrow, SectionTitle } from "@/components/agents/heading";
import { AgentAvatar } from "@/components/avatar";
import { Amount } from "@/components/amount";
import { Hash } from "@/components/hash";
import { Rail } from "@/components/rail";
import { Reputation } from "@/components/reputation";
import { SignFlow } from "@/components/sign-flow";
import { ErrorState, Skeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { getDataSource } from "@/lib/api";
import type { PlanEnvelope } from "@/lib/api/schemas";
import { formatAmount } from "@/lib/assets";
import { cn } from "@/lib/cn";
import { ACTION_BAR, HASH_TOUCH, SAFE_BOTTOM } from "./touch";
import { addressRole, checkFundPreview, isConfigToken, isThreadToken } from "@/lib/plan/fund-check";
import { deadlineFeasibility, formatDuration, fundPreviewSentence, planErrors, planRows, planTotals } from "@/lib/plan/summary";

const ACCEPTANCE_TEXT = { ParentAccept: "Parent accepts", VerifierQuorum: "Verifier quorum", AutoAfterWindow: "Auto after window", BuyerAccept: "You accept" } as const;
const STATUS_TEXT = { draft: "Draft, not funded", funded: "Funded", expired: "Expired" } as const;
const COLUMNS = "md:grid-cols-[minmax(0,1fr)_6.5rem_9.5rem_7.5rem]";

function PlanSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start" role="status" aria-live="polite">
      <span className="sr-only">Loading plan</span>
      <div className="grid gap-6">
        <Panel className="grid gap-3 p-6"><Skeleton className="h-3 w-24" /><Skeleton className="h-5 w-11/12" /><Skeleton className="h-5 w-2/3" /></Panel>
        <Panel>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex gap-3 border-t border-line px-5 py-5 first:border-t-0 sm:px-6" style={{ paddingLeft: `${1.5 + Math.min(i, 3) * 1.1}rem` }}>
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="grid flex-1 gap-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-2/3" /></div>
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </Panel>
      </div>
      <Panel className="grid gap-3 p-6"><Skeleton className="h-3 w-28" /><Skeleton className="h-9 w-44" /><Skeleton className="mt-3 h-4 w-full" /><Skeleton className="h-4 w-full" /><Skeleton className="mt-3 h-12 w-full rounded-full" /></Panel>
    </div>
  );
}

export function PlanReview({ planId }: { planId: string }) {
  const plan = useQuery({ queryKey: ["plan", planId], queryFn: async () => (await getDataSource()).getPlan(planId) });
  if (plan.isLoading) return <PlanSkeleton />;
  if (plan.error !== null || plan.data === undefined) return <Panel><ErrorState error={plan.error} what="plan" action={<Button variant="secondary" size="sm" asChild><Link href="/console/new">Start a new job</Link></Button>} /></Panel>;
  return <PlanBody envelope={plan.data} />;
}

function PlanBody({ envelope }: { envelope: PlanEnvelope }) {
  const { plan } = envelope;
  const rows = useMemo(() => planRows(plan), [plan]);
  const totals = planTotals(plan);
  const feasibility = deadlineFeasibility(plan);
  const errors = useMemo(() => planErrors(plan), [plan]);
  const [funding, setFunding] = useState(false);
  const deployment = useQuery({ queryKey: ["deployment"], queryFn: async () => (await getDataSource()).getDeployment(), staleTime: Infinity });
  const treeIdRef = useRef<string | null>(null);
  const agent = (id: string) => envelope.agents[id] ?? { name: `Agent ${id.slice(56, 62) || id.slice(0, 6)}`, reputation: null };
  const sentence = fundPreviewSentence(plan);
  const pct = Math.min(100, (feasibility.requiredMs / Math.max(1, feasibility.availableMs)) * 100);

  const depth = Math.max(...rows.map((r) => r.depth));
  const fundable = errors.length === 0 && feasibility.feasible && envelope.status === "draft";
  const liveTreeId = envelope.status !== "draft" ? envelope.tree_id : null;

  return (
    <div className="grid gap-6 pb-28 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:pb-0">
      <div className="grid min-w-0 gap-8 motion-safe:animate-[rise_600ms_var(--ease-out-quint)_80ms_both]">
        <Panel className="relative overflow-hidden p-5 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Eyebrow>Goal</Eyebrow>
            <span className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-[0.6875rem] text-ink-3">
              <span className={cn("inline-flex h-5 items-center gap-1.5 rounded-full px-2 font-sans font-semibold", envelope.status === "draft" ? "bg-surface-2 text-ink-2" : envelope.status === "funded" ? "bg-accepted-bg text-accepted" : "bg-refunded-bg text-refunded")}>
                <span aria-hidden className={cn("size-1.5 rounded-full", envelope.status === "draft" ? "bg-ink-3" : envelope.status === "funded" ? "bg-accepted" : "bg-refunded")} />
                {STATUS_TEXT[envelope.status]}
              </span>
              <span className="min-w-0 truncate" title={plan.plan_id}>Plan <span className="text-ink-2">{plan.plan_id}</span></span>
            </span>
          </div>
          <p className="mt-4 max-w-3xl text-[1.0625rem] leading-relaxed tracking-[-0.005em] sm:text-[1.1875rem]">{envelope.goal}</p>
        </Panel>

        <section aria-labelledby="proposed-tree" className="min-w-0">
          <SectionTitle id="proposed-tree" title="Proposed tree" note={`${rows.length} nodes · depth ${depth}`} />
          <Panel className="overflow-hidden">
            <p className="border-b border-line px-5 py-3.5 text-[0.8125rem] text-ink-2 sm:px-6">Each row becomes its own escrow when it is hired. Prices are caps, and unspent value flows back up.</p>
            <div className={cn("hidden gap-4 border-b border-line bg-surface-2/50 px-5 py-2.5 font-mono text-[0.625rem] tracking-[0.14em] text-ink-3 uppercase sm:px-6 md:grid", COLUMNS)}>
              <span>Task and agent</span>
              <span>Rail</span>
              <span>Verification</span>
              <span className="text-right">Price</span>
            </div>
            <ol className="divide-y divide-line" data-testid="plan-rows">
              {rows.map((r) => {
                const a = agent(r.agentId);
                return (
                  <li key={r.specId} style={{ "--depth": Math.min(r.depth, 4) } as CSSProperties} className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-3 py-5 pr-5 pl-[calc(1.25rem+var(--depth)*0.75rem)] transition-colors hover:bg-surface-2/40 active:bg-surface-2/60 sm:pr-6 md:gap-4 md:pl-6", COLUMNS)}>
                    <div className="col-span-2 flex min-w-0 gap-3 md:col-span-1 md:pl-[calc(var(--depth)*1.1rem)]">
                      {r.depth > 0 ? <span aria-hidden className="-ml-3 mt-1.5 h-3 w-2.5 shrink-0 rounded-bl-md border-b border-l border-line-strong" /> : null}
                      <AgentAvatar name={a.name} seed={r.agentId} size={30} />
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold tracking-tight">
                          {a.name}
                          {a.reputation !== null ? <Reputation score={a.reputation} /> : null}
                          {r.fallbackIds.length > 0 ? <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[0.625rem] font-normal text-ink-3">fallback {r.fallbackIds.map((f) => agent(f).name).join(", ")}</span> : null}
                        </p>
                        <p className="mt-1 line-clamp-3 text-[0.875rem] leading-relaxed text-ink-2 md:line-clamp-2 md:text-[0.8125rem]">{r.task}</p>
                        <p className="mt-1.5 text-[0.75rem] text-ink-3">Submit within {formatDuration(r.submitWindowMs)} of hire. {ACCEPTANCE_TEXT[r.acceptance]}.</p>
                      </div>
                    </div>
                    <div className="order-2 flex items-center md:order-none md:block">
                      <Rail rail={r.rail} />
                    </div>
                    <div className="order-1 col-span-2 min-w-0 rounded-xl bg-surface-2/60 px-3 py-2.5 text-[0.8125rem] text-ink-2 md:order-none md:col-span-1 md:rounded-none md:bg-transparent md:p-0">
                      <p>{r.verifier}</p>
                      {r.quorum !== null ? (
                        <ul className="mt-1 grid gap-0.5 pointer-coarse:mt-3 pointer-coarse:gap-8" aria-label={`Verifier keys, any ${r.quorum.k} of ${r.quorum.n} must sign`}>
                          {r.quorum.keys.map((k) => <li key={k}><Hash value={k} label="verifier key hash" className={HASH_TOUCH} /></li>)}
                        </ul>
                      ) : null}
                    </div>
                    <div className="order-3 text-right text-sm md:order-none">
                      <Amount value={r.budget} asset={plan.asset} className="font-semibold" />
                      <span className="mt-0.5 block font-mono text-[0.6875rem] text-ink-3">fee <Amount value={r.fee} asset={plan.asset} /></span>
                    </div>
                  </li>
                );
              })}
            </ol>
          </Panel>
        </section>
      </div>

      <aside className="grid gap-4 lg:sticky lg:top-20 lg:motion-safe:animate-[rise_600ms_var(--ease-out-quint)_160ms_both]">
        <Panel className="overflow-hidden">
          <div className="p-5 sm:p-6" data-testid="plan-totals">
            <Eyebrow>Total to lock</Eyebrow>
            <p className="tabular mt-3 truncate font-display text-[2.25rem] leading-none tracking-[-0.02em]">{formatAmount(totals.budget, plan.asset)}</p>
            <p className="mt-2 text-[0.8125rem] text-ink-3">Locked once in the root. Unspent value returns to you at close.</p>
            <dl className="mt-5 grid divide-y divide-line border-y border-line text-[0.8125rem]">
              {[
                ["Orchestrator margin", <Amount key="m" value={totals.margin} asset={plan.asset} />],
                ["All fees at most", <Amount key="f" value={totals.fees} asset={plan.asset} />],
                ["Reserve for re-hires", <Amount key="r" value={totals.reserve} asset={plan.asset} />],
                ["Structural ADA, returned at close", <Amount key="s" value={totals.structuralLovelace} asset="lovelace" />],
              ].map(([label, value]) => (
                <div key={label as string} className="flex items-baseline justify-between gap-3 py-2.5">
                  <dt className="text-ink-2">{label}</dt>
                  <dd className="text-right">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="border-t border-line bg-surface-2/50 p-5 sm:p-6">
            <h2 className="sr-only">Plan checks</h2>
            {errors.length === 0 ? (
              <p className="flex items-start gap-2 text-[0.8125rem] leading-relaxed text-ink-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-accepted" aria-hidden /> Budgets, caps, deadline nesting and the Merkle root all check out.</p>
            ) : (
              <ul className="grid gap-1.5 text-[0.8125rem] text-challenged" role="alert">
                {errors.map((e) => <li key={e} className="flex items-start gap-2"><XCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> {e}</li>)}
              </ul>
            )}
            <p className="mt-3 flex items-center gap-2 font-mono text-[0.6875rem] text-ink-3">Plan root <Hash value={plan.plan_root} label="plan root" className={HASH_TOUCH} /></p>
            {/* One action block: a thumb-reach bar below lg, part of this card from lg up, so each button exists once. */}
            <div className={cn(ACTION_BAR, "lg:mt-5")} style={SAFE_BOTTOM}>
              <div className="mx-auto flex max-w-xl items-center gap-3 pb-3 lg:block lg:pb-0">
                <div className="min-w-0 flex-1 lg:hidden">
                  <p className="font-mono text-[0.625rem] tracking-[0.18em] text-ink-3 uppercase">To lock</p>
                  <p className="tabular mt-1 truncate font-display text-[1.25rem] leading-none tracking-[-0.02em]">{formatAmount(totals.budget, plan.asset)}</p>
                </div>
                <Button size="lg" className={cn("shrink-0 active:scale-[0.98] lg:w-full", liveTreeId !== null && "max-lg:hidden")} disabled={!fundable} onClick={() => setFunding(true)}>
                  <Lock /> Fund this plan
                </Button>
                {liveTreeId !== null ? (
                  <Button variant="secondary" size="lg" className="group shrink-0 active:scale-[0.98] lg:mt-2 lg:h-10 lg:w-full lg:text-sm" asChild>
                    <Link href={`/console/job/${liveTreeId}`}>Open the live job <ArrowRight className="transition-transform duration-200 group-hover:translate-x-0.5" /></Link>
                  </Button>
                ) : null}
              </div>
              {liveTreeId !== null ? null : <p className="mt-3 hidden text-center text-[0.75rem] text-ink-3 lg:block">One wallet signature. You see every output before you sign.</p>}
            </div>
          </div>
        </Panel>

        <Panel className="p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[0.9375rem] font-semibold tracking-tight">Deadline</h2>
            <span className={cn("font-mono text-[0.6875rem]", feasibility.feasible ? "text-accepted" : "text-challenged")}>{feasibility.feasible ? `${formatDuration(feasibility.slackMs)} spare` : "Too tight"}</span>
          </div>
          <div className="mt-4" role="img" aria-label={`The deepest path needs ${formatDuration(feasibility.requiredMs)} of ${formatDuration(feasibility.availableMs)} available.`} data-testid="feasibility">
            <div className="relative h-2 overflow-hidden rounded-full bg-surface-2 shadow-[inset_0_0_0_1px_var(--line)]">
              <div className={cn("h-full rounded-full transition-[width] duration-700 ease-out", feasibility.feasible ? "bg-accepted" : "bg-challenged")} style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-2 flex justify-between font-mono text-[0.625rem] tracking-[0.08em] text-ink-3 uppercase">
              <span>Fund</span>
              <span>Root submit deadline</span>
            </div>
          </div>
          <p className={cn("mt-4 text-[0.8125rem] leading-relaxed", feasibility.feasible ? "text-ink-2" : "font-semibold text-challenged")}>
            {feasibility.feasible
              ? `The deepest path needs ${formatDuration(feasibility.requiredMs)}. You allowed ${formatDuration(feasibility.availableMs)}, so ${formatDuration(feasibility.slackMs)} is spare.`
              : `The deepest path needs ${formatDuration(feasibility.requiredMs)} but only ${formatDuration(feasibility.availableMs)} is allowed. Move the deadline later or lower the depth.`}
          </p>
        </Panel>
      </aside>

      <SignFlow
        open={funding}
        onOpenChange={setFunding}
        title="Fund the root"
        sentence={sentence}
        actionLabel="Sign and fund"
        details={
          <ul className="grid gap-1.5 text-[0.8125rem] text-ink-2">
            <li>The plan root in the escrow commits to every node you reviewed. Agents can only be paid for tasks in it.</li>
            <li>Unspent budget, refunds and the structural ADA return to the address you fund from.</li>
            <li>You can cancel for a full refund until the first agent is hired.</li>
          </ul>
        }
        build={async (wallet) => {
          const tx = await (await getDataSource()).requestFundTx(plan.plan_id, { change_address: wallet.changeAddress, utxos: wallet.utxos });
          treeIdRef.current = tx.tree_id;
          return tx.tx_cbor;
        }}
        verify={(preview) =>
          deployment.data === undefined
            ? ["The deployed script hashes could not be loaded, so the transaction cannot be checked. Reload the page."]
            : checkFundPreview(plan, preview, deployment.data)
        }
        labelAsset={(asset) => {
          const node = deployment.data?.scripts.node;
          if (node === undefined) return null;
          return isConfigToken(asset, node) ? "config token" : isThreadToken(asset, node) ? "thread token" : null;
        }}
        labelAddress={(address, wallet) => {
          if (address === wallet.changeAddress) return "Your wallet";
          if (deployment.data === undefined) return null;
          const role = addressRole(address, deployment.data.scripts);
          return role === "root" ? "Cascade root" : role === "config" ? "Tree config" : null;
        }}
        doneBody={() =>
          treeIdRef.current === null ? null : (
            <Button asChild>
              <Link href={`/console/job/${treeIdRef.current}`}>Watch the tree grow</Link>
            </Button>
          )
        }
      />
    </div>
  );
}
