import type { TreeListItem } from "@/lib/api/schemas";

/** The most trees the indexer returns in one read; history and network totals both read this many. */
export const TREE_READ_LIMIT = 100;
export const HISTORY_PAGE_SIZE = 20;

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/** Trees funded outside the Conductor have no plan goal on record; name them by id instead of a blank line. */
export function jobTitle(tree: Pick<TreeListItem, "goal" | "tree_id">): { text: string; recorded: boolean } {
  const goal = tree.goal.trim();
  return goal === "" ? { text: `Tree ${tree.tree_id.slice(0, 8)}, no goal on record`, recorded: false } : { text: goal, recorded: true };
}

export interface Page<T> {
  items: T[];
  page: number;
  pages: number;
  from: number;
  to: number;
}

/** One page of `items`, with `page` clamped into range so a shrinking list never shows an empty page. */
export function paginate<T>(items: readonly T[], page: number, size = HISTORY_PAGE_SIZE): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(0, Math.floor(page)), pages - 1);
  const start = current * size;
  const slice = items.slice(start, start + size);
  return { items: slice, page: current, pages, from: slice.length === 0 ? 0 : start + 1, to: start + slice.length };
}

export const BUYER_VKH = /^[0-9a-f]{56}$/;

/** A buyer filter is a 28-byte payment key hash, in hex; anything else is rejected before any request. */
export function parseBuyer(text: string): { vkh: string | null; error: string | null } {
  const t = text.trim().toLowerCase();
  if (t === "") return { vkh: null, error: null };
  return BUYER_VKH.test(t) ? { vkh: t, error: null } : { vkh: null, error: "Enter the buyer's payment key hash: 56 hex characters." };
}
