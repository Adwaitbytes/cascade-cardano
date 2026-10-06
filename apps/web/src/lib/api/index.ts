import { CONDUCTOR_URL, FIXTURE_MODE, INDEXER_URL, INDEXER_WS_URL } from "@/lib/env";
import { createHttpSource } from "./http";
import type { DataSource } from "./source";

let cached: Promise<DataSource> | null = null;

/**
 * The single place that chooses between the indexer and the dev-only sample data. The fixture
 * module is imported behind FIXTURE_MODE, a build-time `false` in production.
 */
export function getDataSource(): Promise<DataSource> {
  if (cached !== null) return cached;
  // The NODE_ENV test is repeated inline so the bundler drops the fixture import in production.
  cached =
    process.env.NODE_ENV !== "production" && FIXTURE_MODE
    ? import("@/lib/fixtures/source").then((m) => m.createFixtureSource())
    : Promise.resolve(createHttpSource({ indexerUrl: INDEXER_URL, conductorUrl: CONDUCTOR_URL, wsUrl: INDEXER_WS_URL }));
  return cached;
}

/** Tree shown by the landing page and the stage recording. */
export async function getDemoTreeId(): Promise<string | null> {
  if (process.env.NODE_ENV !== "production" && FIXTURE_MODE) return (await import("@/lib/fixtures/source")).FIXTURE_DEMO_TREE_ID;
  const configured = process.env.NEXT_PUBLIC_DEMO_TREE_ID;
  return configured !== undefined && /^[0-9a-f]{56}$/.test(configured) ? configured : null;
}

/** An agent to prefill the provider portal with, in sample-data mode only. */
export async function getSampleAgentId(): Promise<string | null> {
  if (process.env.NODE_ENV !== "production" && FIXTURE_MODE) return (await import("@/lib/fixtures/plan")).agentId("pricer");
  return null;
}

export { ApiError, ConductorOfflineError } from "./source";
export type { DataSource, LiveStatus } from "./source";
