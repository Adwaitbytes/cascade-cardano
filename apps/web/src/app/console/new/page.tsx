import type { Metadata } from "next";
import { PageIntro } from "@/components/agents/heading";
import { JobSteps } from "@/components/console/job-steps";
import { NewJobForm } from "@/components/console/new-job-form";

export const metadata: Metadata = { title: "New job" };

export default function NewJobPage() {
  return (
    <div className="mx-auto max-w-[1240px] px-4 py-8 sm:px-6 sm:py-12">
      <PageIntro eyebrow="Buyer console" title="New job" description="Describe the work and set the limits. You see a priced plan before anything is locked." actions={<JobSteps current={0} />} />
      <NewJobForm />
    </div>
  );
}
