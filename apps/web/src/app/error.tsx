"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-2xl flex-col items-center justify-center px-4 py-24 text-center sm:px-6" role="alert">
      <span aria-hidden className="grid size-14 place-items-center rounded-2xl bg-challenged-bg text-challenged shadow-card">
        <AlertTriangle className="size-6" />
      </span>
      <p className="mt-6 font-mono text-[0.6875rem] tracking-[0.22em] text-ink-3 uppercase">Something broke</p>
      <h1 className="mt-3 text-[clamp(1.75rem,4vw,2.5rem)] leading-tight">This page failed to render</h1>
      <p className="mt-4 max-w-md break-words leading-relaxed text-ink-2">{error.message}</p>
      {error.digest ? <p className="mt-3 rounded-lg border border-line bg-surface px-2.5 py-1 font-mono text-xs text-ink-3">Reference {error.digest}</p> : null}
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Button size="lg" onClick={reset}>
          <RotateCcw /> Try again
        </Button>
        <Button size="lg" variant="secondary" asChild>
          <Link href="/">Home</Link>
        </Button>
      </div>
    </div>
  );
}
