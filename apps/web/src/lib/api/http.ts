import type { CascadeEvent } from "@cascade/shared/browser";
import { parseEvent, parseEvents } from "./events";
import { z } from "zod";
import {
  AgentProfileSchema,
  AgentSummarySchema,
  CreateJobResponseSchema,
  DeploymentSchema,
  DisputeListSchema,
  EventsPageSchema,
  FundTxResponseSchema,
  NodeDetailSchema,
  OpsStatusSchema,
  PlanEnvelopeSchema,
  ProviderWorkSchema,
  ReceiptSchema,
  TreeListSchema,
  TreeSchema,
  TxPreviewSchema,
  UnsignedTxSchema,
} from "./schemas";
import { LandingDataSchema } from "@/lib/landing/data";
import { ApiError, ConductorOfflineError, type DataSource, type EventSubscription, type SubscriptionHandlers } from "./source";

const HEX28 = /^[0-9a-f]{56}$/;
const AGENT_ID = /^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/;
const PLAN_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_EVENT_PAGES = 100;
const GATEWAY_DOWN = new Set([502, 503, 504]);
const DEFAULT_POLL_MS = 3_000;
const AgentListSchema = z.object({ agents: z.array(AgentSummarySchema) });

function requireId(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) throw new ApiError(`${what} is not valid`, 400, what);
  return value;
}

interface HttpConfig {
  /** Indexer REST base: this app's `/api` mount or an external indexer. */
  indexerUrl: string;
  /** Conductor API base, or null when the site has no orchestrator. */
  conductorUrl: string | null;
  wsUrl: string | null;
  pollMs?: number;
  fetchImpl?: typeof fetch;
  webSocketImpl?: typeof WebSocket;
}

export function createHttpSource(config: HttpConfig): DataSource {
  const doFetch = config.fetchImpl ?? ((input, init) => fetch(input, init));

  async function request<S extends z.ZodType>(
    base: "indexer" | "conductor",
    route: string,
    schema: S,
    init?: { method: "POST"; body: unknown },
  ): Promise<z.infer<S>> {
    const baseUrl = base === "indexer" ? config.indexerUrl : config.conductorUrl;
    if (baseUrl === null) throw new ConductorOfflineError(null);
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${route}`, {
        method: init?.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(init === undefined ? {} : { "content-type": "application/json" }),
          // The public Conductor sits behind an ngrok domain, which answers browsers with an
          // interstitial page unless this header is present.
          ...(base === "conductor" ? { "ngrok-skip-browser-warning": "1" } : {}),
        },
        body: init === undefined ? undefined : JSON.stringify(init.body),
        cache: "no-store",
      });
    } catch (cause) {
      if (base === "conductor") throw new ConductorOfflineError(baseUrl);
      throw new ApiError(`Could not reach ${baseUrl}: ${(cause as Error).message}`, null, route);
    }
    if (base === "conductor" && GATEWAY_DOWN.has(response.status)) throw new ConductorOfflineError(baseUrl);
    if (!response.ok) {
      let detail = response.statusText;
      try {
        const body = (await response.json()) as { error?: unknown; detail?: unknown };
        if (typeof body.error === "string") detail = typeof body.detail === "string" ? `${body.error}: ${body.detail}` : body.error;
      } catch {
        // Non-JSON error bodies keep the status text.
      }
      throw new ApiError(`${route} returned ${response.status} ${detail}`, response.status, route);
    }
    const json: unknown = await response.json();
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ApiError(`${route} returned an unexpected shape at ${issue?.path.join(".") ?? "root"}: ${issue?.message ?? "invalid"}`, response.status, route);
    }
    return parsed.data;
  }

  return {
    kind: "http",
    async getDeployment() {
      let response: Response;
      try {
        response = await doFetch("/api/deployment", { headers: { accept: "application/json" }, cache: "no-store" });
      } catch (cause) {
        throw new ApiError(`Could not load the deployment: ${(cause as Error).message}`, null, "/api/deployment");
      }
      if (!response.ok) throw new ApiError(`/api/deployment returned ${response.status}`, response.status, "/api/deployment");
      const parsed = DeploymentSchema.safeParse(await response.json());
      if (!parsed.success) throw new ApiError("/api/deployment returned an unexpected shape", response.status, "/api/deployment");
      return parsed.data;
    },
    getTree: (treeId) => request("indexer", `/v1/trees/${requireId(treeId, HEX28, "tree id")}`, TreeSchema),
    async getTreeEvents(treeId) {
      const id = requireId(treeId, HEX28, "tree id");
      const events: CascadeEvent[] = [];
      const warnings: string[] = [];
      let since: string | null = null;
      for (let page = 0; page < MAX_EVENT_PAGES; page++) {
        const query: string = since === null ? "?limit=1000" : `?limit=1000&since=${encodeURIComponent(since)}`;
        const result: z.infer<typeof EventsPageSchema> = await request("indexer", `/v1/trees/${id}/events${query}`, EventsPageSchema);
        const parsed = parseEvents(result.events);
        events.push(...parsed.events);
        warnings.push(...parsed.warnings);
        if (result.next === null) return { events, warnings };
        since = result.next;
      }
      throw new ApiError(`Tree ${id} has more than ${MAX_EVENT_PAGES * 1000} events`, null, "events");
    },
    getReceipt: (treeId) => request("indexer", `/v1/trees/${requireId(treeId, HEX28, "tree id")}/receipt`, ReceiptSchema),
    getNodeDetail: (treeId, nodeId) =>
      request("indexer", `/v1/trees/${requireId(treeId, HEX28, "tree id")}/nodes/${requireId(nodeId, HEX28, "node id")}`, NodeDetailSchema),
    getAgent: (assetId) => request("indexer", `/v1/agents/${requireId(assetId, AGENT_ID, "agent id")}`, AgentProfileSchema),
    async searchAgents(query) {
      const params = new URLSearchParams();
      if (query.category !== undefined) params.set("category", query.category);
      if (query.min_rep !== undefined) params.set("min_rep", String(query.min_rep));
      if (query.rail !== undefined) params.set("rail", query.rail);
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      return (await request("indexer", `/v1/agents${suffix}`, AgentListSchema)).agents;
    },
    previewTx: (txCbor) => request("indexer", "/v1/tx/preview", TxPreviewSchema, { method: "POST", body: { tx_cbor: txCbor, network: "cardano:preprod" } }),
    createJob: (body) => request("conductor", "/v1/jobs", CreateJobResponseSchema, { method: "POST", body }),
    getPlan: (planId) => request("conductor", `/v1/plans/${requireId(planId, PLAN_ID, "plan id")}`, PlanEnvelopeSchema),
    requestFundTx: (planId, body) =>
      request("conductor", `/v1/plans/${requireId(planId, PLAN_ID, "plan id")}/fund-tx`, FundTxResponseSchema, { method: "POST", body }),
    buildTreeActionTx: (treeId, body) =>
      request("conductor", `/v1/trees/${requireId(treeId, HEX28, "tree id")}/actions`, UnsignedTxSchema, { method: "POST", body }),
    async listTrees(buyerVkh, limit) {
      const params = new URLSearchParams();
      if (buyerVkh !== null) params.set("buyer", requireId(buyerVkh, HEX28, "buyer key hash"));
      if (limit !== undefined) // The indexer caps `limit` at 100.
        params.set("limit", String(Math.max(1, Math.min(100, Math.floor(limit)))));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      return (await request("indexer", `/v1/trees${suffix}`, TreeListSchema)).trees;
    },
    getLanding: () => request("indexer", "/v1/landing", LandingDataSchema),
    listDisputes: async () => (await request("indexer", "/v1/disputes", DisputeListSchema)).disputes,
    buildResolveTx: (treeId, nodeId, body) =>
      request("conductor", `/v1/disputes/${requireId(treeId, HEX28, "tree id")}/${requireId(nodeId, HEX28, "node id")}/resolve-tx`, UnsignedTxSchema, { method: "POST", body }),
    getOpsStatus: () => request("indexer", "/v1/ops/status", OpsStatusSchema),
    getProviderWork: (assetId) => request("indexer", `/v1/agents/${requireId(assetId, AGENT_ID, "agent id")}/work`, ProviderWorkSchema),
    subscribeTree: (treeId, sinceEventId, handlers) => {
      const id = requireId(treeId, HEX28, "tree id");
      const poll = async (since: string | null): Promise<CascadeEvent[]> => {
        const query = since === null ? "?limit=1000" : `?limit=1000&since=${encodeURIComponent(since)}`;
        const parsed = parseEvents((await request("indexer", `/v1/trees/${id}/events${query}`, EventsPageSchema)).events);
        for (const w of parsed.warnings) handlers.onError(w);
        return parsed.events;
      };
      return subscribe({ wsUrl: config.wsUrl, webSocketImpl: config.webSocketImpl, pollMs: config.pollMs ?? DEFAULT_POLL_MS, poll }, id, sinceEventId, handlers);
    },
  };
}

interface StreamConfig {
  wsUrl: string | null;
  webSocketImpl: typeof WebSocket | undefined;
  pollMs: number;
  poll: (since: string | null) => Promise<CascadeEvent[]>;
}

/**
 * Live events for one tree. Uses the WebSocket when one is configured and open; otherwise, and
 * whenever it drops, polls the events route every `pollMs`. Both resume after the last event
 * delivered, so switching between them never loses or repeats an event.
 */
export function subscribe(cfg: StreamConfig, treeId: string, sinceEventId: string | null, handlers: SubscriptionHandlers): EventSubscription {
  let lastEventId = sinceEventId;
  let closed = false;
  let socket: WebSocket | null = null;
  let wsOpen = false;
  let attempt = 0;
  let wsTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let polling = false;

  const deliver = (event: CascadeEvent): void => {
    if (event.tree_id !== treeId) return;
    if (lastEventId !== null && /^\d+$/.test(lastEventId) && /^\d+$/.test(event.event_id) && BigInt(event.event_id) <= BigInt(lastEventId)) return;
    lastEventId = event.event_id;
    handlers.onEvent(event);
  };

  const schedulePoll = (): void => {
    if (closed || wsOpen || pollTimer !== null) return;
    pollTimer = setTimeout(() => void pollOnce(), cfg.pollMs);
  };
  const pollOnce = async (): Promise<void> => {
    pollTimer = null;
    if (closed || wsOpen || polling) return;
    polling = true;
    try {
      for (const e of await cfg.poll(lastEventId)) deliver(e);
      if (!closed && !wsOpen) handlers.onStatus("polling");
    } catch (error) {
      handlers.onError(`Could not fetch new events: ${(error as Error).message}`);
    } finally {
      polling = false;
      schedulePoll();
    }
  };

  const connect = (): void => {
    if (cfg.wsUrl === null || closed) return;
    const Impl = cfg.webSocketImpl ?? WebSocket;
    const url = new URL(cfg.wsUrl);
    url.searchParams.set("tree_id", treeId);
    if (lastEventId !== null) url.searchParams.set("since", lastEventId);
    try {
      socket = new Impl(url.toString());
    } catch {
      socket = null;
      retry();
      return;
    }
    socket.onopen = () => {
      attempt = 0;
      wsOpen = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
      handlers.onStatus("live");
    };
    socket.onmessage = (message: MessageEvent) => {
      let data: unknown;
      try {
        data = JSON.parse(String(message.data));
      } catch {
        handlers.onError("The indexer sent a frame that is not JSON.");
        return;
      }
      const { event, warning } = parseEvent(data);
      if (warning !== null) handlers.onError(warning);
      if (event !== null) deliver(event);
    };
    socket.onclose = () => {
      socket = null;
      wsOpen = false;
      if (closed) return;
      schedulePoll();
      retry();
    };
  };
  const retry = (): void => {
    if (closed) return;
    attempt += 1;
    wsTimer = setTimeout(connect, Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6)));
  };

  handlers.onStatus(cfg.wsUrl === null ? "polling" : "connecting");
  connect();
  // Catch up at once, then keep polling until the socket (if any) is open.
  void pollOnce();
  return {
    close() {
      closed = true;
      if (wsTimer !== null) clearTimeout(wsTimer);
      if (pollTimer !== null) clearTimeout(pollTimer);
      socket?.close();
      handlers.onStatus("offline");
    },
  };
}
