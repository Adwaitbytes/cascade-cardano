/**
 * WebSocket event hub (PRD 17.3). Clients connect to `/v1/ws?tree_id=<hex>` (or without a filter
 * for every tree) and receive each event as one JSON message. `since=<event_id>` replays stored
 * events first, so a reconnecting client misses nothing.
 */
import type { IncomingMessage, Server } from "node:http";
import type { CascadeEvent } from "@cascade/shared";
import type { Logger } from "@cascade/service-kit";
import { WebSocketServer, type WebSocket } from "ws";

interface Sub {
  ws: WebSocket;
  treeId: string | null;
}

export class EventHub {
  private readonly subs = new Set<Sub>();
  private wss: WebSocketServer | null = null;

  constructor(
    private readonly log: Logger,
    private readonly replay: (treeId: string, since: number) => Promise<CascadeEvent[]>,
    private readonly maxClients = 5_000,
    /** Browser origins allowed to open the socket; requests without an Origin (servers) are allowed. */
    private readonly allowedOrigins: readonly string[] | null = null,
  ) {}

  attach(server: Server, path = "/v1/ws"): void {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    server.on("upgrade", (req: IncomingMessage, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== path || this.subs.size >= this.maxClients) {
        socket.destroy();
        return;
      }
      const origin = req.headers.origin;
      if (origin !== undefined && this.allowedOrigins !== null && !this.allowedOrigins.includes(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const treeId = url.searchParams.get("tree_id");
      if (treeId !== null && !/^[0-9a-f]{56}$/.test(treeId)) {
        socket.destroy();
        return;
      }
      const sinceRaw = url.searchParams.get("since");
      const since = sinceRaw !== null && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : null;
      this.wss?.handleUpgrade(req, socket, head, (ws) => {
        const sub: Sub = { ws, treeId };
        ws.on("close", () => this.subs.delete(sub));
        ws.on("error", () => this.subs.delete(sub));
        ws.on("message", () => undefined);
        void (async () => {
          if (since !== null && treeId !== null) {
            try {
              for (const e of await this.replay(treeId, since)) ws.send(JSON.stringify(e));
            } catch (e) {
              this.log.warn({ err: (e as Error).message }, "ws replay failed");
            }
          }
          this.subs.add(sub);
        })();
      });
    });
  }

  publish(events: CascadeEvent[]): void {
    for (const e of events) {
      const msg = JSON.stringify(e);
      for (const s of this.subs) {
        if (s.treeId !== null && s.treeId !== e.tree_id) continue;
        if (s.ws.readyState === s.ws.OPEN) s.ws.send(msg);
      }
    }
  }

  get clients(): number {
    return this.subs.size;
  }

  close(): void {
    for (const s of this.subs) s.ws.terminate();
    this.subs.clear();
    this.wss?.close();
  }
}
