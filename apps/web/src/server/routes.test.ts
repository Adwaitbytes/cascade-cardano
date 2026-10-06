// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isAllowedRoute } from "./routes";

describe("isAllowedRoute", () => {
  it("serves every read route and the tx preview", () => {
    expect(isAllowedRoute("GET", "/v1/trees/abc")).toBe(true);
    expect(isAllowedRoute("GET", "/v1/ops/status")).toBe(true);
    expect(isAllowedRoute("POST", "/v1/tx/preview")).toBe(true);
  });
  it("refuses admin writes, quote fan-out and traversal", () => {
    expect(isAllowedRoute("POST", "/v1/admin/agents")).toBe(false);
    expect(isAllowedRoute("POST", "/v1/admin/plans")).toBe(false);
    expect(isAllowedRoute("POST", "/v1/quotes/request")).toBe(false);
    expect(isAllowedRoute("DELETE", "/v1/trees/abc")).toBe(false);
    expect(isAllowedRoute("GET", "/v1/../admin")).toBe(false);
  });
});
