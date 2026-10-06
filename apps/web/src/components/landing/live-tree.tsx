"use client";

import type { CascadeEvent } from "@cascade/shared/browser";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/hooks/use-tree";
import { getDataSource } from "@/lib/api";
import type { Tree } from "@/lib/api/schemas";
import { formatAmount } from "@/lib/assets";
import { describeEvent, replayTree, type DisplayState } from "@/lib/tree/replay";
import { CARD_MIN_W, fitCard, heroSnapshot, type HeroTree } from "@/lib/tree/hero";
import { tidyLayout } from "@/lib/tree/tidy";

const BOX_H = 46;
const GAP_X = 16;
const ROW = 88;
const STEP_MS = 900;
const HOLD_MS = 4200;

const STATE_FILL: Record<DisplayState, string> = {
  Funded: "var(--s-funded)",
  Working: "var(--s-working)",
  Submitted: "var(--s-submitted)",
  Accepted: "var(--s-accepted)",
  Settled: "var(--s-accepted)",
  Refunded: "var(--s-refunded)",
  Challenged: "var(--s-challenged)",
  Disputed: "var(--s-challenged)",
};

/**
 * The tree the landing data ranked richest in settled nodes, else the bundled capture of a real
 * preprod tree. An indexer outage also falls back to the capture, so the hero never goes blank.
 */
async function loadHeroTree(treeId: string | null): Promise<HeroTree> {
  if (treeId === null) return heroSnapshot();
  try {
    const source = await getDataSource();
    const [tree, events] = await Promise.all([source.getTree(treeId), source.getTreeEvents(treeId)]);
    return events.events.length > 0 ? { tree, events: events.events, fromSnapshot: false } : heroSnapshot();
  } catch {
    return heroSnapshot();
  }
}

const orthogonal = (x1: number, y1: number, x2: number, y2: number): string => {
  const mid = (y1 + y2) / 2;
  return `M${x1} ${y1} V${mid} H${x2} V${y2}`;
};

/**
 * The landing hero: a real preprod tree replayed from its indexed events. Money moves down on
 * hires and back up on refunds and settlements, exactly as the chain recorded it.
 */
export function LiveTree({ treeId }: { treeId: string | null }) {
  const hero = useQuery({ queryKey: ["hero-tree", treeId], queryFn: () => loadHeroTree(treeId), staleTime: 60_000 });
  if (hero.data === undefined) return <LiveTreeSkeleton />;
  return <LiveTreeReplay tree={hero.data.tree} events={hero.data.events} />;
}

function LiveTreeSkeleton() {
  return (
    <div className="grid gap-4" role="status" aria-label="Loading a live tree from preprod">
      <span className="mx-auto h-11 w-36 animate-pulse rounded-lg bg-surface-2" />
      <div className="flex justify-center gap-3">
        {[0, 1, 2, 3].map((i) => <span key={i} className="h-11 w-24 animate-pulse rounded-lg bg-surface-2" />)}
      </div>
      <span className="mx-auto h-4 w-2/3 animate-pulse rounded bg-surface-2" />
    </div>
  );
}

function LiveTreeReplay({ tree, events }: { tree: Tree; events: CascadeEvent[] }) {
  const reduced = usePrefersReducedMotion();
  const [cursor, setCursor] = useState(reduced ? events.length : 1);
  const [visible, setVisible] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // On narrow screens the picture scrolls; start centred on the root.
  useEffect(() => {
    const el = scroller.current;
    if (el !== null && el.scrollWidth > el.clientWidth) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? true), { threshold: 0.2 });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (reduced) {
      setCursor(events.length);
      return;
    }
    if (!visible) return;
    const atEnd = cursor >= events.length;
    const id = setTimeout(() => setCursor(atEnd ? 1 : cursor + 1), atEnd ? HOLD_MS : STEP_MS);
    return () => clearTimeout(id);
  }, [cursor, events.length, reduced, visible]);

  const view = useMemo(() => replayTree(tree, events, cursor), [tree, events, cursor]);
  const nameOf = (id: string): string => tree.nodes.find((n) => n.node_id === id)?.agent_name ?? `Node ${id.slice(0, 6)}`;
  const cards = useMemo(() => new Map(tree.nodes.map((n) => [n.node_id, fitCard(n.agent_name ?? `Node ${n.node_id.slice(0, 6)}`)])), [tree.nodes]);
  // Every slot fits the widest card, so siblings never overlap and short names stay compact.
  const slot = Math.max(CARD_MIN_W, ...[...cards.values()].map((c) => c.width)) + GAP_X;
  const layout = useMemo(() => tidyLayout(tree.nodes.map((n) => ({ id: n.node_id, parentId: n.parent_id })), slot, ROW), [tree.nodes, slot]);
  const cardOf = (id: string) => cards.get(id) ?? { width: CARD_MIN_W, label: nameOf(id) };
  const active = view.active;
  const pad = 8;
  const vbW = Math.max(layout.width, slot) + pad * 2;
  const vbH = layout.height + BOX_H + pad * 2;
  const point = (id: string) => layout.points.get(id) ?? { x: 0, y: 0 };

  return (
    <div ref={ref} className="grid gap-4" data-testid="live-tree">
      {/* Below 640 px the tree keeps a readable size and scrolls sideways inside the card. */}
      <div ref={scroller} className="snap-rail -mx-4 overflow-x-auto px-4 [mask-image:linear-gradient(90deg,#000_80%,transparent)] sm:mx-0 sm:px-0 sm:[mask-image:none]" tabIndex={0} aria-label="Tree picture, scrolls sideways on small screens">
      <svg viewBox={`${-pad} ${-pad} ${vbW} ${vbH}`} style={{ minWidth: vbW * 0.82, maxWidth: vbW }} className="mx-auto block h-auto w-full sm:!min-w-0" role="img" aria-label={`Tree ${tree.tree_id.slice(0, 8)} on preprod, replayed from its ${events.length} indexed events`}>
        <g fill="none">
          {[...view.nodes.values()].filter((n) => n.visible && n.node.parent_id !== null).map((n) => {
            const from = point(n.node.parent_id ?? "");
            const to = point(n.node.node_id);
            const d = orthogonal(from.x, from.y + BOX_H, to.x, to.y);
            const flowing = active !== null && n.flow?.eventId === active.event_id && !reduced;
            return (
              <g key={`e-${n.node.node_id}`}>
                <path d={d} stroke="var(--line-strong)" strokeWidth={1.25} strokeDasharray={n.state === "Refunded" ? "4 4" : undefined} />
                {flowing && n.flow !== null ? (
                  <circle key={n.flow.eventId} r={4.5} fill={n.flow.direction === "down" ? "var(--s-funded)" : n.flow.kind === "refund" ? "var(--s-refunded)" : "var(--s-accepted)"}>
                    <animateMotion dur="0.8s" fill="freeze" path={d} keyPoints={n.flow.direction === "down" ? "0;1" : "1;0"} keyTimes="0;1" calcMode="spline" keySplines="0.22 1 0.36 1" />
                  </circle>
                ) : null}
              </g>
            );
          })}
        </g>
        {[...view.nodes.values()].map((n) => {
          const p = point(n.node.node_id);
          if (!n.visible) {
            // Not hired yet at this point of the replay: a ghost of where it will appear.
            return (
              <g key={n.node.node_id} transform={`translate(${p.x - cardOf(n.node.node_id).width / 2} ${p.y})`} opacity={0.35}>
                <rect width={cardOf(n.node.node_id).width} height={BOX_H} rx={9} fill="none" stroke="var(--line-strong)" strokeDasharray="3 4" />
              </g>
            );
          }
          return (
            <g key={n.node.node_id} transform={`translate(${p.x - cardOf(n.node.node_id).width / 2} ${p.y})`} style={{ opacity: n.state === "Refunded" ? 0.6 : 1 }}>
              <g className="live-node">
              <title>{`${nameOf(n.node.node_id)}, ${formatAmount(n.node.budget, tree.asset)}, ${n.state}`}</title>
              <rect width={cardOf(n.node.node_id).width} height={BOX_H} rx={9} fill="var(--surface)" stroke={active?.node_id === n.node.node_id ? "var(--ink)" : "var(--line-strong)"} strokeWidth={active?.node_id === n.node.node_id ? 1.5 : 1} className="transition-[stroke] duration-300" />
              <rect x={0} y={9} width={3} height={BOX_H - 18} rx={1.5} fill={STATE_FILL[n.state]} className="transition-[fill] duration-500" />
              <text x={13} y={19} fontSize={12.5} fontWeight={600} fill="var(--ink)">{cardOf(n.node.node_id).label}</text>
              <text x={13} y={35} fontSize={11} fill="var(--ink-3)" className="tabular-nums">{formatAmount(n.node.budget, tree.asset)}</text>
              </g>
            </g>
          );
        })}
      </svg>
      </div>
      <div className="flex items-center gap-3 text-[0.8125rem]">
        <span className="min-w-0 flex-1 truncate text-ink-2" aria-live="off">{active === null ? "Funding the root" : describeEvent(active, nameOf)}</span>
        <Link href={`/tree/${tree.tree_id}`} className="shrink-0 font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
          Open this tree
        </Link>
      </div>
      <div aria-hidden className="h-0.5 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full bg-ink/60 transition-[width] duration-700 ease-out" style={{ width: `${(cursor / events.length) * 100}%` }} />
      </div>
    </div>
  );
}
