import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageIntro } from "@/components/agents/heading";
import { JobSteps } from "@/components/console/job-steps";
import { PlanReview } from "@/components/console/plan-review";

export const metadata: Metadata = { title: "Plan review" };

// Rendered once per id on first request, then served from the CDN; the data loads client-side.
export const dynamicParams = true;
export const revalidate = 86400;
export function generateStaticParams(): { id: string }[] {
  return [];
}

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const planId = decodeURIComponent(id);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(planId)) notFound();
  return (
    <div className="mx-auto max-w-[1240px] px-4 py-8 sm:px-6 sm:py-12">
      <PageIntro
        eyebrow="Buyer console"
        title="Review the plan"
        description="Check who does what, for how much, and how each result is checked. Funding locks the budget once, and every hire draws from it."
        actions={<JobSteps current={1} />}
      />
      <PlanReview planId={planId} />
    </div>
  );
}
