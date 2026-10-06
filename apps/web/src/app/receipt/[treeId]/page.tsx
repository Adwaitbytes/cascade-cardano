import { Network } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PrintButton } from "@/components/print-button";
import { Button } from "@/components/ui/button";
import { ReceiptView } from "@/components/receipt/receipt-view";
import { ReceiptSchema, TreeSchema } from "@/lib/api/schemas";
import { readDirect } from "@/server/read-api";

export async function generateMetadata({ params }: { params: Promise<{ treeId: string }> }): Promise<Metadata> {
  const { treeId } = await params;
  const short = treeId.slice(0, 8);
  return {
    title: `Receipt ${short}`,
    description: `Receipt for escrow tree ${short}: what every agent was paid, reconciled to the base unit on Cardano preprod.`,
  };
}

// Rendered once per id on first request, then served from the CDN; the data loads client-side.
export const dynamicParams = true;
export const revalidate = 86400;
export function generateStaticParams(): { treeId: string }[] {
  return [];
}

export default async function ReceiptPage({ params }: { params: Promise<{ treeId: string }> }) {
  const { treeId } = await params;
  if (!/^[0-9a-f]{56}$/.test(treeId)) notFound();
  const [rawReceipt, rawTree] = await Promise.all([readDirect(`/v1/trees/${treeId}/receipt`), readDirect(`/v1/trees/${treeId}`)]);
  const initialReceipt = ReceiptSchema.safeParse(rawReceipt);
  const initialTree = TreeSchema.safeParse(rawTree);
  return (
    <div className="mx-auto max-w-[1080px] px-4 pt-8 pb-16 sm:px-6 sm:pt-12">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-5">
        <div className="max-w-2xl">
          <p className="font-mono text-[0.6875rem] tracking-[0.22em] text-ink-3 uppercase">Receipt · signed by the indexer</p>
          <h1 className="mt-3 text-[clamp(2rem,4.2vw,2.75rem)] leading-[1.05]">Job receipt</h1>
          <p className="mt-3 text-[1rem] leading-relaxed text-ink-2">What every agent was paid for this tree, reconciled to the base unit against preprod.</p>
        </div>
        <div className="no-print flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" className="max-sm:h-11" asChild>
            <Link href={`/tree/${treeId}`}><Network /> Open the tree</Link>
          </Button>
          <PrintButton />
        </div>
      </header>
      <ReceiptView treeId={treeId} initialReceipt={initialReceipt.success ? initialReceipt.data : null} initialTree={initialTree.success ? initialTree.data : null} />
    </div>
  );
}
