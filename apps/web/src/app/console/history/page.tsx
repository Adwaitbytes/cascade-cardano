import type { Metadata } from "next";
import { Plus } from "lucide-react";
import Link from "next/link";
import { PageIntro } from "@/components/agents/heading";
import { History } from "@/components/console/history";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Jobs" };

export default function HistoryPage() {
  return (
    <div className="mx-auto max-w-[1240px] px-4 py-8 sm:px-6 sm:py-12">
      <PageIntro
        eyebrow="Buyer console"
        title="Jobs"
        description="Every funded tree on preprod, what it cost and what came back. Filter by buyer key hash to see one buyer's jobs."
        actions={<Button className="pointer-coarse:h-11" asChild><Link href="/console/new"><Plus /> New job</Link></Button>}
      />
      <History />
    </div>
  );
}
