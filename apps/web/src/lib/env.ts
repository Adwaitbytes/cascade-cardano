/**
 * Runtime configuration. `NEXT_PUBLIC_*` values are inlined at build time, so every read is a
 * literal `process.env.X` access.
 */

/**
 * Sample-data mode. The `NODE_ENV` check is a build-time constant, so production bundles drop the
 * fixture adapter entirely and can never fall back to it.
 */
export const FIXTURE_MODE: boolean =
  process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_CASCADE_FIXTURES === "1";

/**
 * Indexer REST base. Defaults to this app's own `/api` mount (`/api/v1/...`), which reads the
 * indexer's Postgres server-side, so the public site never needs the operator machine.
 */
export const INDEXER_URL: string = normaliseBase(process.env.NEXT_PUBLIC_INDEXER_URL) ?? "/api";

/** Conductor (orchestrator) API for plans and every write action. Optional: without it the console shows the orchestrator as offline. */
export const CONDUCTOR_URL: string | null = conductorBase(process.env.NEXT_PUBLIC_CONDUCTOR_URL);

/** Optional live stream. Without it, or while it is down, the explorer polls every 3 s. */
export const INDEXER_WS_URL: string | null = normaliseBase(process.env.NEXT_PUBLIC_INDEXER_WS_URL);

/** Cascade runs on preprod for acceptance; every explorer link targets preprod. */
export const NETWORK = "cardano:preprod" as const;

/** Accepts the Conductor URL with or without its trailing `/v1`; routes add `/v1/...` themselves. */
export function conductorBase(raw: string | undefined): string | null {
  const base = normaliseBase(raw);
  return base === null ? null : base.replace(/\/v1$/, "");
}

function normaliseBase(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  return raw.trim().replace(/\/+$/, "");
}
