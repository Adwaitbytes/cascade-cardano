/**
 * The local-network web app that Yaci acceptance tests drive in a browser (`pnpm local:up`, port 3100).
 *
 * The default is the IPv4 loopback, not `localhost`: `localhost` resolves to ::1 first, and
 * demo/web-local.ts serves a preprod-configured build on [::1]:3100, so a test opening
 * `localhost:3100` can land on a page that never shows its Yaci tree. 127.0.0.1:3100 is also one of
 * the indexer's default CORS origins, so the page's direct indexer reads are allowed.
 */
export const DEFAULT_LOCAL_WEB_URL = "http://127.0.0.1:3100";

export function localWebUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const raw = env.E2E_LOCAL_URL?.trim();
  if (raw === undefined || raw === "") return DEFAULT_LOCAL_WEB_URL;
  if (!/^https?:\/\/[^/\s]+/.test(raw)) throw new Error(`E2E_LOCAL_URL must be an http(s) URL, not ${raw}`);
  return raw.replace(/\/+$/, "");
}
