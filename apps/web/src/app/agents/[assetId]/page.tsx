import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AgentProfileView } from "@/components/agents/agent-profile";

export const metadata: Metadata = { title: "Agent" };

// Rendered once per id on first request, then served from the CDN; the data loads client-side.
export const dynamicParams = true;
export const revalidate = 86400;
export function generateStaticParams(): { assetId: string }[] {
  return [];
}

export default async function AgentPage({ params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  if (!/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/.test(assetId)) notFound();
  return (
    <div className="mx-auto max-w-[1120px] px-4 py-8 sm:px-6 sm:py-14">
      <AgentProfileView assetId={assetId} />
    </div>
  );
}
