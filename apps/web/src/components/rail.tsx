import { ArrowRightLeft, Gauge, Landmark, Network } from "lucide-react";
import type { ApiNodeKind } from "@/lib/api/schemas";
import { cn } from "@/lib/cn";

export type RailName = "native" | "masumi" | "metered" | "address";

const RAILS: Record<RailName, { label: string; Icon: typeof Network; title: string }> = {
  native: { label: "Cascade", Icon: Network, title: "Native Cascade escrow child" },
  masumi: { label: "Masumi", Icon: Landmark, title: "Masumi vested_pay escrow" },
  metered: { label: "Metered", Icon: Gauge, title: "Voucher channel, paid per call" },
  address: { label: "Direct", Icon: ArrowRightLeft, title: "Plain address payment" },
};

export const railOfKind = (kind: ApiNodeKind): RailName => (kind === "Native" ? "native" : kind === "MasumiReceipt" ? "masumi" : "metered");

export function Rail({ rail, className, iconOnly = false }: { rail: RailName; className?: string; iconOnly?: boolean }) {
  const { label, Icon, title } = RAILS[rail];
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs text-ink-2", className)} title={title}>
      <Icon aria-hidden className="size-3.5" />
      <span className={iconOnly ? "sr-only" : undefined}>{label}</span>
    </span>
  );
}
