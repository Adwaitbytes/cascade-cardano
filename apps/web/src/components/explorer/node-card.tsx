"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { AgentAvatar } from "@/components/avatar";
import { Amount } from "@/components/amount";
import { AmountTicker } from "@/components/ticker";
import { Rail, railOfKind } from "@/components/rail";
import { Reputation } from "@/components/reputation";
import { STATE_STYLE, StateBadge } from "@/components/state-badge";
import { cn } from "@/lib/cn";
import { NODE_HEIGHT } from "@/lib/tree/layout";
import type { NodeView } from "@/lib/tree/replay";
import { nextDeadline } from "./deadline";

export interface NodeCardData extends Record<string, unknown> {
  view: NodeView;
  name: string;
  /** Card width from the layout, sized to the name. */
  width: number;
  reputation: number | null;
  testAgent: boolean;
  asset: string;
  now: number;
  /** One-off emphasis for the event being shown: a refund flash or a new hire fading in. */
  moment: "refund" | "enter" | null;
  replacesName: string | null;
  hasChildren: boolean;
  dimmed: boolean;
  onHover: (nodeId: string | null) => void;
  onOpen: (nodeId: string) => void;
}

export type NodeCardNode = Node<NodeCardData, "card">;

function NodeCardImpl({ data, selected }: NodeProps<NodeCardNode>) {
  const { view, name, width, reputation, asset, now, testAgent, moment, replacesName, hasChildren, dimmed } = data;
  const style = STATE_STYLE[view.state];
  const deadline = nextDeadline(view, now);
  const budget = BigInt(view.node.budget);
  const fee = BigInt(view.node.fee);
  const terminal = view.state === "Refunded" || view.state === "Settled";

  return (
    <div
      className={cn(
        "group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-surface text-left shadow-card transition-[box-shadow,border-color,opacity] duration-200",
        moment === "refund" && "node-refund-flash",
        moment === "enter" && "node-enter",
        selected ? "border-focus ring-3 ring-focus/25" : "border-line hover:border-line-strong",
        view.state === "Refunded" && "opacity-75",
        dimmed && "opacity-25",
      )}
      style={{ width, height: NODE_HEIGHT }}
      data-testid="node-card"
      data-layout="card"
      data-state={view.state}
      data-dimmed={dimmed ? "true" : undefined}
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px] transition-colors duration-500", style.bar)} />
      {/* Rings once when the node's state changes, keyed by the transaction that changed it. */}
      <span key={view.stateTxId ?? "none"} aria-hidden className={cn("state-ring pointer-events-none absolute inset-0 rounded-xl", style.text)} />
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-line-strong" isConnectable={false} />
      <div className="flex items-center gap-2.5 px-3.5 pt-3">
        <AgentAvatar name={name} seed={view.node.agent_asset_id ?? view.node.node_id} size={28} />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="nodrag block max-w-full truncate text-left text-sm font-semibold tracking-tight after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
            onClick={() => data.onOpen(view.node.node_id)}
            onFocus={() => data.onHover(view.node.node_id)}
            onBlur={() => data.onHover(null)}
            aria-label={`${name}, ${view.state}. Open details`}
          >
            {name}
          </button>
          <p className="truncate text-xs text-ink-3" title={replacesName !== null ? `Replaces ${replacesName}` : testAgent ? "Test agent, fails on purpose" : undefined}>{replacesName !== null ? `Replaces ${replacesName}` : testAgent ? "Test agent, fails on purpose" : view.node.depth === 0 ? "Orchestrator, root" : `Depth ${view.node.depth}`}</p>
        </div>
        {reputation !== null ? <Reputation score={reputation} /> : null}
      </div>
      <div className="flex items-baseline gap-2 px-3.5 pt-2">
        <Amount value={budget} asset={asset} className="text-base font-semibold tracking-tight" />
        {hasChildren && view.state !== "Settled" && view.state !== "Refunded" ? (
          <span className="shrink-0 whitespace-nowrap text-xs text-ink-3" data-testid="node-holds">
            holds <AmountTicker value={view.held} asset={asset} className="font-medium text-ink-2" />
          </span>
        ) : null}
        <span className="sr-only">
          fee <Amount value={fee} asset={asset} />
        </span>
      </div>
      <div className="mt-auto flex items-center gap-2 border-t border-line/70 px-3.5 py-2">
        <Rail rail={railOfKind(view.node.kind)} iconOnly />
        <span className={cn("tabular min-w-0 flex-1 truncate text-xs", deadline?.overdue ? "text-challenged" : "text-ink-3")} title={terminal ? undefined : deadline?.label}>
          {terminal ? (view.state === "Refunded" ? "Refunded" : "Paid") : (deadline?.label ?? "")}
        </span>
        <span className="relative z-10">
          <StateBadge state={view.state} txId={view.stateTxId} />
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-line-strong" isConnectable={false} />
    </div>
  );
}

export const NodeCard = memo(NodeCardImpl);
