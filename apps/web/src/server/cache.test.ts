// @vitest-environment node
import { describe, expect, it } from "vitest";
import { IMMUTABLE_READ, LIVE_READ, NO_STORE, cacheControlFor } from "./cache";

const TREE = "ab".repeat(28);

describe("cacheControlFor", () => {
  it("caches public reads for 5 s at the edge", () => {
    expect(cacheControlFor("GET", "/v1/trees", 200, {})).toBe(LIVE_READ);
    expect(cacheControlFor("GET", `/v1/trees/${TREE}/events`, 200, {})).toBe(LIVE_READ);
  });
  it("makes a balanced receipt immutable and leaves an open one live", () => {
    expect(cacheControlFor("GET", `/v1/trees/${TREE}/receipt`, 200, { balanced: true })).toBe(IMMUTABLE_READ);
    expect(cacheControlFor("GET", `/v1/trees/${TREE}/receipt`, 200, { balanced: false })).toBe(LIVE_READ);
  });
  it("never caches errors or writes", () => {
    expect(cacheControlFor("GET", "/v1/trees", 503, {})).toBe(NO_STORE);
    expect(cacheControlFor("POST", "/v1/tx/preview", 200, {})).toBe(NO_STORE);
  });
});
