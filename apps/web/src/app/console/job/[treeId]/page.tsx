import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageIntro } from "@/components/agents/heading";
import { JobConsole } from "@/components/console/job-console";
import { JobSteps } from "@/components/console/job-steps";

export const metadata: Metadata = { title: "Live job" };

// Rendered once per id on first request, then served from the CDN; the data loads client-side.
export const dynamicParams = true;
export const revalidate = 86400;
export function generateStaticParams(): { treeId: string }[] {
  return [];
}

export default async function JobPage({ params }: { params: Promise<{ treeId: string }> }) {
  const { treeId } = await params;
  if (!/^[0-9a-f]{56}$/.test(treeId)) notFound();
  return (
    <div className="mx-auto max-w-[1320px] px-4 py-8 sm:px-6 sm:py-12">
      <PageIntro
        eyebrow="Buyer console"
        title="Live job"
        description="The tree updates as the indexer sees each transaction. Freeze stops new hires across the whole tree."
        actions={<JobSteps current={2} />}
      />
      <JobConsole treeId={treeId} />
    </div>
  );
}
