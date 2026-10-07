"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Amount } from "@/components/amount";
import { TREE_STATE } from "@/components/console/history";
import { getDataSource } from "@/lib/api";
import type { TreeListItem } from "@/lib/api/schemas";
import { cn } from "@/lib/cn";
import { jobTitle, plural } from "@/lib/console/history";
import { formatUtc } from "@/lib/time";

const SHOWN = 6;

const loadTrees = async (): Promise<TreeListItem[]> => (await getDataSource()).listTrees(null, SHOWN);

/** The newest trees on the current deployment, read from the indexer. Nothing is shown that it did not return. */
export function RecentTrees() {
  const trees = useQuery({ queryKey: ["landing-trees"], queryFn: loadTrees, refetchInterval: 60_000, staleTime: 30_000 });
  if (trees.isPending) {
    return (
      <ul className="grid gap-2" role="status" aria-label="Loading the newest trees">
        {[0, 1, 2].map((i) => <li key={i} className="h-[4.5rem] animate-pulse rounded-2xl bg-surface-2" />)}
      </ul>
    );
  }
  if (trees.isError) {
    return <p className="rounded-2xl border border-line px-5 py-6 text-[0.9375rem] text-ink-2">The preprod indexer did not answer, so the newest trees cannot be listed right now.</p>;
  }
  if (trees.data.length === 0) {
    return <p className="rounded-2xl border border-line px-5 py-6 text-[0.9375rem] text-ink-2">No tree has been funded on the current deployment yet.</p>;
  }
  return (
    <ul className="grid gap-2" data-testid="recent-trees">
      {trees.data.map((t) => {
        const title = jobTitle(t);
        const state = TREE_STATE[t.state];
        return (
          <li key={t.tree_id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-2xl border border-line bg-surface px-4 py-3.5 sm:grid-cols-[6.5rem_minmax(0,1fr)_auto_auto] sm:px-5">
            <span className={cn("inline-flex h-6 w-fit items-center gap-1.5 rounded-md px-2 text-xs font-semibold", state.text, state.bg)}>
              <span aria-hidden className={cn("size-1.5 rounded-full", state.dot)} />
              {state.label}
            </span>
            <span className="col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:row-start-auto">
              <Link href={`/tree/${t.tree_id}`} className={cn("block truncate text-[0.9375rem] font-medium tracking-tight hover:underline hover:underline-offset-4", !title.recorded && "text-ink-2")} title={title.text}>
                {title.text.split("\n")[0]}
              </Link>
              <span className="mt-0.5 block font-mono text-[0.75rem] text-ink-3">
                {formatUtc(t.created_at)} · {plural(t.node_count, "node")} · {t.tree_id.slice(0, 8)}
              </span>
            </span>
            <span className="hidden text-right text-[0.8125rem] sm:block">
              <Amount value={t.paid} asset={t.asset} className="font-medium" />
              <span className="block text-ink-3">paid of <Amount value={t.root_budget} asset={t.asset} /></span>
            </span>
            <span className="row-start-1 flex justify-end gap-3 text-[0.8125rem] sm:row-start-auto">
              <Link href={`/tree/${t.tree_id}`} className="font-medium underline decoration-line-strong underline-offset-4 hover:decoration-ink">Tree</Link>
              {t.state === "open" ? null : <Link href={`/receipt/${t.tree_id}`} className="font-medium underline decoration-line-strong underline-offset-4 hover:decoration-ink">Receipt</Link>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
