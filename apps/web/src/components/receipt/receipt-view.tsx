"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Fragment, useMemo } from "react";
import { Amount } from "@/components/amount";
import { LazyMount } from "@/components/lazy-mount";
import { MasumiHireDetail } from "@/components/masumi";
import { ErrorState, Skeleton } from "@/components/states";
import { TxLink } from "@/components/tx-link";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { useAgentLabels } from "@/hooks/use-tree";
import { getDataSource } from "@/lib/api";
import type { NodeDetail, Receipt, Tree } from "@/lib/api/schemas";
import { cn } from "@/lib/cn";
import { reconcile } from "@/lib/receipt/reconcile";
import type { FlowLink, FlowNode } from "./money-flow";

// d3-sankey loads with the receipt's money-flow panel only.
const MoneyFlow = dynamic(() => import("./money-flow").then((m) => m.MoneyFlow), { ssr: false, loading: () => <div className="h-[260px] animate-pulse rounded-xl bg-surface-2" /> });
import { VerifyReceipt } from "@/components/verify";
import { Invoice } from "./invoice";

const KIND_DOT: Record<Receipt["lines"][number]["kind"], string> = {
  deposit: "bg-funded",
  fee: "bg-accepted",
  masumi: "bg-accepted",
  refund: "bg-refunded",
  protocol_fee: "bg-submitted",
  bond_return: "bg-refunded",
  bond_slash: "bg-challenged",
  structural: "bg-line-strong",
};

const KIND_LABEL: Record<Receipt["lines"][number]["kind"], string> = {
  deposit: "Deposit",
  fee: "Payout",
  masumi: "Masumi hire",
  refund: "Refund",
  protocol_fee: "Protocol fee",
  bond_return: "Bond returned",
  bond_slash: "Bond slashed",
  structural: "Structural ADA",
};

export function ReceiptView({ treeId, initialReceipt, initialTree }: { treeId: string; initialReceipt?: Receipt | null; initialTree?: Tree | null }) {
  // Server-rendered data (when the page had it) paints the receipt before any client fetch.
  const receipt = useQuery({ queryKey: ["receipt", treeId], queryFn: async () => (await getDataSource()).getReceipt(treeId), initialData: initialReceipt ?? undefined });
  const tree = useQuery({ queryKey: ["tree", treeId], queryFn: async () => (await getDataSource()).getTree(treeId), initialData: initialTree ?? undefined });
  const agents = useAgentLabels(tree.data);
  const details = useQueries({
    queries: (tree.data?.nodes ?? []).map((n) => ({
      queryKey: ["node-detail", treeId, n.node_id],
      queryFn: async (): Promise<NodeDetail> => (await getDataSource()).getNodeDetail(treeId, n.node_id),
      staleTime: 60_000,
    })),
  });

  if (receipt.isLoading || tree.isLoading) return <ReceiptSkeleton />;
  if (receipt.error !== null || receipt.data === undefined) return <Panel><ErrorState error={receipt.error} what="receipt" action={<Button variant="secondary" size="sm" asChild><Link href={`/tree/${treeId}`}>Open the tree instead</Link></Button>} /></Panel>;
  if (tree.error !== null || tree.data === undefined) return <Panel><ErrorState error={tree.error} what="tree" /></Panel>;

  const r = receipt.data;
  const t = tree.data;
  const nameOf = (nodeId: string): string => {
    const n = t.nodes.find((x) => x.node_id === nodeId);
    const id = n?.agent_asset_id;
    return (id == null ? undefined : agents.get(id)?.name) ?? n?.agent_name ?? `Node ${nodeId.slice(0, 6)}`;
  };
  const detailOf = (nodeId: string): NodeDetail | undefined => details.find((d) => d.data?.node_id === nodeId)?.data;

  return <ReceiptBody receipt={r} tree={t} nameOf={nameOf} detailOf={detailOf} agentSeed={(id) => t.nodes.find((n) => n.node_id === id)?.agent_asset_id ?? id} />;
}

function ReceiptBody({ receipt, tree, nameOf, detailOf, agentSeed }: { receipt: Receipt; tree: Tree; nameOf: (id: string) => string; detailOf: (id: string) => NodeDetail | undefined; agentSeed: (id: string) => string }) {
  const rec = useMemo(() => reconcile(receipt), [receipt]);
  const asset = receipt.deposits.asset;
  const paidByNode = new Map<string, bigint>();
  for (const l of receipt.lines) if ((l.kind === "fee" || l.kind === "masumi") && l.value.asset === asset) paidByNode.set(l.node_id, (paidByNode.get(l.node_id) ?? 0n) + BigInt(l.value.amount));

  const flowNodes: FlowNode[] = [
    { id: "deposit", label: "Buyer deposit", tone: "deposit" },
    { id: "tree", label: "Cascade tree", tone: "tree" },
    ...[...paidByNode.keys()].map((id) => ({ id, label: nameOf(id), tone: "paid" as const })),
    { id: "refund", label: "Back to buyer", tone: "refund" },
    { id: "fees", label: "Protocol fees", tone: "fee" },
  ];
  const flowLinks: FlowLink[] = [
    { source: "deposit", target: "tree", amount: rec.deposits },
    ...[...paidByNode.entries()].map(([id, amount]) => ({ source: "tree", target: id, amount })),
    { source: "tree", target: "refund", amount: rec.refunds },
    { source: "tree", target: "fees", amount: rec.fees },
  ];

  return (
    <div className="grid grid-cols-1 gap-5">
      <Invoice receipt={receipt} tree={tree} rec={rec} nameOf={nameOf} paidByNode={paidByNode} detailOf={detailOf} />

      <VerifyReceipt receipt={receipt} tree={tree} rec={rec} details={tree.nodes.map((n) => detailOf(n.node_id))} />

      <Panel className="no-print">
        <PanelHeader title="Money flow" description="Every unit of the deposit, from the root to the agent that earned it or back to the buyer." />
        <div className="p-4 sm:p-5">
          <LazyMount rootMargin="1000px" placeholder={<div className="h-[260px] rounded-xl bg-surface-2" />}>
            <MoneyFlow nodes={flowNodes} links={flowLinks} asset={asset} />
          </LazyMount>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Ledger lines" description="Each line is one output of one transaction." />
        <div className="overflow-x-auto">
          {/* Under 640 px each line restacks into a card; one DOM keeps a single Masumi detail per hire. */}
          <table className="w-full text-sm max-sm:block sm:min-w-[560px]">
            <thead className="max-sm:hidden">
              <tr className="border-b border-line bg-surface-2/50 text-left font-mono text-[0.6875rem] tracking-[0.12em] text-ink-3 uppercase">
                <th scope="col" className="px-5 py-2.5 font-normal">Kind</th>
                <th scope="col" className="px-3 py-2.5 font-normal">Node</th>
                <th scope="col" className="px-3 py-2.5 font-normal">To</th>
                <th scope="col" className="px-3 py-2.5 text-right font-normal">Value</th>
                <th scope="col" className="px-5 py-2.5 font-normal">Transaction</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line max-sm:block">
              {receipt.lines.map((l, i) => (
                <Fragment key={`${l.tx_id}-${i}`}>
                  <tr className={cn("transition-colors hover:bg-surface-2/50 max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-3 max-sm:gap-y-1.5 max-sm:px-5 max-sm:py-3.5", l.kind === "masumi" && "[&>td]:pb-1 max-sm:pb-1")}>
                    <td className="px-5 py-2.5 max-sm:order-1 max-sm:p-0 max-sm:font-medium">
                      <span className="inline-flex items-center gap-2 whitespace-nowrap"><span aria-hidden className={cn("size-1.5 rounded-full", KIND_DOT[l.kind])} />{KIND_LABEL[l.kind]}</span>
                    </td>
                    <td className="px-3 py-2.5 font-medium max-sm:order-3 max-sm:p-0 max-sm:text-[0.8125rem] max-sm:font-normal max-sm:text-ink-2">{nameOf(l.node_id)}</td>
                    <td className="max-w-[14rem] truncate px-3 py-2.5 font-mono text-[0.75rem] text-ink-2 max-sm:order-5 max-sm:col-span-2 max-sm:max-w-none max-sm:p-0 max-sm:text-ink-3" title={l.to}>{l.to}</td>
                    <td className="px-3 py-2.5 text-right max-sm:order-2 max-sm:p-0"><Amount value={l.value.amount} asset={l.value.asset} className="font-medium" /></td>
                    <td className="px-5 py-2.5 max-sm:order-4 max-sm:justify-self-end max-sm:p-0"><TxLink txId={l.tx_id} /></td>
                  </tr>
                  {l.kind === "masumi" ? (
                    <tr className="border-t-0 max-sm:block max-sm:px-5 max-sm:pb-4">
                      <td className="max-sm:hidden" />
                      <td colSpan={4} className="px-3 pb-3 max-sm:block max-sm:p-0">
                        <MasumiHireDetail hire={{ drawTx: l.tx_id, lockTx: l.lock_tx ?? null, blockchainIdentifier: l.blockchain_identifier ?? null, outcome: l.outcome ?? (l.lock_tx == null ? "awaiting_lock" : "locked"), outcomeTx: l.outcome_tx ?? null }} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function ReceiptSkeleton() {
  return (
    <div className="grid gap-5" role="status" aria-label="Loading receipt">
      <Panel className="overflow-hidden">
        <div className="flex items-start justify-between gap-4 border-b border-line p-6 sm:px-8">
          <div className="grid gap-2.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>
          <Skeleton className="h-7 w-28 rounded-full" />
        </div>
        <div className="grid grid-cols-2 gap-5 border-b border-line p-6 sm:grid-cols-4 sm:px-8">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="grid gap-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
        <div className="grid gap-4 p-6 sm:px-8">
          {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-5 w-full" />)}
        </div>
      </Panel>
    </div>
  );
}
