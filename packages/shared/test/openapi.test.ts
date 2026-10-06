import SwaggerParser from "@apidevtools/swagger-parser";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const spec = (name: string) => fileURLToPath(new URL(`../openapi/${name}`, import.meta.url));

interface OpenApiDoc {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
}

describe("OpenAPI 3.1 documents", () => {
  it("agent.yaml is valid and lists every MIP-003 and Cascade endpoint", async () => {
    const doc = (await SwaggerParser.validate(spec("agent.yaml"))) as unknown as OpenApiDoc;
    expect(doc.openapi).toBe("3.1.0");
    const routes = Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
    expect(routes.sort()).toEqual(
      [
        "POST /start_job",
        "GET /status",
        "POST /provide_input",
        "GET /availability",
        "GET /input_schema",
        "GET /demo",
        "POST /cascade/quote",
        "POST /jobs",
        "GET /cascade/subtree",
        "GET /cascade/result",
        "POST /cascade/challenge",
        "GET /output_schema",
        "GET /.well-known/x402.json",
        "GET /.well-known/cascade.json",
        "GET /.well-known/agent-card.json",
      ].sort(),
    );
  });

  it("directory.yaml is valid and lists the PRD 17.2 routes", async () => {
    const doc = (await SwaggerParser.validate(spec("directory.yaml"))) as unknown as OpenApiDoc;
    expect(doc.openapi).toBe("3.1.0");
    const routes = Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
    expect(routes.sort()).toEqual(
      [
        "GET /v1/trees/{tree_id}",
        "GET /v1/trees/{tree_id}/receipt",
        "GET /v1/trees/{tree_id}/events",
        "GET /v1/agents",
        "GET /v1/agents/{asset_id}",
        "GET /v1/reputation/snapshot/latest",
        "POST /v1/quotes/request",
        "POST /v1/tx/preview",
        // W3 read views for apps/web (lead-approved addition).
        "GET /v1/ws",
        "GET /v1/trees",
        "GET /v1/trees/{tree_id}/nodes/{node_id}",
        "GET /v1/disputes",
        "GET /v1/ops/status",
        "GET /v1/agents/{asset_id}/work",
        // PRD 12.4 recompute (A17): the inputs each reputation snapshot was computed from.
        "GET /v1/reputation/snapshot/{root}/inputs",
      ].sort(),
    );
  });
});
