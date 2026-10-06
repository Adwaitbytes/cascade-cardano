import { describe, expect, it } from "vitest";
import { DEFAULT_CORS_ORIGINS } from "@cascade/indexer";
import { DEFAULT_LOCAL_WEB_URL, localWebUrl } from "./local-web.js";

describe("local explorer URL for Yaci acceptance tests", () => {
  it("defaults to the IPv4 loopback, never `localhost`", () => {
    // `localhost` resolves to ::1 first, where demo/web-local.ts serves a preprod-configured build on
    // the same port; A16 then opened a page that could never show its Yaci tree.
    expect(new URL(DEFAULT_LOCAL_WEB_URL).hostname).toBe("127.0.0.1");
  });

  it("defaults to an origin the indexer accepts for browser reads", () => {
    expect(DEFAULT_CORS_ORIGINS).toContain(new URL(DEFAULT_LOCAL_WEB_URL).origin);
  });

  it("uses E2E_LOCAL_URL when set, without a trailing slash", () => {
    expect(localWebUrl({ E2E_LOCAL_URL: "http://127.0.0.1:3200/" })).toBe("http://127.0.0.1:3200");
    expect(localWebUrl({ E2E_LOCAL_URL: "  " })).toBe(DEFAULT_LOCAL_WEB_URL);
    expect(localWebUrl({})).toBe(DEFAULT_LOCAL_WEB_URL);
  });

  it("rejects a value that is not an http(s) URL", () => {
    expect(() => localWebUrl({ E2E_LOCAL_URL: "127.0.0.1:3100" })).toThrow(/E2E_LOCAL_URL/);
  });
});
