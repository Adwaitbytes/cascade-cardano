"use client";

import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";
import { memo } from "react";
import { formatAmount } from "@/lib/assets";
import { cn } from "@/lib/cn";
import type { Flow } from "@/lib/tree/replay";

export interface ValueEdgeData extends Record<string, unknown> {
  flow: Flow | null;
  active: boolean;
  reducedMotion: boolean;
  refunded: boolean;
  /** 0..1 share of the root budget this edge drew; drives stroke width. */
  weight: number;
  dimmed: boolean;
}

export type ValueEdgeType = Edge<ValueEdgeData, "value">;

const FLOW_COLOR: Record<Flow["kind"], string> = {
  draw: "var(--s-funded)",
  refund: "var(--s-refunded)",
  settle: "var(--s-accepted)",
  receipt: "var(--s-accepted)",
  resolve: "var(--s-challenged)",
};

export function flowLabel(flow: Flow): string {
  const amount = formatAmount(flow.amount, flow.asset);
  if (flow.kind === "refund") return `↑ Refund ${amount}`;
  return `${flow.direction === "down" ? "↓" : "↑"} ${amount}`;
}

function ValueEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<ValueEdgeType>) {
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 14, offset: 24 });
  const flow = data?.flow ?? null;
  const active = data?.active === true && flow !== null;
  const color = flow === null ? "var(--line-strong)" : FLOW_COLOR[flow.kind];
  const label = flow === null || flow.amount === 0n ? null : flowLabel(flow);
  const width = label === null ? 0 : label.length * 6.9 + 22;
  const animate = active && data?.reducedMotion !== true;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: active ? color : "var(--line-strong)",
          strokeWidth: 1.25 + 4.75 * (data?.weight ?? 0) + (active ? 0.75 : 0),
          strokeDasharray: data?.refunded === true ? "4 4" : undefined,
          opacity: data?.dimmed === true ? 0.15 : 1,
          transition: "stroke 300ms ease-out, opacity 200ms ease-out",
        }}
      />
      {animate && flow !== null ? (
        <g key={flow.eventId} aria-hidden data-testid="edge-flow">
          <circle r="3.5" fill={color}>
            {/* The travelling label stops short of the parent card and fades; the resting label sits at the child. */}
            <animateMotion dur="1.4s" fill="freeze" path={path} keyPoints={flow.direction === "down" ? "0;0.8" : "1;0.25"} keyTimes="0;1" calcMode="spline" keySplines="0.22 1 0.36 1" />
            <animate attributeName="opacity" values="1;1;0" keyTimes="0;0.7;1" dur="1.4s" fill="freeze" />
          </circle>
          {label !== null ? (
          <g>
            {/* The travelling label stops short of the parent card and fades; the resting label sits at the child. */}
            <animateMotion dur="1.4s" fill="freeze" path={path} keyPoints={flow.direction === "down" ? "0;0.8" : "1;0.25"} keyTimes="0;1" calcMode="spline" keySplines="0.22 1 0.36 1" />
            <animate attributeName="opacity" values="1;1;0" keyTimes="0;0.7;1" dur="1.4s" fill="freeze" />
            <rect x={-width / 2} y={-12} width={width} height={24} rx={12} fill="var(--surface)" stroke={color} strokeWidth={1.5} />
            <text textAnchor="middle" dominantBaseline="central" fontSize="11.5" fontWeight={600} fill={color} style={{ fontFamily: "var(--font-sans)" }}>
              {label}
            </text>
          </g>
          ) : null}
        </g>
      ) : null}
      {label !== null ? (
        <EdgeLabelRenderer>
          <div
            className={cn("nodrag nopan pointer-events-none absolute rounded-full border bg-surface px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap", animate && "animate-[label-in_300ms_ease-out_1.2s_both]")}
            style={{
              transform: `translate(-50%, -50%) translate(${targetX}px, ${targetY - 22}px)`,
              color: active ? color : "var(--ink-3)",
              borderColor: active ? color : "var(--line)",
              opacity: data?.dimmed === true ? 0.2 : 1,
              transition: "opacity 200ms ease-out",
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const ValueEdge = memo(ValueEdgeImpl);
