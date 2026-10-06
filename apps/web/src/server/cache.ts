/**
 * CDN caching for the public read mount. Chain data changes at most once a block (about 20 s on
 * preprod), so a 5 s shared cache with background revalidation takes nearly every read off the
 * database. A balanced receipt belongs to a closed tree and never changes again.
 */
export const LIVE_READ = "public, max-age=0, s-maxage=5, stale-while-revalidate=60";
export const IMMUTABLE_READ = "public, max-age=300, s-maxage=31536000, immutable";
export const NO_STORE = "no-store";

export function cacheControlFor(method: string, path: string, status: number, body: unknown): string {
  if (method !== "GET" || status !== 200) return NO_STORE;
  if (/^\/v1\/trees\/[0-9a-f]{56}\/receipt$/.test(path)) {
    const balanced = typeof body === "object" && body !== null && (body as { balanced?: unknown }).balanced === true;
    return balanced ? IMMUTABLE_READ : LIVE_READ;
  }
  return LIVE_READ;
}
