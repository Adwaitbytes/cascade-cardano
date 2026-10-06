import { FlaskConical } from "lucide-react";
import { FIXTURE_MODE } from "@/lib/env";
import { cn } from "@/lib/cn";

/** Required whenever fixture data is on screen. Renders nothing against the real indexer. */
export function SampleDataLabel({ className }: { className?: string }) {
  if (!FIXTURE_MODE) return null;
  return (
    <span
      className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border border-dashed border-line-strong bg-surface-2 px-2.5 text-xs font-semibold whitespace-nowrap text-ink-2", className)}
      title="Development fixture. Not read from the chain."
      data-testid="sample-data-label"
    >
      <FlaskConical aria-hidden className="size-3.5" />
      <span className="max-[399px]:sr-only">Sample data</span>
    </span>
  );
}
