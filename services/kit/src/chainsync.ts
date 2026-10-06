/**
 * Ogmios chain-sync over WebSocket, compatible with Ogmios v6 and v7.
 *
 * - Intersects from the caller's stored points (newest first, then "origin").
 * - Pipelines `nextBlock` requests; delivers forward blocks and backward rollbacks in order.
 * - On a dropped socket (Yaci's snapshot rollback restarts the node) it reconnects and
 *   re-intersects from the latest stored points. The intersection found is reported as a rollback
 *   (`onRollBackward`), so a reconnect onto a shorter chain is handled exactly like RollBackward.
 * - A drop is noticed at once: on socket close, on a missed WebSocket pong (`heartbeatMs`), or when
 *   no chain-sync message arrives for `stallMs` while blocks are requested (a node restart behind a
 *   live Ogmios). Reconnects back off from `reconnectMinMs` to `reconnectMaxMs` and reset after each
 *   successful intersection, so a rollback is reflected within about one block (PRD A16).
 * - A `1000 No intersection found` answer means every sent point is orphaned; the caller's
 *   `points()` supplier is asked again with `olderThan` so it can offer older checkpoints.
 */
import WebSocket from "ws";
import { parseJsonLossless, type Point, type Tip } from "./ogmios.js";

export type IntersectionPoint = Point | "origin";

export interface ChainSyncHandlers {
  /** Stored points, newest first. `olderThan` is set when the previous batch found no intersection. */
  points(olderThan?: number): Promise<Point[]>;
  onRollForward(block: OgmiosBlock, tip: Tip): Promise<void>;
  /** Called for every RollBackward and for the implicit rollback after each (re)intersection. */
  onRollBackward(point: IntersectionPoint, tip: Tip, reason: "rollback" | "intersection"): Promise<void>;
  onError?(e: Error): void;
  onConnected?(intersection: IntersectionPoint, tip: Tip): void;
}

export interface OgmiosBlock {
  type?: string;
  era?: string;
  id: string;
  height: number;
  slot: number;
  ancestor?: string;
  transactions?: OgmiosTx[];
}

export interface OgmiosTx {
  id: string;
  spends?: "inputs" | "collaterals";
  inputs: { transaction: { id: string }; index: number }[];
  references?: { transaction: { id: string }; index: number }[];
  collaterals?: { transaction: { id: string }; index: number }[];
  outputs: {
    address: string;
    value: Record<string, Record<string, unknown>>;
    datum?: string;
    datumHash?: string;
    script?: unknown;
  }[];
  mint?: Record<string, Record<string, unknown>>;
  withdrawals?: Record<string, { ada: { lovelace: unknown } }>;
  redeemers?: RedeemerEntry[] | Record<string, { redeemer: string }>;
  requiredExtraSignatories?: string[];
  validityInterval?: { invalidBefore?: number; invalidAfter?: number };
  fee?: { ada: { lovelace: unknown } };
  certificates?: unknown[];
  signatories?: { key: string }[];
}

export interface RedeemerEntry {
  validator: { purpose: string; index: number };
  redeemer: string;
  executionUnits?: { memory: unknown; cpu: unknown };
}

export interface ChainSyncOptions {
  url: string;
  inFlight?: number;
  /** First reconnect delay; doubles per failed attempt up to `reconnectMaxMs`. */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** WebSocket ping interval; a pong missing for two intervals drops the connection. */
  heartbeatMs?: number;
  /** No chain-sync message for this long, with blocks requested, drops the connection. */
  stallMs?: number;
}

type Msg = { id?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };

export class ChainSyncClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly inFlight: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly heartbeatMs: number;
  private readonly stallMs: number;
  private reconnectDelay: number;
  private olderThan: number | undefined;

  constructor(
    private readonly options: ChainSyncOptions,
    private readonly handlers: ChainSyncHandlers,
  ) {
    this.inFlight = options.inFlight ?? 50;
    this.reconnectMinMs = options.reconnectMinMs ?? 200;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 1_000;
    this.heartbeatMs = options.heartbeatMs ?? 1_000;
    this.stallMs = options.stallMs ?? 120_000;
    this.reconnectDelay = this.reconnectMinMs;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) {
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once("close", () => resolve());
        ws.terminate();
      });
    }
    await this.queue;
  }

  /** Resolves once every message received so far has been handled (tests and graceful stops). */
  idle(): Promise<void> {
    return this.queue;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.options.url);
    this.ws = ws;
    let lastPong = Date.now();
    let lastMessage = Date.now();
    let syncing = false;
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (ws.readyState !== WebSocket.OPEN) return;
      if (now - lastPong > 2 * this.heartbeatMs) {
        this.fail(new Error("chain-sync: no pong from Ogmios; reconnecting"));
        ws.terminate();
        return;
      }
      if (syncing && now - lastMessage > this.stallMs) {
        this.fail(new Error(`chain-sync: no message for ${now - lastMessage} ms; reconnecting`));
        ws.terminate();
        return;
      }
      ws.ping();
    }, this.heartbeatMs);
    ws.on("pong", () => {
      lastPong = Date.now();
    });
    ws.on("open", () => {
      lastPong = Date.now();
      this.enqueue(async () => {
        const points = await this.handlers.points(this.olderThan);
        const list: IntersectionPoint[] = [...points, "origin"];
        this.send(ws, "findIntersection", { points: list }, "intersect");
      });
    });
    ws.on("message", (raw: WebSocket.RawData) => {
      lastMessage = Date.now();
      let msg: Msg;
      try {
        msg = parseJsonLossless(raw.toString()) as Msg;
      } catch (e) {
        this.fail(new Error(`chain-sync: undecodable message: ${(e as Error).message}`));
        return;
      }
      if ((msg as { id?: unknown }).id === "intersect" && msg.error === undefined) syncing = true;
      this.enqueue(() => this.handle(ws, msg));
    });
    ws.on("error", (e: Error) => this.fail(e));
    ws.on("close", () => {
      clearInterval(watchdog);
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectMaxMs, this.reconnectDelay * 2);
      setTimeout(() => this.connect(), delay);
    });
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((e: unknown) => {
      this.fail(e instanceof Error ? e : new Error(String(e)));
      // A handler failure leaves state unknown: drop the connection and re-intersect.
      this.ws?.terminate();
    });
  }

  private fail(e: Error): void {
    this.handlers.onError?.(e);
  }

  private send(ws: WebSocket, method: string, params: unknown, id: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(params === undefined ? { jsonrpc: "2.0", method, id } : { jsonrpc: "2.0", method, params, id }));
  }

  private async handle(ws: WebSocket, msg: Msg): Promise<void> {
    if (this.ws !== ws) return;
    if (msg.id === "intersect") {
      if (msg.error !== undefined) {
        if (msg.error.code === 1000) {
          const pts = await this.handlers.points(this.olderThan);
          const oldest = pts.at(-1);
          this.olderThan = oldest === undefined ? 0 : oldest.slot;
          ws.terminate();
          return;
        }
        throw new Error(`findIntersection failed (${msg.error.code}): ${msg.error.message}`);
      }
      this.olderThan = undefined;
      this.reconnectDelay = this.reconnectMinMs;
      const r = msg.result as { intersection: IntersectionPoint; tip: Tip };
      this.handlers.onConnected?.(r.intersection, r.tip);
      await this.handlers.onRollBackward(r.intersection, r.tip, "intersection");
      for (let i = 0; i < this.inFlight; i++) this.send(ws, "nextBlock", undefined, "next");
      return;
    }
    if (msg.id === "next") {
      if (msg.error !== undefined) throw new Error(`nextBlock failed (${msg.error.code}): ${msg.error.message}`);
      const r = msg.result as { direction: "forward"; block: OgmiosBlock; tip: Tip } | { direction: "backward"; point: IntersectionPoint; tip: Tip };
      if (r.direction === "forward") await this.handlers.onRollForward(r.block, r.tip);
      else await this.handlers.onRollBackward(r.point, r.tip, "rollback");
      this.send(ws, "nextBlock", undefined, "next");
    }
  }
}
