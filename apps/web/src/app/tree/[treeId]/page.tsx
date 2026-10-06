import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { TreeViewPage } from "@/components/explorer/tree-view-page";

export async function generateMetadata({ params }: { params: Promise<{ treeId: string }> }): Promise<Metadata> {
  const { treeId } = await params;
  const short = treeId.slice(0, 8);
  return {
    title: `Tree ${short}`,
    description: `Escrow tree ${short} on Cardano preprod: every hire, refund and payout, each linked to its transaction.`,
  };
}

// Rendered once per tree id on first request, then served from the CDN; the data loads client-side.
export const dynamicParams = true;
export const revalidate = 86400;
export function generateStaticParams(): { treeId: string }[] {
  return [];
}

export default async function TreePage({ params }: { params: Promise<{ treeId: string }> }) {
  const { treeId } = await params;
  if (!/^[0-9a-f]{56}$/.test(treeId)) notFound();
  return (
    <div className="mx-auto max-w-[1320px] px-4 pt-8 pb-16 sm:px-6 sm:pt-12">
      <header className="mb-8 max-w-3xl">
        <p className="font-mono text-[0.6875rem] tracking-[0.22em] text-ink-3 uppercase">Public · read only · Cardano preprod</p>
        <h1 className="mt-3 text-[clamp(2rem,4.2vw,2.75rem)] leading-[1.05]">Live Tree Explorer</h1>
        <p className="mt-3 text-[1rem] leading-relaxed text-ink-2">Every node is its own escrow on Cardano preprod. Select a node for its spec, hashes and transactions, or replay the tree from funding to close.</p>
      </header>
      <Suspense>
        <TreeViewPage treeId={treeId} />
      </Suspense>
    </div>
  );
}
