"use client";

import { AgentAvatar } from "@/components/avatar";
import { Amount } from "@/components/amount";
import { Rail, railOfKind } from "@/components/rail";
import { StateBadge, STATE_STYLE } from "@/components/state-badge";
import { cn } from "@/lib/cn";
import type { NodeView, TreeView } from "@/lib/tree/replay";
import { flowLabel } from "./value-edge";

interface Props {
  view: TreeView;
  nameOf: (view: NodeView) => string;
  onOpen: (nodeId: string) => void;
}

/** The tree as nested lists: the phone layout and the accessible reading of the canvas. */
export function TreeList({ view, nameOf, onOpen }: Props) {
  const children = new Map<string, NodeView[]>();
  for (const n of view.nodes.values()) {
    if (!n.visible || n.node.parent_id === null) continue;
    const list = children.get(n.node.parent_id) ?? [];
    list.push(n);
    children.set(n.node.parent_id, list);
  }
  const root = view.rootId === null ? undefined : view.nodes.get(view.rootId);
  if (root === undefined || !root.visible) return <p className="p-5 text-sm text-ink-3">The tree appears when the buyer funds the root.</p>;

  const renderNode = (n: NodeView) => {
    const kids = children.get(n.node.node_id) ?? [];
    const active = view.active !== null && n.flow?.eventId === view.active.event_id;
    return (
      <li key={n.node.node_id} className="relative">
        <div className={cn("relative flex min-h-14 items-center gap-3 rounded-xl border bg-surface py-2.5 pr-3 pl-3.5 transition-colors active:bg-surface-2", active ? "border-focus/60" : "border-line")} data-testid="node-card" data-layout="row" data-state={n.state}>
          <span aria-hidden className={cn("absolute inset-y-2 left-0 w-[3px] rounded-r", STATE_STYLE[n.state].bar)} />
          <AgentAvatar name={nameOf(n)} seed={n.node.agent_asset_id ?? n.node.node_id} size={28} />
          <div className="min-w-0 flex-1">
            <button type="button" onClick={() => onOpen(n.node.node_id)} className="block max-w-full truncate text-left text-sm font-semibold after:absolute after:inset-0 after:rounded-lg after:content-[''] hover:underline hover:underline-offset-2 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-focus">
              {nameOf(n)}
            </button>
            <p className="flex flex-wrap items-center gap-x-2 text-2xs text-ink-3">
              <Amount value={n.node.budget} asset={view.asset} className="text-ink-2" />
              <Rail rail={railOfKind(n.node.kind)} className="text-2xs" />
              {n.flow !== null && n.flow.amount > 0n ? <span className={active ? "font-semibold text-ink" : undefined}>{flowLabel(n.flow)}</span> : null}
            </p>
          </div>
          <StateBadge state={n.state} txId={n.stateTxId} className="relative z-10 max-sm:h-8" />
        </div>
        {kids.length > 0 ? <ul className="mt-2 ml-3.5 grid gap-2 border-l border-line pl-3">{kids.map(renderNode)}</ul> : null}
      </li>
    );
  };

  return <ul className="grid gap-2 p-4" aria-label="Tree nodes">{renderNode(root)}</ul>;
}
