import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DEFAULT_CORS_ORIGINS, corsOriginsFromEnv, createApi } from "../src/api.js";
import { EventHub } from "../src/hub.js";

const log = pino({ level: "silent" });
const app = createApi({
  pool: { query: async () => ({ rows: [] }) } as never,
  scripts: null,
  oracle: null,
  log,
  tipHeight: async () => 0,
  tipSlot: async () => 0,
  horizonSlots: 300,
  adminToken: null,
  decimalsOf: () => 6,
  health: () => ({}),
  views: { slotConfig: { zeroTime: 0, zeroSlot: 0, slotLength: 1000 }, indexedSlot: async () => 0, maxExUnits: async () => ({ memory: 1n, steps: 1n }) },
  corsOrigins: [...DEFAULT_CORS_ORIGINS],
});

describe("CORS on the REST API", () => {
  it("answers an allowed preflight with the origin, GET/POST/OPTIONS and no credentials", async () => {
    const res = await app.request(`/v1/trees/${"7".repeat(56)}`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3100", "access-control-request-method": "GET" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3100");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET,POST,OPTIONS");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("sets the header on simple requests from allowed origins only", async () => {
    const ok = await app.request("/health", { headers: { origin: "https://cascade-alpha-amber.vercel.app" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://cascade-alpha-amber.vercel.app");
    const evil = await app.request("/health", { headers: { origin: "https://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("reads the allowlist from env and never accepts a wildcard", () => {
    expect(corsOriginsFromEnv("https://a.example, http://localhost:9999/")).toEqual(["https://a.example", "http://localhost:9999"]);
    expect(corsOriginsFromEnv("*")).toEqual([...DEFAULT_CORS_ORIGINS]);
    expect(corsOriginsFromEnv(undefined)).toEqual([...DEFAULT_CORS_ORIGINS]);
  });
});

describe("WebSocket origin check", () => {
  let server: Server;
  let hub: EventHub;
  let port: number;
  beforeAll(async () => {
    hub = new EventHub(log, async () => [], 10, ["http://localhost:3100"]);
    server = serve({ fetch: new Hono().fetch, port: 0, hostname: "127.0.0.1" }) as Server;
    hub.attach(server);
    await new Promise((r) => server.once("listening", r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => {
    hub.close();
    server.close();
  });
  const open = (origin?: string) =>
    new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, origin === undefined ? {} : { origin });
      ws.on("open", () => (ws.close(), resolve(true)));
      ws.on("error", () => resolve(false));
    });

  it("accepts allowed browser origins and server clients, refuses others", async () => {
    expect(await open("http://localhost:3100")).toBe(true);
    expect(await open()).toBe(true);
    expect(await open("https://evil.example")).toBe(false);
  });
});
