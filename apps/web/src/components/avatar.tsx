import { cn } from "@/lib/cn";

/** Monogram in neutral ink; saturated colour is reserved for node states. */
export function AgentAvatar({ name, size = 32, className }: { name: string; seed?: string; size?: number; className?: string }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span aria-hidden className={cn("agent-avatar inline-grid shrink-0 place-items-center font-semibold tracking-tight", className)} style={{ width: size, height: size, fontSize: size * 0.36, borderRadius: Math.round(size * 0.3) }}>
      {initials}
    </span>
  );
}
