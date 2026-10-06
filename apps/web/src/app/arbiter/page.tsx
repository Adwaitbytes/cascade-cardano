import type { Metadata } from "next";
import { ArbiterConsole } from "@/components/arbiter/arbiter-console";

export const metadata: Metadata = { title: "Arbiter console" };

export default function ArbiterPage() {
  return (
    <div className="mx-auto max-w-[1240px] px-4 pt-8 pb-16 sm:px-6 sm:pt-12">
      <header className="mb-8 max-w-2xl">
        <p className="font-mono text-[0.6875rem] tracking-[0.22em] text-ink-3 uppercase">Disputes · arbiter key required</p>
        <h1 className="mt-3 text-[clamp(2rem,4.2vw,2.75rem)] leading-[1.05]">Arbiter console</h1>
        <p className="mt-3 text-[1rem] leading-relaxed text-ink-2">Rule on native nodes that verification could not settle. Read the evidence, set the split, and sign it with your arbiter key.</p>
      </header>
      <ArbiterConsole />
    </div>
  );
}
