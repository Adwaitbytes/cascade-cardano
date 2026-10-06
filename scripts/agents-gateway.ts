// One public entry point for every preprod agent: a local reverse proxy that routes
// /<agent>/<path> to http://127.0.0.1:<agent port>/<path>, exposed through one tunnel, so a
// single stable domain serves all agents (registry api_base_url = https://<domain>/<agent>).
//
// Exposure, in order of preference:
//   NGROK_AUTHTOKEN + NGROK_DOMAIN set  ngrok static domain (stable across restarts)
//   otherwise                           one Cloudflare quick tunnel (URL changes on restart, BLOCKERS B5)
//   --local                             gateway only, no tunnel
// Live URLs go to the git-ignored deployments/agents.preprod.runtime.json; the committed
// agents.preprod.json holds registry facts only. Ctrl-C stops the gateway and its tunnel.
//
// Usage: tsx agents-gateway.ts [--port 24100] [--local]
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { optionalEnv } from "./lib/env.js";
import { publicAgents, writeAgentsRuntime, type AgentsRuntime, type ExposedAgent, type PublicAgent } from "./lib/agents.js";

const DEFAULT_PORT = 24100;
const START_TIMEOUT_MS = 60_000;
const RECHECK_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 120_000;
const AGENT_SEGMENT = /^\/([a-z][a-z0-9-]{0,39})(\/.*)?$/;

/** Maps `/<agent>/rest?query` to the agent's port and the path without the prefix. */
export function routeRequest(url: string, ports: ReadonlyMap<string, number>): { port: number; path: string } | null {
  const q = url.indexOf("?");
  const pathname = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? "" : url.slice(q);
  const m = AGENT_SEGMENT.exec(pathname);
  if (m === null) return null;
  const port = ports.get(m[1] as string);
  if (port === undefined) return null;
  return { port, path: `${m[2] ?? "/"}${query}` };
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function forward(req: IncomingMessage, res: ServerResponse, port: number, path: string): void {
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) headers[k] = v;
  headers.host = `127.0.0.1:${port}`;
  headers["x-forwarded-host"] = req.headers.host ?? "";
  headers["x-forwarded-proto"] = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const upstream = request({ host: "127.0.0.1", port, path, method: req.method, headers, timeout: UPSTREAM_TIMEOUT_MS }, (up) => {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
    res.writeHead(up.statusCode ?? 502, out);
    up.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "agent_unreachable" }));
  });
  req.pipe(upstream);
}

export function startGateway(agents: readonly PublicAgent[], port: number, host = "127.0.0.1"): Promise<Server> {
  const ports = new Map(agents.map((a) => [a.agent, a.localPort]));
  const server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", agents: [...ports.keys()] }));
      return;
    }
    const route = routeRequest(req.url ?? "/", ports);
    if (route === null) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "unknown_agent" }));
      return;
    }
    forward(req, res, route.port, route.path);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

/** Spawns a tunnel process and resolves with its public base URL once it reports one. */
function startTunnel(cmd: string, args: string[], env: NodeJS.ProcessEnv, pattern: RegExp, fixedUrl: string | null): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} reported no tunnel within ${START_TIMEOUT_MS / 1000} s`));
    }, START_TIMEOUT_MS);
    let buffered = "";
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      const match = pattern.exec(buffered);
      if (match === null) return;
      clearTimeout(timer);
      buffered = "";
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
      child.stdout?.resume();
      child.stderr?.resume();
      resolve({ child, url: fixedUrl ?? match[0] });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e.message.includes("ENOENT") ? new Error(`${cmd} is not installed`) : e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} exited with code ${code} before the tunnel came up`));
    });
  });
}

function startNgrok(port: number, domain: string): Promise<{ child: ChildProcess; url: string }> {
  if (!/^[a-z0-9.-]+$/.test(domain)) throw new Error("NGROK_DOMAIN must be a bare host name such as example.ngrok-free.app");
  // The authtoken reaches ngrok through its own env var, never argv.
  const env = { ...process.env, NGROK_AUTHTOKEN: optionalEnv("NGROK_AUTHTOKEN") };
  return startTunnel(
    process.env.NGROK_BIN ?? "ngrok",
    ["http", `--url=${domain}`, String(port), "--log", "stdout", "--log-format", "json"],
    env,
    /"msg":"started tunnel"/,
    `https://${domain}`,
  );
}

function startQuickTunnel(port: number): Promise<{ child: ChildProcess; url: string }> {
  return startTunnel(
    process.env.CLOUDFLARED_BIN ?? "cloudflared",
    ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
    process.env,
    /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
    null,
  );
}

async function availability(url: string): Promise<ExposedAgent["availability"]> {
  try {
    // ngrok's free tier serves an interstitial page to browsers unless this header is present.
    const res = await fetch(`${url}/availability`, { headers: { "ngrok-skip-browser-warning": "1" }, signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
    return res.ok && body?.status === "available" ? "ok" : "not-answering";
  } catch {
    return "not-answering";
  }
}

async function main(): Promise<void> {
  const portIndex = process.argv.indexOf("--port");
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be 1..65535");
  const localOnly = process.argv.includes("--local");
  const agents = publicAgents();
  const server = await startGateway(agents, port);
  console.log(`gateway on http://127.0.0.1:${port}/<agent>/ for ${agents.map((a) => a.agent).join(", ")}`);

  const domain = optionalEnv("NGROK_DOMAIN");
  const useNgrok = !localOnly && domain !== undefined && optionalEnv("NGROK_AUTHTOKEN") !== undefined;
  let tunnel: { child: ChildProcess; url: string } | null = null;
  let mode: AgentsRuntime["mode"] = "gateway-local";
  if (!localOnly) {
    tunnel = useNgrok ? await startNgrok(port, domain as string) : await startQuickTunnel(port);
    mode = useNgrok ? "gateway-ngrok" : "gateway-quick";
    console.log(`public base ${tunnel.url} (${mode})${useNgrok ? "" : "; quick-tunnel URLs change on restart (BLOCKERS B5)"}`);
  }
  const base = tunnel?.url ?? `http://127.0.0.1:${port}`;

  const stop = (): void => {
    tunnel?.child.kill();
    server.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  tunnel?.child.once("exit", (code) => {
    process.stderr.write(`tunnel exited (${code}); stopping the gateway\n`);
    server.close();
    process.exit(1);
  });

  const runtime: AgentsRuntime = {
    network: "preprod",
    mode,
    gatewayPort: port,
    publicBase: tunnel?.url ?? null,
    startedAt: new Date().toISOString(),
    agents: agents.map((a) => ({ agent: a.agent, localPort: a.localPort, publicUrl: `${base}/${a.agent}`, availability: "not-answering" })),
  };
  const record = async (): Promise<void> => {
    for (const a of runtime.agents) a.availability = await availability(a.publicUrl);
    writeAgentsRuntime(runtime);
    console.log(`availability: ${runtime.agents.map((a) => `${a.agent}=${a.availability}`).join(" ")}`);
  };
  // A new tunnel takes a few seconds to route after it reports its URL.
  if (tunnel !== null) await new Promise((r) => setTimeout(r, 10_000));
  await record();
  setInterval(() => void record().catch((e: unknown) => process.stderr.write(`recheck failed: ${String(e)}\n`)), RECHECK_MS);
}

if (process.argv[1]?.endsWith("agents-gateway.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
