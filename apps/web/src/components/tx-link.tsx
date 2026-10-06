import { ArrowUpRight } from "lucide-react";
import { shortHash, txUrl, type TxTab } from "@/lib/explorer";
import { cn } from "@/lib/cn";

export function TxLink({ txId, label, className, tab }: { txId: string; label?: string; className?: string; tab?: TxTab }) {
  return (
    <a
      href={txUrl(txId, tab)}
      target="_blank"
      rel="noreferrer noopener"
      className={cn("inline-flex items-center gap-0.5 font-mono text-[0.78rem] text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink hover:decoration-ink", className)}
      title={`Open ${txId} on Cardanoscan preprod`}
    >
      {label ?? shortHash(txId)}
      <ArrowUpRight aria-hidden className="size-3" />
    </a>
  );
}
