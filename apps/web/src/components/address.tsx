"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";

/** `addr_test1xp043…40hqp8puxf`: start and end of a bech32 address, never wider than its container. */
export function middleEllipsis(value: string, head = 16, tail = 10): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function Address({ value, label, className }: { value: string; label?: string | null; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5", className)} title={value}>
      {label ? <span className="shrink-0 font-medium text-ink">{label}</span> : null}
      <code className="min-w-0 truncate font-mono text-[0.75rem] text-ink-3" data-testid="address">{middleEllipsis(value)}</code>
      <button type="button" onClick={() => void copy()} className="shrink-0 rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label={copied ? "Copied" : `Copy address ${value}`}>
        {copied ? <Check className="size-3.5 text-accepted" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  );
}
