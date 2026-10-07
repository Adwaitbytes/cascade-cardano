/** Approximate advance of the hero's 12.5 px semibold UI face, per character. */
const CHAR_W = 6.7;
const CARD_PAD = 26;
export const CARD_MIN_W = 112;
export const CARD_MAX_W = 208;

/** A card wide enough for its name, clamped; a longer name is cut with an ellipsis. */
export function fitCard(name: string): { width: number; label: string } {
  const natural = Math.ceil(name.length * CHAR_W + CARD_PAD);
  const width = Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, natural));
  if (natural <= CARD_MAX_W) return { width, label: name };
  const fits = Math.floor((CARD_MAX_W - CARD_PAD) / CHAR_W) - 1;
  return { width, label: `${name.slice(0, fits).trimEnd()}…` };
}
