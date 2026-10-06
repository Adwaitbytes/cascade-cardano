/** Placeholder with the tree's shape while React Flow loads: a root and one row of children. */
export function TreeCanvasSkeleton() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-10 p-6" role="status" aria-label="Loading the tree view">
      <span className="h-[124px] w-[224px] animate-pulse rounded-xl bg-surface-2" />
      <div className="flex gap-5">
        {[0, 1, 2, 3].map((i) => <span key={i} className="hidden h-[124px] w-[224px] animate-pulse rounded-xl bg-surface-2 sm:block" />)}
      </div>
    </div>
  );
}
