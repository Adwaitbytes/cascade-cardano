"use client";

import type { CascadeEvent } from "@cascade/shared/browser";
import { ChartGantt, Check, Link2, ListTree, Network, ReceiptText, Snowflake } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Amount } from "@/components/amount";
import { Hash } from "@/components/hash";
import { AmountTicker } from "@/components/ticker";
import { Button } from "@/components/ui/button";
import type { AgentLabel } from "@/hooks/use-tree";
import { useMediaQuery, useNow, usePrefersReducedMotion } from "@/hooks/use-tree";
import type { LiveStatus } from "@/lib/api";
import type { Tree } from "@/lib/api/schemas";
import { cn } from "@/lib/cn";
import { describeEvent, replayTree, type NodeView } from "@/lib/tree/replay";
import { EventFeed } from "./event-feed";
import { NodeDrawer } from "./node-drawer";
import { Timeline } from "./timeline";
import { TreeCanvasSkeleton } from "./tree-canvas-skeleton";

// React Flow and dagre load only when the tree view is shown.
const TreeCanvas = dynamic(() => import("./tree-canvas").then((m) => m.TreeCanvas), { ssr: false, loading: () => <TreeCanvasSkeleton /> });
import { StageCaption, StageHeader, useMeteredStats } from "./stage";
import { TreeList } from "./tree-list";
import { Waterfall } from "./waterfall";

export interface TreeExplorerProps {
  tree: Tree;
  events: CascadeEvent[];
  agents: Map<string, AgentLabel>;
  status: LiveStatus;
  streamError: string | null;
  /** Events kept with gaps or skipped. Shown in development only. */
  eventWarnings?: string[];
  /** Start at the first event and play, for the stage recording (`?replay=1`). */
  autoplay?: boolean;
  /** Projector layout for the stage recording (`?stage=1`): full screen, large figures, slow replay. */
  stage?: boolean;
  /** Public read-only page shows share and receipt actions; the console embeds it. */
  variant: "public" | "embedded";
}

const STAT_CELL = "min-w-0 border-line px-4 py-4 sm:px-5 [&:nth-child(odd)]:border-r sm:[&:not(:last-child)]:border-r [&:nth-child(-n+2)]:border-b sm:[&:nth-child(-n+2)]:border-b-0";
const STAT_LABEL = "font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3 uppercase";
const STAT_VALUE = "mt-2 truncate font-display text-[clamp(1.15rem,2vw,1.5rem)] leading-none";
const VIEW_BUTTON = "inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full px-2.5 text-[0.8125rem] transition-[background-color,color,box-shadow] active:bg-surface/70 sm:h-7 sm:flex-none sm:text-xs";

const STATUS_TEXT: Record<LiveStatus, { label: string; tone: string }> = {
  connecting: { label: "Connecting", tone: "bg-working" },
  live: { label: "Live", tone: "bg-accepted" },
  polling: { label: "Live, checks every 3 s", tone: "bg-accepted" },
  offline: { label: "Not streaming", tone: "bg-refunded" },
  sample: { label: "Replay only", tone: "bg-refunded" },
};

export function TreeExplorer({ tree, events, agents, status, streamError, eventWarnings = [], autoplay = false, stage = false, variant }: TreeExplorerProps) {
  const [cursor, setCursor] = useState(autoplay ? 0 : events.length);
  const [following, setFollowing] = useState(!autoplay);
  const [playing, setPlaying] = useState(autoplay);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const wide = useMediaQuery("(min-width: 768px)");
  const [mode, setMode] = useState<"tree" | "list" | "waterfall" | null>(null);
  const viewMode = stage ? "tree" : (mode ?? (wide === false ? "list" : "tree"));
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (following) setCursor(events.length);
  }, [following, events.length]);

  const view = useMemo(() => replayTree(tree, events, cursor), [tree, events, cursor]);
  const replaying = cursor < events.length;
  const liveNow = useNow(!replaying && !view.closed);
  const now = replaying || view.closed ? (view.active?.emitted_at ?? events[0]?.emitted_at ?? liveNow) : liveNow;

  const nameOfNode = useCallback(
    (v: NodeView): string => {
      const id = v.node.agent_asset_id;
      return (id == null ? undefined : agents.get(id)?.name) ?? v.node.agent_name ?? `Node ${v.node.node_id.slice(0, 6)}`;
    },
    [agents],
  );
  const nameOfId = useCallback(
    (nodeId: string): string => {
      const v = view.nodes.get(nodeId);
      return v === undefined ? `Node ${nodeId.slice(0, 6)}` : nameOfNode(v);
    },
    [view, nameOfNode],
  );
  const describe = useCallback((e: CascadeEvent) => describeEvent(e, nameOfId), [nameOfId]);

  const moveCursor = useCallback(
    (next: number) => {
      setFollowing(next >= events.length);
      setCursor(next);
    },
    [events.length],
  );

  const recovered = useMemo(() => {
    let sum = 0n;
    for (let i = 0; i < cursor; i++) {
      const e = events[i];
      if (e?.type === "node.refunded") sum += BigInt(e.value.amount);
    }
    return sum;
  }, [events, cursor]);

  const root = view.rootId === null ? undefined : view.nodes.get(view.rootId);
  const metered = useMeteredStats(tree, events, view, !replaying && !view.closed && status !== "sample", nameOfId);
  const selected = selectedId === null ? null : (view.nodes.get(selectedId) ?? null);
  const status_ = STATUS_TEXT[status];

  const share = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/tree/${tree.tree_id}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  if (stage) {
    return (
      <section className="fixed inset-0 z-50 flex flex-col bg-bg" aria-label="Live Tree Explorer, stage view" data-testid="tree-explorer">
        <header className="flex items-center gap-4 border-b border-line px-6 py-3">
          <span className="text-base font-semibold">Cascade tree</span>
          <Hash value={tree.tree_id} label="tree id" />
          <span className="inline-flex items-center gap-1.5 text-sm text-ink-2">
            <span aria-hidden className={cn("size-2 rounded-full", replaying ? "bg-funded" : status_.tone)} />
            {replaying ? "Replaying indexed preprod events" : view.closed ? "Closed on preprod" : status_.label}
          </span>
          <Link href={`/tree/${tree.tree_id}`} className="ml-auto text-sm text-ink-3 underline-offset-4 hover:text-ink hover:underline">
            Leave stage view
          </Link>
        </header>
        <StageHeader tree={tree} view={view} recovered={recovered} metered={metered} />
        {/* The bottom gutter keeps every node clear of the caption. */}
        <div className="hairline-grid stage-canvas relative min-h-0 flex-1 pb-28">
          <TreeCanvas tree={tree} view={view} agents={agents} nameOf={nameOfNode} now={now} selectedId={selectedId} onOpen={setSelectedId} reducedMotion={reducedMotion} maxFitZoom={1.3} fitPadding={0.18} />
          <StageCaption text={view.active === null ? "The buyer is about to fund the root" : describe(view.active)} />
        </div>
        <Timeline events={events} cursor={cursor} onCursor={moveCursor} playing={playing} onPlaying={setPlaying} following={following} onFollow={() => { setPlaying(false); setFollowing(true); }} describe={describe} closed={view.closed} stepMs={2500} />
        <NodeDrawer treeId={tree.tree_id} view={selected} name={selected === null ? "" : nameOfNode(selected)} asset={tree.asset} minDisputeWindow={tree.min_dispute_window} onClose={() => setSelectedId(null)} />
      </section>
    );
  }

  return (
    <section className="overflow-clip rounded-[22px] border border-line bg-surface shadow-card" aria-label="Live Tree Explorer" data-testid="tree-explorer">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2.5 border-b border-line px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="font-mono text-[0.6875rem] tracking-[0.18em] text-ink-3 uppercase">Tree</span>
          <Hash value={tree.tree_id} label="tree id" />
        </div>
        <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-bg/60 px-2.5 text-xs font-medium text-ink-2" title={streamError ?? undefined}>
          <span aria-hidden className={cn("size-1.5 rounded-full", replaying ? "bg-funded" : status_.tone, status === "live" && "animate-pulse")} />
          {replaying ? "Replaying" : view.closed ? "Closed" : status_.label}
        </span>
        {view.frozen ? (
          <span className="inline-flex h-7 items-center gap-1 rounded-full bg-challenged-bg px-2.5 text-xs font-semibold text-challenged">
            <Snowflake className="size-3.5" aria-hidden /> Frozen
          </span>
        ) : null}
        <div className="flex w-full items-center gap-1.5 sm:ml-auto sm:w-auto">
          <div role="group" aria-label="View" className="flex flex-1 rounded-full border border-line bg-surface-2 p-0.5 sm:flex-none">
            <button type="button" onClick={() => setMode("tree")} aria-pressed={viewMode === "tree"} className={cn(VIEW_BUTTON, viewMode === "tree" ? "bg-surface font-semibold text-ink shadow-card" : "text-ink-3 hover:text-ink")}>
              <Network className="size-3.5 max-sm:hidden" aria-hidden /> Tree
            </button>
            <button type="button" onClick={() => setMode("list")} aria-pressed={viewMode === "list"} className={cn(VIEW_BUTTON, viewMode === "list" ? "bg-surface font-semibold text-ink shadow-card" : "text-ink-3 hover:text-ink")}>
              <ListTree className="size-3.5 max-sm:hidden" aria-hidden /> List
            </button>
            <button type="button" onClick={() => setMode("waterfall")} aria-pressed={viewMode === "waterfall"} className={cn(VIEW_BUTTON, viewMode === "waterfall" ? "bg-surface font-semibold text-ink shadow-card" : "text-ink-3 hover:text-ink")}>
              <ChartGantt className="size-3.5 max-sm:hidden" aria-hidden /> Waterfall
            </button>
          </div>
          {variant === "public" ? (
            <Button variant="ghost" size="sm" onClick={share} aria-label="Copy the public link to this tree" className="size-11 px-0 sm:h-8 sm:w-auto sm:px-3">
              {copied ? <Check className="text-accepted" /> : <Link2 />}
              <span className="hidden sm:inline">{copied ? "Copied" : "Share"}</span>
            </Button>
          ) : null}
          {tree.state !== "open" ? (
            <Button variant="secondary" size="sm" className="size-11 px-0 sm:h-8 sm:w-auto sm:px-3" asChild>
              <Link href={`/receipt/${tree.tree_id}`}>
                <ReceiptText /> <span className="max-sm:sr-only">Receipt</span>
              </Link>
            </Button>
          ) : null}
        </div>
      </header>

      {process.env.NODE_ENV !== "production" && eventWarnings.length > 0 ? (
        <details className="border-b border-line bg-working-bg px-4 py-2 text-xs text-working sm:px-5" data-testid="event-warnings">
          <summary className="cursor-pointer font-semibold">{eventWarnings.length} event {eventWarnings.length === 1 ? "warning" : "warnings"} (development only)</summary>
          <ul className="mt-1 grid gap-0.5 font-mono">{eventWarnings.slice(0, 20).map((w) => <li key={w}>{w}</li>)}</ul>
        </details>
      ) : null}
      <dl className="grid grid-cols-2 border-b border-line sm:grid-cols-4">
        <div className={STAT_CELL}>
          <dt className={STAT_LABEL}>Root budget</dt>
          <dd className={STAT_VALUE}>
            <Amount value={tree.root_budget} asset={tree.asset} />
          </dd>
        </div>
        <div className={STAT_CELL}>
          <dt className={STAT_LABEL}>Root holds now</dt>
          <dd className={STAT_VALUE} data-testid="root-held">
            <AmountTicker value={root?.held ?? 0n} asset={tree.asset} />
          </dd>
        </div>
        <div className={STAT_CELL}>
          <dt className={STAT_LABEL}>Refunded to parents</dt>
          <dd className={STAT_VALUE}>
            <AmountTicker value={recovered} asset={tree.asset} />
          </dd>
        </div>
        <div className={STAT_CELL}>
          <dt className={STAT_LABEL}>L1 transactions</dt>
          <dd className={cn(STAT_VALUE, "tabular")}>
            {view.txCount}
            {view.rolledBack > 0 ? <span className="ml-2 font-sans text-2xs text-working">{view.rolledBack} rolled back</span> : null}
          </dd>
        </div>
      </dl>

      <div className="grid 2xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className={cn("relative min-w-0", viewMode === "tree" ? "hairline-grid h-[min(620px,64dvh)] min-h-[360px] sm:h-[min(620px,70dvh)] sm:min-h-[420px]" : "bg-bg/40")}>
          {viewMode === "tree" ? (
            <TreeCanvas tree={tree} view={view} agents={agents} nameOf={nameOfNode} now={now} selectedId={selectedId} onOpen={setSelectedId} reducedMotion={reducedMotion} />
          ) : viewMode === "waterfall" ? (
            <Waterfall tree={tree} events={events.slice(0, cursor)} now={now} nameOf={nameOfId} onOpen={setSelectedId} />
          ) : (
            <TreeList view={view} nameOf={nameOfNode} onOpen={setSelectedId} />
          )}
        </div>
        <aside className="max-h-[min(360px,50dvh)] min-h-0 overflow-y-auto border-t border-line sm:max-h-[360px] 2xl:max-h-[min(620px,70dvh)] 2xl:border-t-0 2xl:border-l" aria-label="Event feed">
          <h3 className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-surface/95 px-4 py-3 backdrop-blur sm:px-5">
            <span className="text-[0.8125rem] font-semibold tracking-tight">Events</span>
            <span className="tabular font-mono text-[0.6875rem] tracking-[0.12em] text-ink-3 uppercase">{events.length} indexed · newest first</span>
          </h3>
          {events.length === 0 ? <p className="px-5 py-8 text-center text-sm text-ink-3">No events indexed yet. They appear here as the indexer sees each transaction.</p> : <EventFeed events={events} cursor={cursor} onSelect={moveCursor} describe={describe} />}
        </aside>
      </div>

      <Timeline
        events={events}
        cursor={cursor}
        onCursor={moveCursor}
        playing={playing}
        onPlaying={setPlaying}
        following={following}
        onFollow={() => {
          setPlaying(false);
          setFollowing(true);
        }}
        describe={describe}
        closed={view.closed}
      />

      <NodeDrawer treeId={tree.tree_id} view={selected} name={selected === null ? "" : nameOfNode(selected)} asset={tree.asset} minDisputeWindow={tree.min_dispute_window} onClose={() => setSelectedId(null)} />
    </section>
  );
}
