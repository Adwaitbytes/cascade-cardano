import type { CascadeEvent } from "@cascade/shared/browser";
import { parseEvents } from "@/lib/api/events";
import { TreeSchema, type Tree } from "@/lib/api/schemas";
import snapshot from "./hero-snapshot.json";

export interface HeroTree {
  tree: Tree;
  events: CascadeEvent[];
  /** True when the picture comes from the bundled capture rather than a live indexer read. */
  fromSnapshot: boolean;
}

/** The bundled capture of a real preprod tree, read from the indexer and kept as returned. */
export function heroSnapshot(): HeroTree {
  const tree = TreeSchema.parse(snapshot.tree);
  const { events } = parseEvents(snapshot.events);
  return { tree, events, fromSnapshot: true };
}

export const SNAPSHOT_NODE_COUNT = snapshot.tree.nodes.length;

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
