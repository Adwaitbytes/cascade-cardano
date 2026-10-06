import { TreeCanvasSkeleton } from "./tree-canvas-skeleton";

/** Same blocks as the loaded explorer, so nothing jumps when data arrives. */
export function ExplorerSkeleton() {
  return (
    <section className="overflow-hidden rounded-[22px] border border-line bg-surface shadow-card" role="status" aria-label="Loading the tree">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
        <span className="h-4 w-40 animate-pulse rounded bg-surface-2" />
        <span className="ml-auto h-7 w-44 animate-pulse rounded-full bg-surface-2" />
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-b border-line px-4 py-4 sm:grid-cols-4 sm:px-5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="grid gap-2">
            <span className="h-3 w-20 animate-pulse rounded bg-surface-2" />
            <span className="h-6 w-28 animate-pulse rounded bg-surface-2" />
          </div>
        ))}
      </div>
      <div className="hairline-grid h-[min(620px,70vh)] min-h-[420px]">
        <TreeCanvasSkeleton />
      </div>
      <div className="flex items-center gap-2 border-t border-line px-4 py-3 sm:px-5">
        {[0, 1, 2].map((i) => <span key={i} className="size-8 animate-pulse rounded-full bg-surface-2" />)}
        <span className="ml-2 h-4 w-56 animate-pulse rounded bg-surface-2" />
      </div>
    </section>
  );
}
