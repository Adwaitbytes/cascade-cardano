/**
 * Streamable HTTP transport, stateless: each POST /mcp gets a fresh server and transport, so no
 * session state is kept between calls. Binds to loopback by default. A bearer token
 * (CASCADE_MCP_TOKEN) is required whenever the server can sign with an agent key or listens on a
 * non-loopback host.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ConfigError } from "./client.js";
import { createCascadeMcpServer, type ServerDeps } from "./server.js";

export interface HttpServerOptions {
  host: string;
  port: number;
  token: string | null;
}

const MAX_BODY = 256 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function tokenOk(req: IncomingMessage, token: string): boolean {
  const got = Buffer.from(req.headers.authorization ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export function startHttpServer(deps: ServerDeps, opts: HttpServerOptions): Promise<Server> {
  if (opts.token === null && (deps.api.canSign || !LOOPBACK.has(opts.host))) {
    throw new ConfigError("CASCADE_MCP_TOKEN is required when an agent key is configured or the host is not loopback");
  }
  const http = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path === "/health" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (path !== "/mcp") return reply(res, 404, "not found");
      if (opts.token !== null && !tokenOk(req, opts.token)) return reply(res, 401, "unauthorized");
      if (req.method !== "POST") return reply(res, 405, "stateless server: use POST");
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        return reply(res, 400, "invalid JSON body");
      }
      const server = createCascadeMcpServer(deps);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent) reply(res, 500, "internal error");
    });
  });
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host, () => resolve(http));
  });
}
