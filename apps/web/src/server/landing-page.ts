import { INDEXER_URL } from "@/lib/env";
import { LandingDataSchema, type LandingData } from "@/lib/landing/data";
import { landingSnapshot } from "@/lib/landing/snapshot";
import { readDirect } from "./read-api";

/**
 * Landing data for server rendering: the indexer database in-process, else an external read API
 * when the site is configured with one, else the bundled snapshot. Never throws.
 */
export async function loadLandingData(): Promise<LandingData> {
  const direct = LandingDataSchema.safeParse(await readDirect("/v1/landing"));
  if (direct.success) return direct.data;
  if (/^https?:\/\//.test(INDEXER_URL)) {
    try {
      const res = await fetch(`${INDEXER_URL}/v1/landing`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000), next: { revalidate: 60 } });
      const remote = LandingDataSchema.safeParse(res.ok ? await res.json() : null);
      if (remote.success) return remote.data;
    } catch {
      // Unreachable or slow: the snapshot below is labelled as such on the page.
    }
  }
  return landingSnapshot();
}
