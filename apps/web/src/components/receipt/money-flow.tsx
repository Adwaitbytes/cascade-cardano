"use client";

import { sankey, sankeyJustify, sankeyLinkHorizontal } from "d3-sankey";
import { useMemo } from "react";
import { formatAmount } from "@/lib/assets";

export interface FlowNode {
  id: string;
  label: string;
  tone: "deposit" | "tree" | "paid" | "refund" | "fee";
}

export interface FlowLink {
  source: string;
  target: string;
  amount: bigint;
}

const TONE: Record<FlowNode["tone"], string> = {
  deposit: "var(--s-funded)",
  tree: "var(--ink)",
  paid: "var(--s-accepted)",
  refund: "var(--s-refunded)",
  fee: "var(--s-submitted)",
};

const WIDTH = 720;

/** Where the deposit went, drawn to scale (PRD 14.1 money flow view). Labels carry exact amounts. */
export function MoneyFlow({ nodes, links, asset }: { nodes: FlowNode[]; links: FlowLink[]; asset: string }) {
  const height = Math.max(220, nodes.length * 30);
  const layout = useMemo(() => {
    const visible = links.filter((l) => l.amount > 0n);
    const used = new Set(visible.flatMap((l) => [l.source, l.target]));
    const graph = sankey<FlowNode & { amount?: bigint }, { amount: bigint }>()
      .nodeId((d) => d.id)
      .nodeAlign(sankeyJustify)
      .nodeWidth(10)
      .nodePadding(12)
      .extent([
        [1, 8],
        [WIDTH - 1, height - 8],
      ]);
    return graph({
      nodes: nodes.filter((n) => used.has(n.id)).map((n) => ({ ...n })),
      links: visible.map((l) => ({ source: l.source, target: l.target, value: Number(l.amount), amount: l.amount })),
    });
  }, [nodes, links, height]);

  const totals = new Map<string, bigint>();
  for (const l of layout.links) {
    const t = (l.target as FlowNode).id;
    totals.set(t, (totals.get(t) ?? 0n) + l.amount);
    const s = (l.source as FlowNode).id;
    if ((l.source as FlowNode).tone === "deposit") totals.set(s, (totals.get(s) ?? 0n) + l.amount);
  }

  return (
    <div className="overflow-x-auto" data-testid="money-flow">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} className="min-w-[560px]" role="img" aria-label="Money flow from the deposit to every payee and refund">
        <g fill="none">
          {layout.links.map((l, i) => (
            <path key={i} d={sankeyLinkHorizontal()(l) ?? undefined} stroke={(l.source as FlowNode).tone === "deposit" ? "var(--line-strong)" : TONE[(l.target as FlowNode).tone]} strokeOpacity={(l.source as FlowNode).tone === "deposit" ? 0.35 : 0.22} strokeWidth={Math.max(1, l.width ?? 1)}>
              <title>{`${(l.source as FlowNode).label} to ${(l.target as FlowNode).label}: ${formatAmount(l.amount, asset)}`}</title>
            </path>
          ))}
        </g>
        {layout.nodes.map((n) => {
          const x0 = n.x0 ?? 0;
          const x1 = n.x1 ?? 0;
          const y0 = n.y0 ?? 0;
          const y1 = n.y1 ?? 0;
          const right = x0 > WIDTH / 2;
          const total = totals.get(n.id);
          return (
            <g key={n.id}>
              <rect x={x0} y={y0} width={x1 - x0} height={Math.max(1, y1 - y0)} rx={2} fill={TONE[n.tone]} />
              <text x={right ? x0 - 8 : x1 + 8} y={(y0 + y1) / 2} dominantBaseline="central" textAnchor={right ? "end" : "start"} fontSize="12" fill="var(--ink)">
                <tspan fontWeight={600}>{n.label}</tspan>
                {total !== undefined ? <tspan fill="var(--ink-3)"> {formatAmount(total, asset)}</tspan> : null}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
