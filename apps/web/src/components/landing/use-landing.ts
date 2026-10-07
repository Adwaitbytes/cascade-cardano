"use client";

import { useQuery } from "@tanstack/react-query";
import { getDataSource } from "@/lib/api";
import type { LandingData } from "@/lib/landing/data";

const loadLanding = async (): Promise<LandingData> => (await getDataSource()).getLanding();

/**
 * The landing data, server-rendered when the render could read the indexer, else read in the
 * browser. A prerender without database access therefore never pins an outage notice on the page.
 */
export function useLanding(initial?: LandingData) {
  return useQuery({ queryKey: ["landing"], queryFn: loadLanding, initialData: initial, refetchInterval: 60_000, staleTime: 30_000 });
}
