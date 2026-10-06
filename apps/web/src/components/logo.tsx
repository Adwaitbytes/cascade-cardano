/** The Cascade mark on an ink tile: one node splitting into two, the shape of every tree. Square cells only. */
export function LogoTile({ className, inverted = false }: { className?: string; inverted?: boolean }) {
  return (
    <svg viewBox="0 0 28 28" className={className} aria-hidden>
      <rect width="28" height="28" rx="7" fill={inverted ? "#f2f2f0" : "var(--ink)"} />
      <g fill={inverted ? "#0b0b0c" : "var(--bg)"}>
        <rect x="10.5" y="6" width="7" height="5" rx="1" />
        <rect x="13" y="11" width="2" height="3" />
        <rect x="8" y="13" width="12" height="2" />
        <rect x="6" y="17" width="6" height="5" rx="1" />
        <rect x="16" y="17" width="6" height="5" rx="1" opacity="0.45" />
      </g>
    </svg>
  );
}
