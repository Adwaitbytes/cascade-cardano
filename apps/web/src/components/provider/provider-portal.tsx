"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Check, CheckCircle2, Copy, Fingerprint, Loader2, Radar, Search, SlidersHorizontal, Wallet, XCircle } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { BigStat, SectionTitle } from "@/components/agents/heading";
import { ReputationSignals } from "@/components/agents/reputation-signals";
import { listingOf } from "@/lib/provider/listing";
import { AgentAvatar } from "@/components/avatar";
import { Amount } from "@/components/amount";
import { Hash } from "@/components/hash";
import { Rail, type RailName } from "@/components/rail";
import { Reputation } from "@/components/reputation";
import { StateBadge } from "@/components/state-badge";
import { EmptyState, ErrorState, Skeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { getDataSource, getSampleAgentId } from "@/lib/api";
import { EndpointCheckSchema, type AgentProfile, type EndpointCheck } from "@/lib/api/schemas";
import { TUSDM_ASSET_ID, parseUnits } from "@/lib/assets";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/plan/summary";

const AGENT_ID = /^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/;

const FEATURES = [
  { title: "Endpoint checks", body: "Check the MIP-003 and Cascade endpoints Cascade calls before it can hire your agent.", icon: Radar },
  { title: "Pricing and limits", body: "Set the base price, the share of budget it may pass on, and its bond. Copy the result into its config.", icon: SlidersHorizontal },
  { title: "Work and earnings", body: "See quote requests, jobs in escrow, what you were paid and the signals behind your score.", icon: Wallet },
] as const;

async function runCheck(url: string): Promise<EndpointCheck> {
  const response = await fetch("/api/provider/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `Check failed with ${response.status}`);
  return EndpointCheckSchema.parse(body);
}

export function ProviderPortal() {
  const router = useRouter();
  const params = useSearchParams();
  const agentParam = params.get("agent");
  const agentId = agentParam !== null && AGENT_ID.test(agentParam) ? agentParam : null;
  const [input, setInput] = useState(agentId ?? "");
  const [inputError, setInputError] = useState<string | null>(null);
  const [sample, setSample] = useState<string | null>(null);
  useEffect(() => void getSampleAgentId().then(setSample), []);

  const lookup = (e: FormEvent): void => {
    e.preventDefault();
    const id = input.trim().toLowerCase();
    if (!AGENT_ID.test(id)) {
      setInputError("A registry asset id is the 56 character policy id followed by the asset name, in hex.");
      return;
    }
    setInputError(null);
    router.push(`/provider?agent=${id}`);
  };

  return (
    <div className="grid gap-12">
      <Panel className="overflow-hidden">
        <div className="flex items-start gap-4 px-5 pt-5 sm:px-6 sm:pt-6">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-ink text-bg"><Fingerprint className="size-5" aria-hidden /></span>
          <div className="min-w-0">
            <h2 className="text-[1.0625rem] font-semibold tracking-tight">Import an agent</h2>
            <p className="mt-0.5 text-[0.875rem] text-ink-2">Paste the Masumi registry asset id of the agent you operate. Cascade reads its registry entry and capabilities.</p>
          </div>
        </div>
        <form onSubmit={lookup} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start sm:p-6" noValidate>
          <Field label="Registry asset id" htmlFor="agent-id" error={inputError} className="min-w-0 flex-1">
            <Input id="agent-id" value={input} onChange={(e) => setInput(e.target.value)} placeholder="67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b…" className="h-11 font-mono text-base sm:text-xs" spellCheck={false} autoComplete="off" autoCapitalize="none" autoCorrect="off" enterKeyHint="search" aria-invalid={inputError !== null || undefined} />
          </Field>
          <Button type="submit" className="h-12 sm:mt-[1.6rem] sm:h-11"><Search /> Look up</Button>
        </form>
        {agentId === null && sample !== null ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-line bg-surface-2/50 px-5 py-3.5 sm:px-6">
            <p className="text-[0.8125rem] text-ink-3">No agent yet? Explore the portal with sample data.</p>
            <Button type="button" variant="secondary" size="sm" className="max-sm:h-11 max-sm:px-4" onClick={() => { setInput(sample); router.push(`/provider?agent=${sample}`); }}>Open the sample agent</Button>
          </div>
        ) : null}
      </Panel>
      {agentId === null ? <Features /> : <AgentWorkspace agentId={agentId} />}
    </div>
  );
}

function Features() {
  return (
    <section aria-labelledby="provider-features">
      <SectionTitle id="provider-features" title="What you can do here" note="Three steps" />
      <ul className="grid gap-4 md:grid-cols-3">
        {FEATURES.map(({ title, body, icon: Icon }) => (
          <li key={title} className="tile rounded-[22px] max-sm:p-5 border border-line bg-surface p-6 shadow-card">
            <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent"><Icon className="size-5" aria-hidden /></span>
            <p className="mt-5 font-semibold tracking-tight">{title}</p>
            <p className="mt-1.5 text-[0.875rem] leading-relaxed text-ink-2">{body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AgentWorkspace({ agentId }: { agentId: string }) {
  const profile = useQuery({ queryKey: ["agent", agentId], queryFn: async () => (await getDataSource()).getAgent(agentId) });
  if (profile.isLoading) {
    return (
      <div className="flex items-center gap-4 rounded-[22px] border border-line bg-surface p-6 shadow-card" role="status" aria-live="polite">
        <span className="sr-only">Loading agent</span>
        <Skeleton className="size-12 rounded-xl" />
        <div className="grid flex-1 gap-2.5"><Skeleton className="h-5 w-40" /><Skeleton className="h-3.5 w-72 max-w-full" /></div>
      </div>
    );
  }
  if (profile.error !== null || profile.data === undefined) return <Panel><ErrorState error={profile.error} what="agent in the directory" /></Panel>;
  const a = profile.data;
  const available = a.availability === "available";
  return (
    <>
      <Panel className="flex flex-wrap items-center gap-x-5 gap-y-4 p-5 sm:p-6 motion-safe:animate-[rise_500ms_var(--ease-out-quint)_both]">
        <AgentAvatar name={a.name} seed={a.agent_asset_id} size={52} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[1.375rem] font-semibold tracking-tight">{a.name}</span>
            <Reputation score={a.reputation.score} className="text-[0.8125rem]" />
          </p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.8125rem] text-ink-3">
            <Hash value={a.agent_asset_id} label="registry asset id" className="[&_button]:relative [&_button]:before:absolute [&_button]:before:-inset-3 [&_button]:before:content-['']" />
            <span className="first-letter:uppercase">{a.capabilities.roles.join(", ")}</span>
            <span className="flex gap-3">{listingOf(a).rails.map((r) => <Rail key={r} rail={r as RailName} />)}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className={cn("inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-semibold", available ? "bg-accepted-bg text-accepted" : "bg-refunded-bg text-refunded")}>
            <span aria-hidden className={cn("size-1.5 rounded-full", available ? "bg-accepted" : "bg-refunded")} />
            {available ? "Available" : a.availability === "unavailable" ? "Unavailable" : "Not checked"}
          </span>
          <Button variant="secondary" size="sm" className="max-sm:h-11 max-sm:px-4" asChild>
            <Link href={`/agents/${a.agent_asset_id}`}>Public profile <ArrowUpRight aria-hidden /></Link>
          </Button>
        </div>
      </Panel>
      <Work agentId={agentId} />
      <section aria-labelledby="provider-setup">
        <SectionTitle id="provider-setup" title="Setup" note="Checks and config" />
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <EndpointChecks defaultUrl={a.api_url} />
          <Pricing profile={a} />
        </div>
      </section>
      <ReputationBreakdown profile={a} />
    </>
  );
}

function EndpointChecks({ defaultUrl }: { defaultUrl: string }) {
  const [url, setUrl] = useState(defaultUrl);
  const check = useMutation({ mutationFn: runCheck });
  const passed = check.data?.checks.filter((c) => c.status === "pass").length ?? 0;
  const total = check.data?.checks.length ?? 0;
  const requiredFailed = check.data?.checks.some((c) => c.required && c.status === "fail") ?? false;
  return (
    <Panel className="overflow-hidden">
      <PanelHeader title="Endpoint checks" description="MIP-003 and Cascade endpoints, fetched from this server without following redirects." />
      <form className="flex flex-col gap-2 p-5 pb-4 sm:flex-row" onSubmit={(e) => { e.preventDefault(); check.mutate(url); }}>
        <label htmlFor="agent-url" className="sr-only">Agent base URL</label>
        <Input id="agent-url" value={url} onChange={(e) => setUrl(e.target.value)} className="h-11 min-w-0 font-mono text-base sm:h-10 sm:text-xs" inputMode="url" autoComplete="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        <Button type="submit" variant="secondary" className="max-sm:h-11" disabled={check.isPending}>{check.isPending ? <Loader2 className="animate-spin" /> : <Radar aria-hidden />} Run checks</Button>
      </form>
      {check.error !== null ? <p className="mx-5 mb-5 rounded-xl bg-challenged-bg px-3.5 py-2.5 text-sm text-challenged" role="alert">{check.error.message}</p> : null}
      {check.data !== undefined ? (
        <>
          <div className="px-5 pb-4">
            <p className={cn("text-sm font-semibold", requiredFailed ? "text-challenged" : "text-accepted")} aria-live="polite">
              {passed} of {total} passed{requiredFailed ? ". A required MIP-003 endpoint failed, so Cascade will not hire this agent." : "."}
            </p>
            <span aria-hidden className="mt-2.5 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-line">
              <span className={cn("h-full rounded-full", requiredFailed ? "bg-challenged" : "bg-accepted")} style={{ width: `${total === 0 ? 0 : (passed / total) * 100}%` }} />
            </span>
          </div>
          <ul className="divide-y divide-line border-t border-line" data-testid="endpoint-checks">
            {check.data.checks.map((c) => (
              <li key={c.path} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-5 py-3 text-sm motion-safe:animate-[fade-in_300ms_both]">
                {c.status === "pass" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-accepted" aria-label="pass" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-challenged" aria-label="fail" />}
                <code className="min-w-0 break-all font-mono text-[0.78rem]">{c.path}</code>
                {c.required ? <span className="rounded-full border border-line px-1.5 font-mono text-[0.625rem] leading-4 tracking-[0.08em] text-ink-3 uppercase">required</span> : null}
                <span className="ml-auto basis-full pl-7 text-[0.8125rem] text-ink-3 sm:basis-auto sm:pl-0 sm:text-right">{c.detail}</span>
              </li>
            ))}
          </ul>
        </>
      ) : check.isPending ? (
        <div className="grid gap-3 px-5 pb-5" role="status" aria-live="polite">
          <span className="sr-only">Running checks</span>
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-4" />)}
        </div>
      ) : (
        <p className="mx-5 mb-5 rounded-xl border border-dashed border-line-strong px-4 py-3.5 text-[0.8125rem] text-ink-3">Checks run against the URL above. Private and loopback addresses are refused in production.</p>
      )}
    </Panel>
  );
}

function Pricing({ profile }: { profile: AgentProfile }) {
  const [price, setPrice] = useState("10");
  const [maxShare, setMaxShare] = useState("50");
  const [bond, setBond] = useState("5");
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const priceUnits = parseUnits(price, 6);
  const bondUnits = parseUnits(bond, 6);
  const share = Number(maxShare);
  const valid = priceUnits !== null && bondUnits !== null && Number.isInteger(share) && share >= 0 && share <= 100;
  const doc = valid
    ? JSON.stringify(
        {
          version: "1",
          roles: profile.capabilities.roles,
          categories: listingOf(profile).categories,
          max_depth: profile.capabilities.max_depth,
          rails: listingOf(profile).rails,
          bond_lovelace: bondUnits.toString(),
          registry_asset_id: profile.agent_asset_id,
          pricing: { asset: TUSDM_ASSET_ID, base_price: priceUnits.toString(), max_sub_budget_share_bps: share * 100 },
        },
        null,
        2,
      )
    : null;
  const copyDoc = (text: string): void => {
    navigator.clipboard.writeText(text).then(
      () => setCopy("copied"),
      () => setCopy("failed"),
    );
    setTimeout(() => setCopy("idle"), 1600);
  };
  return (
    <Panel className="overflow-hidden">
      <PanelHeader title="Pricing and limits" description="Your agent serves these in /.well-known/cascade.json. Edit here, then copy into its config." />
      <div className="grid gap-4 p-5 sm:grid-cols-3">
        <Field label="Base price, tUSDM" htmlFor="price"><Input id="price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={priceUnits === null || undefined} className="tabular h-11 text-base sm:h-10 sm:text-sm" /></Field>
        <Field label="Max sub-budget, %" htmlFor="share"><Input id="share" inputMode="numeric" value={maxShare} onChange={(e) => setMaxShare(e.target.value)} className="tabular h-11 text-base sm:h-10 sm:text-sm" /></Field>
        <Field label="Bond, ADA" htmlFor="bond"><Input id="bond" inputMode="decimal" value={bond} onChange={(e) => setBond(e.target.value)} aria-invalid={bondUnits === null || undefined} className="tabular h-11 text-base sm:h-10 sm:text-sm" /></Field>
      </div>
      {doc === null ? (
        <p className="mx-5 mb-5 rounded-xl bg-challenged-bg px-3.5 py-2.5 text-sm text-challenged" role="alert">Prices take at most 6 decimals and the share is a whole percent from 0 to 100.</p>
      ) : (
        <div className="px-5 pb-5">
          <div className="overflow-hidden rounded-2xl border border-line bg-surface-2">
            <div className="flex items-center justify-between gap-3 border-b border-line py-1.5 pr-1.5 pl-4">
              <span className="truncate font-mono text-[0.75rem] text-ink-3">/.well-known/cascade.json</span>
              <Button variant="ghost" size="sm" className="max-sm:h-11" onClick={() => copyDoc(doc)}>
                {copy === "copied" ? <Check className="text-accepted" aria-hidden /> : <Copy aria-hidden />}
                {copy === "copied" ? "Copied" : copy === "failed" ? "Copy failed" : "Copy cascade.json"}
              </Button>
            </div>
            <pre className="max-h-64 overflow-auto p-4 font-mono text-[0.72rem] leading-relaxed text-ink-2">{doc}</pre>
          </div>
        </div>
      )}
    </Panel>
  );
}

function Work({ agentId }: { agentId: string }) {
  const work = useQuery({ queryKey: ["provider-work", agentId], queryFn: async () => (await getDataSource()).getProviderWork(agentId) });
  if (work.isLoading) {
    return (
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[22px] border border-line bg-line sm:grid-cols-3 lg:grid-cols-5" role="status" aria-live="polite">
        <span className="sr-only">Loading inbox</span>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="grid gap-3 bg-surface px-5 py-5"><Skeleton className="h-3 w-20" /><Skeleton className="h-7 w-24" /></div>
        ))}
      </div>
    );
  }
  if (work.error !== null || work.data === undefined) return <Panel><ErrorState error={work.error} what="inbox" /></Panel>;
  const w = work.data;
  const now = Date.now();
  const waiting = w.quote_requests.length + w.active_jobs.length;
  return (
    <>
      <section aria-labelledby="provider-earnings">
        <SectionTitle id="provider-earnings" title="Earnings" note="From indexed trees" />
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[22px] border border-line bg-line shadow-card sm:grid-cols-3 lg:grid-cols-5">
          <BigStat label="Paid" value={<Amount value={w.earnings.paid.amount} asset={w.earnings.paid.asset} />} className="col-span-2 sm:col-span-1" />
          <BigStat label="In escrow" value={<Amount value={w.earnings.pending.amount} asset={w.earnings.pending.asset} />} className="col-span-2 sm:col-span-1" />
          <BigStat label="Bonds at risk" value={<Amount value={w.bonds_at_risk_lovelace} asset="lovelace" />} className="col-span-2 sm:col-span-1" />
          <BigStat label="Jobs settled" value={w.earnings.jobs_settled} />
          <BigStat label="Jobs refunded" value={w.earnings.jobs_refunded} />
        </dl>
      </section>
      <section aria-labelledby="provider-inbox">
        <SectionTitle id="provider-inbox" title="Inbox" note={`${waiting} ${waiting === 1 ? "item" : "items"}`} />
        <Panel className="overflow-hidden">
          <p className="border-b border-line px-5 py-3.5 text-[0.8125rem] text-ink-3 sm:px-6">Quote requests waiting for your agent, and jobs it holds escrow for.</p>
          {waiting === 0 ? <EmptyState title="Inbox is empty" body="New quote requests appear here as orchestrators plan jobs in your categories." /> : null}
          <ul className="divide-y divide-line">
            {w.quote_requests.map((q) => (
              <li key={q.spec_hash} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6 sm:px-6">
                <div className="min-w-0">
                  <span className="inline-flex h-5 items-center rounded-full bg-submitted-bg px-2 font-mono text-[0.625rem] tracking-[0.08em] text-submitted uppercase">Quote request</span>
                  <p className="mt-1.5 text-[0.9375rem] leading-snug">{q.task}</p>
                </div>
                <p className="text-[0.8125rem] text-ink-2 sm:text-right">
                  up to <Amount value={q.max_budget.amount} asset={q.max_budget.asset} className="font-semibold text-ink" />
                  <span className="mt-0.5 block font-mono text-[0.6875rem] text-ink-3">submit by {new Date(q.submit_by).toISOString().slice(11, 16)} UTC</span>
                </p>
              </li>
            ))}
            {w.active_jobs.map((j) => (
              <li key={j.node_id} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6 sm:px-6">
                <div className="min-w-0">
                  <span className="inline-flex h-5 items-center rounded-full bg-funded-bg px-2 font-mono text-[0.625rem] tracking-[0.08em] text-funded uppercase">Job</span>
                  <p className="mt-1.5 text-[0.9375rem] leading-snug">{j.task}</p>
                  <p className="mt-1 font-mono text-[0.6875rem] text-ink-3">{j.next_deadline > now ? `Next deadline in ${formatDuration(j.next_deadline - now)}` : "Deadline passed"}</p>
                </div>
                <div className="flex items-center gap-3"><Amount value={j.fee.amount} asset={j.fee.asset} className="text-sm font-semibold" /><StateBadge state={j.state} txId={j.state_tx} className="relative before:absolute before:-inset-y-2.5 before:inset-x-0 before:content-['']" /></div>
              </li>
            ))}
          </ul>
        </Panel>
      </section>
    </>
  );
}

function ReputationBreakdown({ profile }: { profile: AgentProfile }) {
  return (
    <section aria-labelledby="provider-reputation">
      <SectionTitle id="provider-reputation" title="Reputation" note="From settled trees" />
      <Panel className="p-5 sm:p-6">
        <p className="mb-5 text-[0.875rem] text-ink-2">
          Score <span className="tabular font-display text-[1.125rem] text-ink">{Math.round(profile.reputation.score * 100)}</span> of 100 at {Math.round(profile.reputation.confidence * 100)}% confidence, computed from settled trees.
        </p>
        <ReputationSignals profile={profile} />
      </Panel>
    </section>
  );
}
