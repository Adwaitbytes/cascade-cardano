"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

type CopyState = "idle" | "copied" | "failed";

/** The terminal block under the hero: one real CLI command, copyable. */
export function CopyCommand({ title, command }: { title: string; command: string }) {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1800);
    return () => clearTimeout(t);
  }, [state]);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="relative isolate mx-auto w-full max-w-[780px] rounded-[22px]">
      <span aria-hidden className="beam-glow" />
      <div className="relative rounded-[22px] bg-[#0b0b0c] p-2 text-[#f2f2f0] shadow-[0_0_0_1px_rgb(255_255_255/0.06)_inset,0_30px_60px_-24px_rgb(11_11_12/0.55)]">
        <span aria-hidden className="beam-ring" />
        <p className="px-3 pt-2 pb-2.5 text-center text-[0.8125rem] font-medium tracking-tight">{title}</p>
        <div className="flex items-center gap-3 rounded-[15px] bg-[#1a1b1d] py-2 pr-2 pl-4">
          <code className="min-w-0 flex-1 font-mono text-[0.78rem] leading-relaxed break-words text-[#c9ccd0] sm:truncate">
            <span aria-hidden className="mr-2 text-[#6f7378]">$</span>
            {command}
          </code>
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex h-11 shrink-0 items-center sm:h-9 gap-1.5 rounded-[10px] bg-[#f2f2f0] px-3.5 font-mono text-xs text-[#0b0b0c] transition-[background-color,transform] hover:bg-white active:translate-y-px"
            aria-label={state === "copied" ? "Copied" : "Copy command"}
          >
            {state === "copied" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {state === "copied" ? "copied" : state === "failed" ? "select it" : "copy"}
          </button>
        </div>
      </div>
      <span role="status" className="sr-only">{state === "copied" ? "Command copied" : state === "failed" ? "Copy failed. Select the command to copy it." : ""}</span>
    </div>
  );
}
