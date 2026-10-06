import type { AgentProfile } from "@/lib/api/schemas";
import { RailSchema } from "@/lib/api/schemas";

type Rail = AgentProfile["rails"][number];

/**
 * Categories and rails for an agent. The directory row is empty for agents whose registry entry
 * predates those columns; their own `/.well-known/cascade.json`, which the directory stores as
 * `capabilities`, still lists them.
 */
export function listingOf(profile: Pick<AgentProfile, "categories" | "rails" | "capabilities">): { categories: string[]; rails: Rail[] } {
  const categories = profile.categories.length > 0 ? profile.categories : [...new Set(profile.capabilities.categories)];
  const rails = profile.rails.length > 0 ? profile.rails : [...new Set(profile.capabilities.rails.flatMap((r) => (RailSchema.safeParse(r).success ? [r as Rail] : [])))];
  return { categories, rails };
}
