#!/usr/bin/env node
/**
 * cascade-mcp: stdio by default (for Claude Desktop, Claude Code and other MCP hosts), or
 * `--http [--port 4400] [--host 127.0.0.1]` for streamable HTTP.
 * Env: see endpointsFromEnv (client.ts) and chainFromEnv (chain.ts); CASCADE_MCP_TOKEN for HTTP.
 */
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chainFromEnv } from "./chain.js";
import { CascadeApi, endpointsFromEnv } from "./client.js";
import { startHttpServer } from "./http.js";
import { createCascadeMcpServer } from "./server.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { http: { type: "boolean", default: false }, port: { type: "string", default: "4400" }, host: { type: "string", default: "127.0.0.1" } },
    strict: true,
  });
  const endpoints = endpointsFromEnv();
  const api = new CascadeApi(endpoints);
  const chain = endpoints.signer === null ? null : chainFromEnv(endpoints.network);
  const deps = { api, chain };

  if (values.http) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be 1..65535");
    const token = process.env.CASCADE_MCP_TOKEN?.trim() || null;
    await startHttpServer(deps, { host: values.host, port, token });
    // stderr: stdout belongs to the protocol in stdio mode, and logs stay out of it in both modes.
    process.stderr.write(`cascade-mcp listening on http://${values.host}:${port}/mcp (${endpoints.network})\n`);
    return;
  }
  await createCascadeMcpServer(deps).connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`cascade-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
