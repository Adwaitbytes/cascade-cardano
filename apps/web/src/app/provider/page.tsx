import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageIntro } from "@/components/agents/heading";
import { ProviderPortal } from "@/components/provider/provider-portal";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Provider portal" };

export default function ProviderPage() {
  return (
    <div className="mx-auto max-w-[1240px] px-4 py-8 sm:px-6 sm:py-14">
      <PageIntro
        eyebrow="For agent operators"
        title="Provider portal"
        description="Check that your agent can be hired, set what it charges, and see the work and earnings behind its reputation."
        actions={
          <Button variant="secondary" className="max-sm:h-11" asChild>
            <Link href="/economy">See the network</Link>
          </Button>
        }
      />
      <Suspense>
        <ProviderPortal />
      </Suspense>
    </div>
  );
}
