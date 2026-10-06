import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

const control =
  "w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink shadow-[0_1px_0_rgb(13_24_38/0.03)] transition-[border-color,box-shadow] placeholder:text-ink-3 hover:border-ink-3 focus-visible:border-focus focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus/20 aria-invalid:border-challenged disabled:opacity-50";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(control, "h-10", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(control, "min-h-28 py-2.5 leading-relaxed", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(control, "h-10 appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 fill=%22none%22 stroke=%22%235f6b7c%22 stroke-width=%221.6%22><path d=%22M3 4.5 6 7.5 9 4.5%22/></svg>')] bg-[length:12px] bg-[right_0.75rem_center] bg-no-repeat pr-9", className)} {...props} />;
}

export function Field({ label, hint, error, htmlFor, children, className }: { label: ReactNode; hint?: ReactNode; error?: string | null; htmlFor: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-[0.8125rem] font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-[0.8125rem] text-challenged" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-[0.8125rem] text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
