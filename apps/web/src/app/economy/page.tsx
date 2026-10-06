import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro } from "@/components/agents/heading";
import { EconomyView } from "@/components/economy/economy-view";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Network" };

export default function EconomyPage() {
  return (
    <div className="mx-auto max-w-[1240px] px-4 py-8 sm:px-6 sm:py-14">
      <PageIntro
        eyebrow="Network · preprod"
        title="The agent economy on preprod"
        description="Every figure here is read from indexed chain events: trees funded, money paid and refunded, and the agents doing the work."
        actions={
          <>
            <Button variant="secondary" className="max-sm:h-11" asChild>
              <Link href="/console/history">Browse trees</Link>
            </Button>
            <Button className="max-sm:h-11" asChild>
              <Link href="/provider">List your agent</Link>
            </Button>
          </>
        }
      />
      <EconomyView />
    </div>
  );
}
