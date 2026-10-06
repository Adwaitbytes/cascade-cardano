"use client";

import { Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NODE_HEIGHT, NODE_WIDTH, cardWidth, layoutTree } from "@/lib/tree/layout";
import { edgeWeight, relatedIds } from "@/lib/tree/related";
import type { NodeView, TreeView } from "@/lib/tree/replay";
import type { Tree } from "@/lib/api/schemas";
import type { AgentLabel } from "@/hooks/use-tree";
import { NodeCard, type NodeCardNode } from "./node-card";
import { ValueEdge, type ValueEdgeType } from "./value-edge";

const nodeTypes = { card: NodeCard };

const STATE_COLOR: Record<NodeView["state"], string> = {
  Funded: "var(--s-funded)",
  Working: "var(--s-working)",
  Submitted: "var(--s-submitted)",
  Accepted: "var(--s-accepted)",
  Settled: "var(--s-accepted)",
  Refunded: "var(--s-refunded)",
  Challenged: "var(--s-challenged)",
  Disputed: "var(--s-challenged)",
};
const edgeTypes = { value: ValueEdge };
const MIN_ZOOM = 0.25;

interface Props {
  tree: Tree;
  view: TreeView;
  agents: Map<string, AgentLabel>;
  nameOf: (view: NodeView) => string;
  now: number;
  selectedId: string | null;
  onOpen: (nodeId: string) => void;
  reducedMotion: boolean;
  /** Largest zoom the automatic fit may use; stage mode allows bigger cards. */
  maxFitZoom?: number;
  fitPadding?: number;
}

function Canvas({ tree, view, agents, nameOf, now, selectedId, onOpen, reducedMotion, maxFitZoom = 1, fitPadding = 0.06 }: Props) {
  // Cards size to their agent name; the key keeps the layout stable until a name actually changes.
  const widthKey = tree.nodes.map((n) => {
    const v = view.nodes.get(n.node_id);
    return v === undefined ? NODE_WIDTH : cardWidth(nameOf(v));
  }).join(",");
  const positions = useMemo(() => {
    const widths = widthKey.split(",").map(Number);
    return layoutTree(tree.nodes.map((n, i) => ({ id: n.node_id, parentId: n.parent_id, width: widths[i] ?? NODE_WIDTH })));
  }, [tree.nodes, widthKey]);
  const widthOf = (nodeId: string): number => {
    const i = tree.nodes.findIndex((n) => n.node_id === nodeId);
    return Number(widthKey.split(",")[i] ?? NODE_WIDTH);
  };
  const visibleCount = [...view.nodes.values()].filter((n) => n.visible).length;
  const { getNodes, getNodesBounds, setViewport } = useReactFlow();
  const box = useRef<HTMLDivElement>(null);

  // Fits the whole tree, centred across and pinned to the top, so a shallow tree never floats in
  // the middle of a tall canvas with empty space above the root.
  const fitTop = useCallback(
    (duration: number): void => {
      const el = box.current;
      const all = getNodes();
      if (el === null || all.length === 0 || el.clientWidth === 0 || el.clientHeight === 0) return;
      const b = getNodesBounds(all);
      const padX = el.clientWidth * fitPadding;
      const padY = Math.max(24, Math.min(el.clientHeight * fitPadding, 72));
      const zoom = Math.max(MIN_ZOOM, Math.min(maxFitZoom, (el.clientWidth - 2 * padX) / b.width, (el.clientHeight - 2 * padY) / b.height));
      void setViewport({ x: (el.clientWidth - b.width * zoom) / 2 - b.x * zoom, y: padY - b.y * zoom, zoom }, { duration });
    },
    [getNodes, getNodesBounds, setViewport, fitPadding, maxFitZoom],
  );
  const [hoverId, setHoverId] = useState<string | null>(null);
  const lit = useMemo(() => (hoverId === null ? null : relatedIds(tree.nodes, hoverId)), [hoverId, tree.nodes]);
  const largestHire = tree.nodes.reduce((m, n) => (n.parent_id !== null && BigInt(n.budget) > m ? BigInt(n.budget) : m), 0n);

  // Refit when the canvas itself changes size (window resize, or a header above it growing after data loads).
  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitTop(0));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [fitTop]);

  // The first fit is instant so the tree never swims into place; later fits ease as nodes appear.
  const fitted = useRef(false);
  useEffect(() => {
    const duration = reducedMotion || !fitted.current ? 0 : 400;
    fitted.current = true;
    const id = requestAnimationFrame(() => fitTop(duration));
    return () => cancelAnimationFrame(id);
  }, [visibleCount, widthKey, fitTop, reducedMotion]);

  const nodes: NodeCardNode[] = [];
  const edges: ValueEdgeType[] = [];
  for (const n of view.nodes.values()) {
    if (!n.visible) continue;
    const agent = n.node.agent_asset_id == null ? undefined : agents.get(n.node.agent_asset_id);
    nodes.push({
      id: n.node.node_id,
      type: "card",
      position: positions.get(n.node.node_id) ?? { x: 0, y: 0 },
      selected: n.node.node_id === selectedId,
      data: {
        view: n,
        name: nameOf(n),
        width: widthOf(n.node.node_id),
        reputation: agent?.reputation ?? null,
        testAgent: agent?.testAgent ?? false,
        asset: view.asset,
        now,
        onOpen,
        moment: reducedMotion || view.active === null || view.active.node_id !== n.node.node_id ? null : view.active.type === "node.refunded" ? "refund" : view.active.type === "node.drawn" ? "enter" : null,
        replacesName: n.replaces === null ? null : (() => {
          const r = view.nodes.get(n.replaces);
          return r === undefined ? null : nameOf(r);
        })(),
        hasChildren: tree.nodes.some((c) => c.parent_id === n.node.node_id),
        dimmed: lit !== null && !lit.has(n.node.node_id),
        onHover: setHoverId,
      },
      width: widthOf(n.node.node_id),
      height: NODE_HEIGHT,
      draggable: false,
      connectable: false,
      ariaLabel: `${nameOf(n)}, ${n.state}`,
    });
    if (n.node.parent_id !== null) {
      edges.push({
        id: `${n.node.parent_id}-${n.node.node_id}`,
        source: n.node.parent_id,
        target: n.node.node_id,
        type: "value" as const,
        data: {
          flow: n.flow,
          active: n.flow !== null && view.active?.event_id === n.flow.eventId,
          reducedMotion,
          refunded: n.state === "Refunded",
          weight: edgeWeight(BigInt(n.node.budget), largestHire),
          dimmed: lit !== null && !(lit.has(n.node.node_id) && lit.has(n.node.parent_id)),
        },
        focusable: false,
      });
    }
  }

  return (
    <div ref={box} className="h-full w-full">
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={(_, node) => onOpen(node.id)}
      onNodeMouseEnter={(_, node) => setHoverId(node.id)}
      onNodeMouseLeave={() => setHoverId(null)}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      preventScrolling={false}
      zoomOnScroll={false}
      panOnScroll={false}
      minZoom={MIN_ZOOM}
      maxZoom={1.5}
      proOptions={{ hideAttribution: true }}
      aria-label="Tree of escrow nodes"
    >
      <Controls showInteractive={false} position="bottom-right" />
      {nodes.length > 15 ? (
      <MiniMap
        position="bottom-left"
        pannable
        zoomable
        ariaLabel="Overview of the whole tree"
        className="!hidden !rounded-lg !border !border-line !bg-surface !shadow-card md:!block"
        maskColor="color-mix(in oklab, var(--bg) 70%, transparent)"
        nodeColor={(node) => STATE_COLOR[(node.data as { view?: NodeView }).view?.state ?? "Funded"]}
        nodeStrokeWidth={0}
        nodeBorderRadius={6}
      />
      ) : null}
    </ReactFlow>
    </div>
  );
}

export function TreeCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
