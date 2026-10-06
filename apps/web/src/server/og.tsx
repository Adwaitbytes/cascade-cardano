/**
 * Social cards for tree and receipt links (next/og). Satori renders a subset of CSS: flex layout,
 * literal colours (no CSS variables), inline SVG.
 */
import type { CascadeEvent } from "@cascade/shared/browser";
import { ImageResponse } from "next/og";
import { EventsPageSchema, ReceiptSchema, TreeSchema, type Receipt, type Tree } from "@/lib/api/schemas";
import { parseEvents } from "@/lib/api/events";
import { formatAmount } from "@/lib/assets";
import { replayTree, type DisplayState } from "@/lib/tree/replay";
import { tidyLayout } from "@/lib/tree/tidy";
import { getDataSource } from "@/lib/api";
import { FIXTURE_MODE } from "@/lib/env";
import { readDirect } from "./read-api";

export const OG_SIZE = { width: 1200, height: 630 };

const C = { bg: "#08111c", surface: "#0e1927", line: "#2c3e53", ink: "#e7eef6", ink2: "#a9b6c6", ink3: "#8494a8" };
const STATE: Record<DisplayState, string> = {
  Funded: "#8cb4ff",
  Working: "#f7c261",
  Submitted: "#c0a8ff",
  Accepted: "#6fdc98",
  Settled: "#6fdc98",
  Refunded: "#a7b2bf",
  Challenged: "#ff9c94",
  Disputed: "#ff9c94",
};

interface CardData {
  tree: Tree;
  events: CascadeEvent[];
  receipt: Receipt | null;
}

export async function loadCardData(treeId: string): Promise<CardData | null> {
  if (process.env.NODE_ENV !== "production" && FIXTURE_MODE) {
    try {
      const source = await getDataSource();
      const [tree, events] = await Promise.all([source.getTree(treeId), source.getTreeEvents(treeId)]);
      const receipt = await source.getReceipt(treeId).catch(() => null);
      return { tree, events: events.events, receipt };
    } catch {
      return null;
    }
  }
  const [rawTree, rawEvents, rawReceipt] = await Promise.all([readDirect(`/v1/trees/${treeId}`), readDirect(`/v1/trees/${treeId}/events?limit=1000`), readDirect(`/v1/trees/${treeId}/receipt`)]);
  const tree = TreeSchema.safeParse(rawTree);
  if (!tree.success) return null;
  const page = EventsPageSchema.safeParse(rawEvents);
  const receipt = ReceiptSchema.safeParse(rawReceipt);
  return { tree: tree.data, events: page.success ? parseEvents(page.data.events).events : [], receipt: receipt.success ? receipt.data : null };
}

function Silhouette({ data }: { data: CardData }) {
  const view = replayTree(data.tree, data.events);
  const { points, width, height } = tidyLayout(data.tree.nodes.map((n) => ({ id: n.node_id, parentId: n.parent_id })), 90, 110);
  const boxW = 72;
  const boxH = 28;
  const pad = 20;
  const vbW = Math.max(width, 200) + pad * 2;
  const vbH = height + boxH + pad * 2;
  return (
    <svg width="520" height="440" viewBox={`${-pad} ${-pad} ${vbW} ${vbH}`}>
      {data.tree.nodes.filter((n) => n.parent_id !== null).map((n) => {
        const a = points.get(n.parent_id ?? "") ?? { x: 0, y: 0 };
        const b = points.get(n.node_id) ?? { x: 0, y: 0 };
        const mid = (a.y + boxH + b.y) / 2;
        return <path key={`e${n.node_id}`} d={`M${a.x} ${a.y + boxH} V${mid} H${b.x} V${b.y}`} stroke={C.line} strokeWidth={3} fill="none" />;
      })}
      {data.tree.nodes.map((n) => {
        const p = points.get(n.node_id) ?? { x: 0, y: 0 };
        const state = view.nodes.get(n.node_id)?.state ?? "Funded";
        return (
          <g key={n.node_id}>
            <rect x={p.x - boxW / 2} y={p.y} width={boxW} height={boxH} rx={7} fill={C.surface} stroke={C.line} strokeWidth={2} />
            <rect x={p.x - boxW / 2} y={p.y + 6} width={5} height={boxH - 12} rx={2} fill={STATE[state]} />
          </g>
        );
      })}
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span style={{ fontSize: 22, color: C.ink3 }}>{label}</span>
      <span style={{ fontSize: 38, fontWeight: 700, color: C.ink, letterSpacing: -1 }}>{value}</span>
    </div>
  );
}

export function renderCard(kind: "tree" | "receipt", treeId: string, data: CardData | null): ImageResponse {
  const refunds = data?.events.filter((e) => e.type === "node.refunded").length ?? 0;
  const agents = data?.tree.nodes.length ?? 0;
  const title = kind === "receipt" ? "Job receipt" : "Escrow tree";
  const reconciled = data?.receipt?.balanced === true;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: C.bg, color: C.ink, padding: 64, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 560 }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 28, color: C.ink2 }}>Cascade on Cardano preprod</span>
            <span style={{ fontSize: 72, fontWeight: 700, letterSpacing: -3, marginTop: 12 }}>{title}</span>
            <span style={{ fontSize: 26, color: C.ink3, marginTop: 8, fontFamily: "monospace" }}>{`${treeId.slice(0, 10)}…${treeId.slice(-6)}`}</span>
          </div>
          {data === null ? (
            <span style={{ fontSize: 30, color: C.ink2 }}>Every node is its own escrow. Every state links to its transaction.</span>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 40 }}>
              <Stat label="Budget" value={formatAmount(data.tree.root_budget, data.tree.asset)} />
              <Stat label="Agents" value={String(agents)} />
              <Stat label={refunds === 1 ? "Refund recovered" : "Refunds recovered"} value={String(refunds)} />
              {data.receipt !== null ? <Stat label="Receipt" value={reconciled ? "Reconciled" : "Open"} /> : null}
            </div>
          )}
        </div>
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center" }}>
          {data === null ? null : <Silhouette data={data} />}
        </div>
      </div>
    ),
    OG_SIZE,
  );
}
