"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ChevronLeft, ChevronRight, Inbox, Plus, X } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Amount } from "@/components/amount";
import { BigStat, SectionTitle } from "@/components/agents/heading";
import { ErrorState, Skeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { getDataSource } from "@/lib/api";
import type { TreeListItem } from "@/lib/api/schemas";
import { cn } from "@/lib/cn";
import { TREE_READ_LIMIT, jobTitle, paginate, parseBuyer, plural } from "@/lib/console/history";

const TREE_STATE = {
  open: { label: "Running", text: "text-funded", bg: "bg-funded-bg", dot: "bg-funded" },
  closed: { label: "Closed", text: "text-accepted", bg: "bg-accepted-bg", dot: "bg-accepted" },
  cancelled: { label: "Cancelled", text: "text-refunded", bg: "bg-refunded-bg", dot: "bg-refunded" },
} as const satisfies Record<TreeListItem["state"], { label: string; text: string; bg: string; dot: string }>;

function sum(items: TreeListItem[], pick: (t: TreeListItem) => string): bigint {
  return items.reduce((acc, t) => acc + BigInt(pick(t)), 0n);
}

function HistorySkeleton() {
  return (
    <div className="grid gap-8" role="status" aria-live="polite">
      <span className="sr-only">Loading jobs</span>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[20px] border border-line bg-line shadow-card lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="grid gap-3 bg-surface px-5 py-5 sm:px-6">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-32" />
          </div>
        ))}
      </div>
      <Panel>
        {[0, 1, 2].map((i) => (
          <div key={i} className="grid gap-3 border-t border-line px-5 py-5 first:border-t-0 sm:px-6">
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ))}
      </Panel>
    </div>
  );
}

function BuyerFilter({ buyer, onChange }: { buyer: string | null; onChange: (vkh: string | null) => void }) {
  const [text, setText] = useState(buyer ?? "");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const parsed = parseBuyer(text);
    setError(parsed.error);
    if (parsed.error === null) onChange(parsed.vkh);
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2" role="search" aria-label="Filter jobs by buyer">
      <Field label="Buyer key hash" htmlFor="buyer" error={error} hint={buyer === null ? "Leave empty to see every buyer." : undefined} className="min-w-0 flex-1 basis-72">
        <Input id="buyer" value={text} onChange={(e) => setText(e.target.value)} placeholder="56 hex characters" spellCheck={false} autoComplete="off" aria-invalid={error !== null || undefined} aria-describedby={error !== null ? "buyer-error" : buyer === null ? "buyer-hint" : undefined} className="font-mono h-11 text-base sm:h-10 sm:text-sm" />
      </Field>
      <div className={cn("flex gap-2", error !== null || buyer === null ? "sm:mb-[1.8rem]" : undefined)}>
        <Button type="submit" variant="secondary" className="h-11 sm:h-10">Filter</Button>
        {buyer !== null ? (
          <Button type="button" variant="ghost" className="h-11 sm:h-10" onClick={() => { setText(""); setError(null); onChange(null); }}><X aria-hidden /> Clear</Button>
        ) : null}
      </div>
    </form>
  );
}

export function History() {
  const [buyer, setBuyer] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const trees = useQuery({ queryKey: ["trees", buyer, TREE_READ_LIMIT], queryFn: async () => (await getDataSource()).listTrees(buyer, TREE_READ_LIMIT) });
  const filter = <BuyerFilter buyer={buyer} onChange={(vkh) => { setBuyer(vkh); setPage(0); }} />;
  if (trees.isLoading) return <div className="grid gap-8">{filter}<HistorySkeleton /></div>;
  if (trees.error !== null || trees.data === undefined) return <div className="grid gap-8">{filter}<Panel><ErrorState error={trees.error} what="job history" /></Panel></div>;
  const list = trees.data;
  if (list.length === 0)
    return (
      <div className="grid gap-8">
        {filter}
        <Panel className="hairline-grid relative overflow-hidden">
          <div className="relative mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center sm:py-20">
            <span className="grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent"><Inbox className="size-5" /></span>
            <p className="mt-5 text-lg font-semibold tracking-tight">{buyer === null ? "No jobs yet" : "No jobs for this buyer"}</p>
            <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-2">{buyer === null ? "Funded jobs appear here with what they cost, which agents worked on them and what was refunded." : "This key hash has not funded a tree on preprod. Check it, or clear the filter."}</p>
            <Button className="mt-6" asChild><Link href="/console/new"><Plus /> Start a job</Link></Button>
          </div>
        </Panel>
      </div>
    );

  const capped = list.length >= TREE_READ_LIMIT;
  const shown = paginate(list, page);
  const assets = [...new Set(list.map((t) => t.asset))];
  const asset = assets.length === 1 ? assets[0] : undefined;
  const categories = new Map<string, bigint>();
  for (const t of list) for (const [c, a] of Object.entries(t.spend_by_category)) categories.set(c, (categories.get(c) ?? 0n) + BigInt(a));
  const maxCategory = [...categories.values()].reduce((m, v) => (v > m ? v : m), 1n);
  const agents = new Set(list.flatMap((t) => t.agents));
  const running = list.filter((t) => t.state === "open").length;

  return (
    <div className="grid grid-cols-1 gap-10">
      {filter}
      {asset !== undefined ? (
        <dl className="grid gap-px overflow-hidden rounded-[20px] border border-line bg-line shadow-card sm:grid-cols-2 motion-safe:animate-[rise_600ms_var(--ease-out-quint)_80ms_both] lg:grid-cols-4">
          <BigStat label="Jobs" value={list.length.toLocaleString("en-US")} sub={capped ? `Latest ${TREE_READ_LIMIT}, ${running} running` : running === 0 ? "None running" : `${running} running`} />
          <BigStat label="Paid to agents" value={<Amount value={sum(list, (t) => t.paid)} asset={asset} />} sub="Released to agents for settled work" />
          <BigStat label="Refunded to parents" value={<Amount value={sum(list, (t) => t.recovered)} asset={asset} />} sub="Refunds from missed or rejected work" />
          <BigStat label="Agents used" value={agents.size} sub="Distinct agents across these jobs" />
        </dl>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <section aria-labelledby="all-jobs" className="min-w-0">
          <SectionTitle id="all-jobs" title="All jobs" note={shown.pages > 1 ? `${shown.from} to ${shown.to} of ${plural(list.length, "tree")}` : plural(list.length, "tree")} />
          <Panel className="overflow-hidden">
            <ul className="divide-y divide-line" data-testid="history-list">
              {shown.items.map((t) => {
                const state = TREE_STATE[t.state];
                const title = jobTitle(t);
                return (
                  <li key={t.tree_id} className="group relative grid gap-4 px-5 py-5 transition-colors hover:bg-surface-2/60 active:bg-surface-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-focus sm:px-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-8">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[0.6875rem] text-ink-3">
                        <span className={cn("inline-flex h-5 items-center gap-1.5 rounded-full px-2 font-sans text-[0.6875rem] font-semibold", state.text, state.bg)}>
                          <span aria-hidden className={cn("size-1.5 rounded-full", state.dot)} />
                          {state.label}
                        </span>
                        <span>{new Date(t.created_at).toISOString().slice(0, 10)}</span>
                        <span aria-hidden>·</span>
                        <span>{plural(t.node_count, "node")}</span>
                        <span aria-hidden>·</span>
                        <span>{plural(t.agents.length, "agent")}</span>
                      </div>
                      <Link
                        href={t.state === "open" ? `/console/job/${t.tree_id}` : `/receipt/${t.tree_id}`}
                        className={cn("mt-2.5 line-clamp-2 text-base leading-snug sm:text-[0.9375rem] tracking-tight break-words after:absolute after:inset-0 after:content-[''] focus-visible:outline-none", title.recorded ? "font-semibold" : "font-medium text-ink-2")}
                      >
                        {title.text}
                      </Link>
                    </div>
                    <div className="flex items-center gap-6">
                      <dl className="grid flex-1 grid-cols-3 gap-4 text-[0.8125rem] md:w-[21rem] md:text-right">
                        <div><dt className="font-mono text-[0.625rem] tracking-[0.14em] text-ink-3 uppercase">Budget</dt><dd className="mt-1 font-medium"><Amount value={t.root_budget} asset={t.asset} /></dd></div>
                        <div><dt className="font-mono text-[0.625rem] tracking-[0.14em] text-ink-3 uppercase">Paid</dt><dd className="mt-1 font-medium"><Amount value={t.paid} asset={t.asset} /></dd></div>
                        <div><dt className="font-mono text-[0.625rem] tracking-[0.14em] text-ink-3 uppercase">Refunded</dt><dd className="mt-1 font-medium"><Amount value={t.refunded} asset={t.asset} /></dd></div>
                      </dl>
                      <span aria-hidden className="hidden size-8 shrink-0 place-items-center rounded-full border border-line bg-surface text-ink-3 transition-[color,border-color,transform] duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:border-line-strong group-hover:text-ink md:grid">
                        <ArrowUpRight className="size-4" />
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
            {shown.pages > 1 ? (
              <nav aria-label="Job pages" className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 sm:px-6">
                <Button variant="ghost" size="sm" className="pointer-coarse:h-11" disabled={shown.page === 0} onClick={() => setPage(shown.page - 1)}><ChevronLeft aria-hidden /> Newer</Button>
                <span className="tabular font-mono text-[0.75rem] text-ink-3" aria-live="polite">Page {shown.page + 1} of {shown.pages}</span>
                <Button variant="ghost" size="sm" className="pointer-coarse:h-11" disabled={shown.page >= shown.pages - 1} onClick={() => setPage(shown.page + 1)}>Older <ChevronRight aria-hidden /></Button>
              </nav>
            ) : null}
          </Panel>
          {capped ? <p className="mt-3 text-[0.8125rem] text-ink-3">Showing the latest {TREE_READ_LIMIT} trees, the most the indexer returns in one read. Totals above cover these trees.</p> : null}
        </section>

        {asset !== undefined ? (
          <section aria-labelledby="spend" className="min-w-0">
            <SectionTitle id="spend" title="Spend by category" />
            <Panel className="p-5 sm:p-6">
              <ul className="grid gap-4">
                {[...categories.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).map(([c, v], i) => (
                  <li key={c}>
                    <div className="flex items-baseline justify-between gap-3 text-[0.8125rem]">
                      <span className="capitalize">{c.replace(/-/g, " ")}</span>
                      <Amount value={v} asset={asset} className="font-mono text-[0.75rem] text-ink-2" />
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                      <div className={cn("h-full rounded-full", i === 0 ? "bg-accent" : "bg-ink/60")} style={{ width: `${Number((v * 1000n) / maxCategory) / 10}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          </section>
        ) : null}
      </div>
    </div>
  );
}
