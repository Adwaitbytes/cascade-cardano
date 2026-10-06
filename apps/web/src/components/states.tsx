import { AlertTriangle, Inbox, PlugZap } from "lucide-react";
import type { ReactNode } from "react";
import { ApiError, ConductorOfflineError } from "@/lib/api/source";
import { cn } from "@/lib/cn";

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("block animate-pulse rounded-md bg-surface-2", className)} />;
}

export function LoadingBlock({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cn("grid gap-3.5 p-5 sm:p-6", className)} role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-xl" />
        <div className="grid flex-1 gap-2">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-3 w-1/5" />
        </div>
      </div>
      <Skeleton className="h-3.5 w-2/3" />
      <Skeleton className="h-3.5 w-1/2" />
    </div>
  );
}

/** Errors say what failed and what to do next. */
export function ErrorState({ error, what, action, className }: { error: unknown; what: string; action?: ReactNode; className?: string }) {
  let title = `Could not load ${what}`;
  let body = error instanceof Error ? error.message : "Unknown error.";
  let Icon = AlertTriangle;
  if (error instanceof ConductorOfflineError) {
    title = "Orchestrator offline";
    body = `${error.message} Planning, funding and every signed action need it. The Tree Explorer and receipts keep working from indexed chain data.`;
    Icon = PlugZap;
  } else if (error instanceof ApiError && error.status === 503) {
    title = "Chain data is unavailable";
    body = `${error.message}. The indexer database is not reachable from this site right now.`;
    Icon = PlugZap;
  } else if (error instanceof ApiError && error.notFound) {
    title = `No ${what} found`;
  } else if (error instanceof ApiError && (error.status === 404 || error.status === 501)) {
    title = `${what[0]?.toUpperCase() ?? ""}${what.slice(1)} is not served yet`;
  }
  return (
    <div className={cn("flex items-start gap-4 p-5 sm:p-6", className)} role="alert">
      <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-challenged-bg text-challenged">
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 pt-0.5">
        <p className="font-semibold tracking-tight">{title}</p>
        <p className="mt-1 max-w-prose break-words text-sm leading-relaxed text-ink-2">{body}</p>
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
    </div>
  );
}

export function EmptyState({ title, body, action, className }: { title: string; body: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start gap-4 p-5 sm:p-6", className)}>
      <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-surface-2 text-ink-3">
        <Inbox className="size-5" />
      </span>
      <div className="min-w-0 pt-0.5">
        <p className="font-semibold tracking-tight">{title}</p>
        <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-2">{body}</p>
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
    </div>
  );
}
