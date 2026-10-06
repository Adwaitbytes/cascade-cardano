import type { Metadata } from "next";
import { OpsView } from "@/components/ops/ops-view";

export const metadata: Metadata = { title: "Operations" };

export default function OpsPage() {
  return (
    <div className="mx-auto max-w-[1240px] px-4 pt-8 pb-16 sm:px-6 sm:pt-12">
      <header className="mb-8 max-w-2xl">
        <p className="font-mono text-[0.6875rem] tracking-[0.22em] text-ink-3 uppercase">Status · preprod · read only</p>
        <h1 className="mt-3 text-[clamp(2rem,4.2vw,2.75rem)] leading-[1.05]">Operations</h1>
        <p className="mt-3 text-[1rem] leading-relaxed text-ink-2">The indexer, the x402 facilitator and the watchtower, as they run right now. Nothing on this page can move funds.</p>
      </header>
      <OpsView />
    </div>
  );
}
