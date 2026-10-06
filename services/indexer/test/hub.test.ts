import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import type { CascadeEvent } from "@cascade/shared";
import { Hono } from "hono";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { EventHub } from "../src/hub.js";

const TREE = "7".repeat(56);
const ev = (id: number, tree = TREE): CascadeEvent => ({
  type: "node.accepted",
  event_id: String(id),
  tree_id: tree,
  node_id: tree,
  tx_id: "a".repeat(64),
  slot: 10,
  confirmations: 0,
  value: { asset: "lovelace", amount: "0" },
  emitted_at: 1,
  payload: {},
});

let server: Server;
let hub: EventHub;
let port: number;

beforeAll(async () => {
  hub = new EventHub(pino({ level: "silent" }), async (_tree, since) => [ev(since + 1), ev(since + 2)]);
  server = serve({ fetch: new Hono().fetch, port: 0, hostname: "127.0.0.1" }) as Server;
  hub.attach(server);
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  hub.close();
  server.close();
});

function collect(url: string, n: number): Promise<{ ws: WebSocket; got: Promise<CascadeEvent[]> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const out: CascadeEvent[] = [];
    const got = new Promise<CascadeEvent[]>((done) => {
      ws.on("message", (m) => {
        out.push(JSON.parse(m.toString()) as CascadeEvent);
        if (out.length === n) done(out);
      });
    });
    ws.on("open", () => resolve({ ws, got }));
    ws.on("error", reject);
  });
}

describe("WebSocket hub", () => {
  it("replays since an event id, then streams live events one per frame, filtered by tree", async () => {
    const { ws, got } = await collect(`ws://127.0.0.1:${port}/v1/ws?tree_id=${TREE}&since=5`, 3);
    await new Promise((r) => setTimeout(r, 100));
    hub.publish([ev(99, "8".repeat(56)), ev(8)]);
    const events = await got;
    expect(events.map((e) => e.event_id)).toEqual(["6", "7", "8"]);
    ws.close();
  });

  it("refuses malformed tree ids", async () => {
    await expect(collect(`ws://127.0.0.1:${port}/v1/ws?tree_id=zz`, 1)).rejects.toBeDefined();
  });
});
