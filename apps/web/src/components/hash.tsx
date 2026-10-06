"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { shortHash } from "@/lib/explorer";
import { cn } from "@/lib/cn";

export function Hash({ value, full = false, className, label }: { value: string; full?: boolean; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setFailed(true);
      setTimeout(() => setFailed(false), 1800);
    }
  };
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1 align-middle", className)}>
      <code className={cn("font-mono text-[0.78rem] text-ink-2", full ? "break-all" : "truncate")} title={value}>
        {full ? value : shortHash(value)}
      </code>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink"
        aria-label={copied ? "Copied" : failed ? "Copy failed" : `Copy ${label ?? "hash"}`}
      >
        {copied ? <Check className="size-3.5 text-accepted" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  );
}
