import type { CascadeEvent } from "@cascade/shared/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_CLOSED } from "@/lib/fixtures/tree";
import { createHttpSource, subscribe } from "./http";
import { ConductorOfflineError, type LiveStatus } from "./source";

const TREE = FIXTURE_CLOSED.tree.tree_id;
const withId = (e: CascadeEvent, id: number): CascadeEvent => ({ ...e, event_id: String(id) });
const EVENTS = FIXTURE_CLOSED.events.slice(0, 4).map((e, i) => withId(e, i + 1));

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  close(): void {
    this.onclose?.();
  }
}

describe("subscribe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  it("polls every interval without a WebSocket and resumes after the last event", async () => {
    const calls: (string | null)[] = [];
    const batches = [EVENTS.slice(0, 2), [], EVENTS.slice(2)];
    const got: string[] = [];
    const statuses: LiveStatus[] = [];
    const sub = subscribe(
      { wsUrl: null, webSocketImpl: undefined, pollMs: 3000, poll: async (since) => (calls.push(since), batches.shift() ?? []) },
      TREE,
      null,
      { onEvent: (e) => got.push(e.event_id), onStatus: (s) => statuses.push(s), onError: () => undefined },
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    sub.close();
    expect(got).toEqual(["1", "2", "3", "4"]);
    expect(calls).toEqual([null, "2", "2"]);
    expect(statuses).toContain("polling");
  });

  it("stops polling while the WebSocket is open and falls back when it drops", async () => {
    let polls = 0;
    const statuses: LiveStatus[] = [];
    const got: string[] = [];
    const sub = subscribe(
      { wsUrl: "ws://indexer.test/v1/ws", webSocketImpl: FakeSocket as unknown as typeof WebSocket, pollMs: 3000, poll: async () => (polls++, []) },
      TREE,
      "7",
      { onEvent: (e) => got.push(e.event_id), onStatus: (s) => statuses.push(s), onError: () => undefined },
    );
    const socket = FakeSocket.instances[0];
    if (socket === undefined) throw new Error("no socket");
    expect(socket.url).toContain("since=7");
    socket.onopen?.();
    await vi.advanceTimersByTimeAsync(0);
    const before = polls;
    await vi.advanceTimersByTimeAsync(9000);
    expect(polls).toBe(before);
    socket.onmessage?.({ data: JSON.stringify(withId(EVENTS[0] as CascadeEvent, 8)) } as MessageEvent);
    socket.onmessage?.({ data: JSON.stringify(withId(EVENTS[0] as CascadeEvent, 8)) } as MessageEvent);
    expect(got).toEqual(["8"]);
    socket.onclose?.();
    await vi.advanceTimersByTimeAsync(3000);
    expect(polls).toBeGreaterThan(before);
    expect(statuses).toContain("live");
    sub.close();
  });
});

describe("conductor", () => {
  const plan = { planId: "plan-1" };
  it("is offline when no URL is configured", async () => {
    const source = createHttpSource({ indexerUrl: "/api", conductorUrl: null, wsUrl: null });
    await expect(source.getPlan(plan.planId)).rejects.toBeInstanceOf(ConductorOfflineError);
  });
  it("is offline when unreachable or behind a failing gateway", async () => {
    const down = createHttpSource({ indexerUrl: "/api", conductorUrl: "https://conductor.test", wsUrl: null, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
    await expect(down.getPlan(plan.planId)).rejects.toBeInstanceOf(ConductorOfflineError);
    const gateway = createHttpSource({ indexerUrl: "/api", conductorUrl: "https://conductor.test", wsUrl: null, fetchImpl: async () => new Response("bad gateway", { status: 502 }) });
    await expect(gateway.getPlan(plan.planId)).rejects.toBeInstanceOf(ConductorOfflineError);
  });
  it("sends the ngrok header to the Conductor only", async () => {
    const seen: { url: string; ngrok: string | null }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), ngrok: new Headers(init?.headers).get("ngrok-skip-browser-warning") });
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    const source = createHttpSource({ indexerUrl: "/api", conductorUrl: "https://c.test/conductor", wsUrl: null, fetchImpl });
    await source.getPlan("plan-1").catch(() => undefined);
    await source.getTree(TREE).catch(() => undefined);
    expect(seen).toEqual([
      { url: "https://c.test/conductor/v1/plans/plan-1", ngrok: "1" },
      { url: `/api/v1/trees/${TREE}`, ngrok: null },
    ]);
  });

  it("recovers when the Conductor answers again", async () => {
    let up = false;
    const fetchImpl = (async () => {
      if (!up) throw new TypeError("fetch failed");
      return Response.json({ plan_id: "plan-1" });
    }) as typeof fetch;
    const source = createHttpSource({ indexerUrl: "/api", conductorUrl: "https://c.test/conductor", wsUrl: null, fetchImpl });
    const request = { goal: "Market entry brief for juice", asset: "lovelace", budget: "1", deadline: 1, max_depth: 1, min_reputation: 0, risk: "balanced" as const, acceptance: "buyer_review" as const, allow_agents: [], block_agents: [] };
    await expect(source.createJob(request)).rejects.toBeInstanceOf(ConductorOfflineError);
    up = true;
    await expect(source.createJob(request)).resolves.toEqual({ plan_id: "plan-1" });
  });

  it("reads the indexer from the same-origin mount", async () => {
    const urls: string[] = [];
    const source = createHttpSource({
      indexerUrl: "/api",
      conductorUrl: null,
      wsUrl: null,
      fetchImpl: async (input) => (urls.push(String(input)), Response.json(FIXTURE_CLOSED.tree)),
    });
    await source.getTree(TREE);
    expect(urls).toEqual([`/api/v1/trees/${TREE}`]);
  });
});
