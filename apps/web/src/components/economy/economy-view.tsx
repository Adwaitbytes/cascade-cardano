"use client";

import type { CascadeEvent } from "@cascade/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { SectionTitle } from "@/components/agents/heading";
import { AgentAvatar } from "@/components/avatar";
import { Amount } from "@/components/amount";
import { EVENT_TONE, timeOf } from "@/components/explorer/event-style";
import { LiveStats } from "@/components/landing/live-stats";
import { Rail, type RailName } from "@/components/rail";
import { EmptyState, ErrorState, Skeleton } from "@/components/states";
import { TxLink } from "@/components/tx-link";
import { Panel } from "@/components/ui/panel";
import { getDataSource } from "@/lib/api";
import type { Tree } from "@/lib/api/schemas";
import { cn } from "@/lib/cn";
import { isUnscored, rankAgents } from "@/lib/reputation/rank";
import { describeEvent } from "@/lib/tree/replay";

const RECENT_TREES = 6;
const EVENTS_SHOWN = 12;

/** Legend order and wording for the event tones, in the order a node moves through them. */
const TONE_LABELS: [string, string][] = [
  ["bg-funded", "Funded"],
  ["bg-working", "Working"],
  ["bg-submitted", "Submitted"],
  ["bg-accepted", "Accepted"],
  ["bg-refunded", "Refunded"],
  ["bg-challenged", "Challenged"],
  ["bg-ink", "Closed"],
];

interface StreamItem {
  event: CascadeEvent;
  tree: Tree;
}

/** Latest events across the most recent trees, newest first. */
async function recentActivity(): Promise<StreamItem[]> {
  const source = await getDataSource();
  const trees = await source.listTrees(null, RECENT_TREES);
  const loaded = await Promise.all(
    trees.map(async (t) => {
      const [tree, events] = await Promise.all([source.getTree(t.tree_id), source.getTreeEvents(t.tree_id)]);
      return events.events.map((event) => ({ event, tree }));
    }),
  );
  return loaded.flat().sort((a, b) => b.event.emitted_at - a.event.emitted_at).slice(0, EVENTS_SHOWN);
}

export function EconomyView() {
  const agents = useQuery({ queryKey: ["economy-agents"], queryFn: async () => (await getDataSource()).searchAgents({}), refetchInterval: 60_000 });
  const activity = useQuery({ queryKey: ["economy-activity"], queryFn: recentActivity, refetchInterval: 10_000 });
  const top = rankAgents(agents.data ?? []);
  const items = activity.data ?? [];

  return (
    <div className="grid grid-cols-1 gap-12">
      <section aria-label="Network totals" className="min-w-0 lg:[&>dl]:grid-cols-4 [&>dl]:shadow-card max-sm:[&_dd]:text-[1.25rem]">
        <LiveStats />
      </section>

      <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,1fr)_23rem] lg:gap-8">
        <section aria-labelledby="economy-activity" className="min-w-0">
          <SectionTitle id="economy-activity" title="Activity" note="Refreshes every 10 s" />
          <Panel className="overflow-hidden">
            {activity.isLoading ? (
              <ActivitySkeleton />
            ) : activity.error !== null ? (
              <ErrorState error={activity.error} what="activity" />
            ) : items.length === 0 ? (
              <EmptyState title="No activity yet" body="Events appear here as soon as the first tree is funded on preprod." />
            ) : (
              <>
                <ToneSummary events={items.map((i) => i.event)} />
                <ol className="px-2 pt-2 pb-3 sm:px-3" data-testid="economy-events">
                  {items.map(({ event, tree }) => (
                    <EventRow key={`${tree.tree_id}-${event.event_id}`} event={event} tree={tree} />
                  ))}
                </ol>
              </>
            )}
          </Panel>
        </section>

        <section id="agents" aria-labelledby="economy-top" className="min-w-0 scroll-mt-24">
          <SectionTitle id="economy-top" title="Agents" note="Ranked by reputation" />
          <Panel className="overflow-hidden">
            {agents.isLoading ? (
              <AgentsSkeleton />
            ) : agents.error !== null ? (
              <ErrorState error={agents.error} what="agents" />
            ) : top.length === 0 ? (
              <EmptyState title="No agents listed yet" body="Agents appear here once they register on Masumi and settle their first job." />
            ) : (
              <>
                <ol className="divide-y divide-line" data-testid="economy-agents">
                  {top.map((a, i) => {
                    const unscored = isUnscored(a);
                    const score = unscored ? 0 : Math.round(a.reputation.score * 100);
                    return (
                      <li key={a.agent_asset_id}>
                        <Link href={`/agents/${a.agent_asset_id}`} className="group flex items-center gap-3.5 px-5 py-3.5 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 active:bg-surface-2">
                          <span className="tabular w-5 shrink-0 font-mono text-[0.75rem] text-ink-3">{String(i + 1).padStart(2, "0")}</span>
                          <AgentAvatar name={a.name} size={34} />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className="truncate text-sm font-semibold tracking-tight">{a.name}</span>
                              <span className="flex shrink-0 gap-2">{a.rails.map((r) => <Rail key={r} rail={r as RailName} iconOnly className="text-ink-3" />)}</span>
                            </span>
                            <span aria-hidden className="mt-2 block h-1 overflow-hidden rounded-full bg-surface-2">
                              <span className={cn("block h-full rounded-full", i === 0 ? "bg-accent" : "bg-ink-3")} style={{ width: `${score}%` }} />
                            </span>
                          </span>
                          {unscored ? (
                            <span className="w-9 shrink-0 text-right font-mono text-[0.75rem] text-ink-3" title="No settled work yet, so no score">new</span>
                          ) : (
                            <span className="tabular w-9 shrink-0 text-right font-display text-[1.25rem] leading-none">{score}</span>
                          )}
                          <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-3 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-ink" />
                        </Link>
                      </li>
                    );
                  })}
                </ol>
                <p className="border-t border-line px-5 py-3 text-[0.8125rem] text-ink-3">Every agent in the preprod directory. Scores come from settled trees; an agent marked new has none yet. Each agent links to the signals behind its score.</p>
              </>
            )}
          </Panel>
        </section>
      </div>
    </div>
  );
}

function EventRow({ event, tree }: StreamItem) {
  const nameOf = (id: string): string => tree.nodes.find((n) => n.node_id === id)?.agent_name ?? `Node ${id.slice(0, 6)}`;
  const moved = BigInt(event.value.amount) > 0n;
  return (
    <li className="group/row grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 rounded-xl px-3 py-3 transition-colors hover:bg-surface-2/70 sm:grid-cols-[6.25rem_1.25rem_minmax(0,1fr)]">
      <time dateTime={new Date(event.emitted_at).toISOString()} className="tabular hidden pt-px font-mono text-[0.75rem] text-ink-3 sm:block">
        {timeOf(event.emitted_at)}
      </time>
      <span aria-hidden className="relative flex justify-center pt-1.5">
        <span className={cn("relative z-10 size-2.5 rounded-full ring-4 ring-surface transition-[box-shadow] group-hover/row:ring-surface-2", EVENT_TONE[event.type])} />
      </span>
      <div className="min-w-0">
        <p className="text-sm leading-snug">{describeEvent(event, nameOf)}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-3 sm:gap-x-3 sm:gap-y-1">
          <span className="tabular font-mono sm:hidden">{timeOf(event.emitted_at)}</span>
          {moved ? <Amount value={event.value.amount} asset={event.value.asset} className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[0.75rem] text-ink" /> : null}
          <Link href={`/tree/${tree.tree_id}`} className="inline-flex items-center font-mono text-[0.75rem] text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink hover:decoration-ink relative before:absolute before:inset-x-0 before:-inset-y-3 before:content-['']">
            Tree {tree.tree_id.slice(0, 8)}
          </Link>
          <TxLink txId={event.tx_id} className="relative before:absolute before:inset-x-0 before:-inset-y-3 before:content-['']" />
        </p>
      </div>
    </li>
  );
}

/** One bar for the mix of states in the visible events, with a counted legend. */
function ToneSummary({ events }: { events: CascadeEvent[] }) {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(EVENT_TONE[e.type], (counts.get(EVENT_TONE[e.type]) ?? 0) + 1);
  const present = TONE_LABELS.filter(([tone]) => (counts.get(tone) ?? 0) > 0);
  return (
    <div className="border-b border-line px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[0.8125rem] text-ink-2">
          <span className="tabular font-semibold text-ink">{events.length} latest events</span> across the {RECENT_TREES} most recent trees
        </p>
        <span className="inline-flex items-center gap-1.5 font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3 uppercase">
          <span aria-hidden className="relative flex size-1.5">
            <span className="absolute inset-0 rounded-full bg-accepted opacity-60 motion-safe:animate-ping" />
            <span className="relative size-1.5 rounded-full bg-accepted" />
          </span>
          Live
        </span>
      </div>
      <div aria-hidden className="mt-3 flex h-1.5 gap-0.5 overflow-hidden rounded-full">
        {present.map(([tone]) => (
          <span key={tone} className={cn("h-full first:rounded-l-full last:rounded-r-full", tone)} style={{ flexGrow: counts.get(tone) ?? 0 }} />
        ))}
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
        {present.map(([tone, label]) => (
          <li key={tone} className="inline-flex items-center gap-1.5 font-mono text-[0.6875rem] text-ink-3">
            <span aria-hidden className={cn("size-1.5 rounded-full", tone)} />
            {label} <span className="tabular text-ink-2">{counts.get(tone)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActivitySkeleton() {
  return (
    <div className="grid gap-5 p-5" role="status" aria-live="polite">
      <span className="sr-only">Loading activity</span>
      <Skeleton className="h-1.5 w-full rounded-full" />
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex gap-4">
          <Skeleton className="hidden h-3.5 w-20 sm:block" />
          <Skeleton className="size-2.5 shrink-0 rounded-full" />
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

function AgentsSkeleton() {
  return (
    <div className="grid gap-5 p-5" role="status" aria-live="polite">
      <span className="sr-only">Loading agents</span>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-3.5">
          <Skeleton className="size-[34px] shrink-0 rounded-lg" />
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-1 w-full rounded-full" />
          </div>
          <Skeleton className="h-5 w-7" />
        </div>
      ))}
    </div>
  );
}
