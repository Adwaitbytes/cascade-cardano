import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="relative mx-auto flex min-h-[70vh] max-w-2xl flex-col items-center justify-center px-4 py-24 text-center sm:px-6">
      <p aria-hidden className="font-display text-[clamp(6rem,22vw,11rem)] leading-none tracking-[-0.04em] text-line-strong select-none">404</p>
      <p className="mt-6 font-mono text-[0.6875rem] tracking-[0.22em] text-ink-3 uppercase">Page not found</p>
      <h1 className="mt-3 text-[clamp(1.75rem,4vw,2.5rem)] leading-tight">This page does not exist</h1>
      <p className="mt-4 max-w-md leading-relaxed text-ink-2">Tree and receipt links use a 56 character tree id. Check the link, or start from the console.</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Button size="lg" asChild>
          <Link href="/console/new">New job</Link>
        </Button>
        <Button size="lg" variant="secondary" asChild>
          <Link href="/console/history">Browse trees</Link>
        </Button>
      </div>
      <Link href="/" className="mt-4 inline-flex min-h-11 items-center px-3 text-sm text-ink-3 underline-offset-4 hover:text-ink hover:underline">Back to the home page</Link>
    </div>
  );
}
