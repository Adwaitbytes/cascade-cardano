import { describe, expect, it } from "vitest";
import { listingOf } from "./listing";

const capabilities = { version: "1" as const, roles: ["orchestrator" as const], categories: ["orchestration"], max_depth: 0, rails: ["native", "carrier-pigeon"], bond_lovelace: "0", registry_asset_id: "ab".repeat(30) };

describe("listingOf", () => {
  it("falls back to the agent's capabilities when the directory row is empty", () => {
    expect(listingOf({ categories: [], rails: [], capabilities })).toEqual({ categories: ["orchestration"], rails: ["native"] });
  });
  it("prefers the directory row when it has values", () => {
    expect(listingOf({ categories: ["research"], rails: ["masumi"], capabilities })).toEqual({ categories: ["research"], rails: ["masumi"] });
  });
});
