import { describeAmount, formatAmount } from "@/lib/assets";
import { cn } from "@/lib/cn";

/** Every amount on screen goes through here: exact decimals, ticker, base units on hover (PRD 14.7). */
export function Amount({ value, asset, className }: { value: string | bigint; asset: string; className?: string }) {
  return (
    <span className={cn("tabular whitespace-nowrap", className)} title={describeAmount(value, asset)}>
      {formatAmount(value, asset)}
    </span>
  );
}
