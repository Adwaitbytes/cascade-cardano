"use client";

import { useSearchParams } from "next/navigation";
import { ErrorState } from "@/components/states";
import { ExplorerSkeleton } from "./explorer-skeleton";
import { useTreeData } from "@/hooks/use-tree";
import { TreeExplorer } from "./tree-explorer";

/** Public read-only Tree Explorer by tree id (PRD 14.3). */
export function TreeViewPage({ treeId }: { treeId: string }) {
  const data = useTreeData(treeId);
  const params = useSearchParams();
  const stage = params.get("stage") === "1";
  // Stage view plays from funding unless ?replay=0 asks to start at the latest state.
  const autoplay = params.get("replay") === "1" || (stage && params.get("replay") !== "0");
  if (data.isLoading) return <ExplorerSkeleton />;
  if (data.error !== null || data.tree === undefined) return <div className="rounded-2xl border border-line bg-surface"><ErrorState error={data.error} what="tree" /></div>;
  return <TreeExplorer tree={data.tree} events={data.events} agents={data.agents} status={data.status} streamError={data.streamError} eventWarnings={data.eventWarnings} autoplay={autoplay} stage={stage} variant="public" />;
}
