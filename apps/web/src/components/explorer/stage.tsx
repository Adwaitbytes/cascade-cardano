"use client";

import type { CascadeEvent } from "@cascade/shared/browser";
import { useQueries } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { useMemo } from "react";
import { AmountTicker, CountTicker } from "@/components/ticker";
import { cn } from "@/lib/cn";
import { getDataSource } from "@/lib/api";
import type { NodeDetail, Tree } from "@/lib/api/schemas";
import type { TreeView } from "@/lib/tree/replay";

export interface MeteredStat {
  nodeId: string;
  name: string;
  calls: number;
  /** True when `calls` is spread over time between two indexed events rather than read from the chain. */
  estimated: boolean;
  l1Txs: number;
}

/**
 * Calls made through each metered leaf at the replay cursor (PRD 21.2 step 3). The indexer reports
 * the channel's call total; between the channel opening and closing in a replay there is no
 * per-moment figure, so the count is spread over that time span and marked as an estimate.
 */
export function useMeteredStats(tree: Tree, events: readonly CascadeEvent[], view: TreeView, live: boolean, nameOf: (id: string) => string): MeteredStat[] {
  const metered = useMemo(() => tree.nodes.filter((n) => n.kind === "MeteredReceipt"), [tree.nodes]);
  const details = useQueries({
    queries: metered.map((n) => ({
      queryKey: ["node-detail", tree.tree_id, n.node_id],
      queryFn: async (): Promise<NodeDetail> => (await getDataSource()).getNodeDetail(tree.tree_id, n.node_id),
      refetchInterval: live ? 3_000 : (false as const),
    })),
  });
  return metered.flatMap((n, i) => {
    const total = details[i]?.data?.metered?.calls;
    const v = view.nodes.get(n.node_id);
    if (total === undefined || v === undefined || !v.visible) return [];
    const mine = events.slice(0, view.cursor).filter((e) => e.node_id === n.node_id);
    const drawnAt = mine.find((e) => e.type === "node.drawn")?.emitted_at;
    const closeEvent = events.find((e) => e.node_id === n.node_id && e.type === "receipt.closed");
    const closedNow = mine.some((e) => e.type === "receipt.closed");
    const now = view.active?.emitted_at ?? drawnAt ?? 0;
    let calls = total;
    let estimated = false;
    if (!closedNow && closeEvent !== undefined && drawnAt !== undefined && !live) {
      const span = Math.max(1, closeEvent.emitted_at - drawnAt);
      calls = Math.max(0, Math.min(total, Math.round((total * (now - drawnAt)) / span)));
      estimated = true;
    }
    return [{ nodeId: n.node_id, name: nameOf(n.node_id), calls, estimated, l1Txs: new Set(mine.map((e) => e.tx_id)).size }];
  });
}

export function StageHeader({ tree, view, recovered, metered }: { tree: Tree; view: TreeView; recovered: bigint; metered: MeteredStat[] }) {
  const root = view.rootId === null ? undefined : view.nodes.get(view.rootId);
  return (
    <div className="grid gap-x-10 gap-y-4 border-b border-line px-6 py-5 sm:grid-cols-2 lg:grid-cols-4" data-testid="stage-header">
      <div>
        <p className="text-sm text-ink-3">Root holds now</p>
        <p className="mt-1 text-[2.4rem] leading-none font-semibold tracking-tight" data-testid="stage-root-held">
          <AmountTicker value={root?.held ?? 0n} asset={tree.asset} />
        </p>
      </div>
      <div>
        <p className="text-sm text-ink-3">Refunded to parents</p>
        <p className="mt-1 text-[2.4rem] leading-none font-semibold tracking-tight">
          <AmountTicker value={recovered} asset={tree.asset} />
        </p>
      </div>
      <div>
        <p className="text-sm text-ink-3">L1 transactions in this tree</p>
        <p className="mt-1 text-[2.4rem] leading-none font-semibold tracking-tight">
          <CountTicker value={view.txCount} />
        </p>
      </div>
      {metered.map((m) => (
        <div key={m.nodeId} data-testid="stage-metered">
          <p className="flex items-center gap-1.5 text-sm text-ink-3">
            <Gauge className="size-4" aria-hidden /> {m.name}, metered
          </p>
          <p className="mt-1 flex items-baseline gap-3 text-[2.4rem] leading-none font-semibold tracking-tight">
            <CountTicker value={m.calls} />
            <span className="text-base font-medium text-ink-2">calls</span>
            <span className="ml-2 inline-flex items-baseline gap-1.5 text-base font-medium text-ink-2">
              <span className="text-[2.4rem] leading-none font-semibold tracking-tight text-ink">{m.l1Txs}</span>
              {m.l1Txs === 1 ? "L1 transaction" : "L1 transactions"}
            </span>
          </p>
          <p className={cn("mt-1 text-xs text-ink-3", !m.estimated && "invisible")}>Call count between indexed events is estimated</p>
        </div>
      ))}
    </div>
  );
}

/** Large caption for the projector: what just happened, in plain words. */
export function StageCaption({ text }: { text: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 z-10 flex justify-center px-6">
      <p key={text} className="stage-caption max-w-[80%] rounded-2xl border border-line bg-surface/95 px-6 py-3 text-center text-[1.6rem] leading-tight font-semibold tracking-tight shadow-pop backdrop-blur" aria-live="polite" data-testid="stage-caption">
        {text}
      </p>
    </div>
  );
}
