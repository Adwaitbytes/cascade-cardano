import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ChainAccess } from "../src/chain.js";
import { CascadeApi, endpointsFromEnv, type CascadeEndpoints, type Fetch } from "../src/client.js";
import { startHttpServer } from "../src/http.js";
import { createCascadeMcpServer, pendingActions } from "../src/server.js";

const TREE = "a".repeat(56);
const NODE = "b".repeat(56);
const AGENT = "c".repeat(56) + "01";
const NOW = 1_800_000_000_000;

const plan = {
  plan: {
    plan_id: "plan-1",
    plan_root: "d".repeat(64),
    asset: "lovelace",
    deadlines: { fund_by: NOW + 1_800_000 },
    root: {
      spec: { title: "Market brief" },
      max_budget: "150000000",
      agents: { primary: { agent_id: AGENT }, fallbacks: [] },
      children: [{ spec: { title: "Scout sources" }, max_budget: "40000000", agents: { primary: { agent_id: AGENT }, fallbacks: [{ agent_id: AGENT }] }, children: [] }],
    },
  },
  goal: "Write a market brief on Cardano stablecoins",
  status: "draft",
  tree_id: null,
  agents: { [AGENT]: { name: "Scout", reputation: 0.82 } },
};

const node = (state: string, extra: Record<string, unknown> = {}) => ({
  node_id: NODE,
  parent_id: null,
  depth: 0,
  kind: "Native",
  agent_asset_id: AGENT,
  budget: "150000000",
  fee: "0",
  state,
  submit_by: NOW + 60_000,
  challenge_until: NOW + 120_000,
  refund_after: NOW + 180_000,
  dispute_until: NOW + 240_000,
  tx_ids: [],
  ...extra,
});

const preview = {
  tx_body_hash: "e".repeat(64),
  summary: "Funds a new tree with 150 ADA from your wallet.",
  actions: [{ type: "FundRoot", text: "Create root node with budget 150 ADA" }],
  moves: [{ to: "Cascade node script", value: { asset: "lovelace", amount: "150000000" } }],
  warnings: [],
};

interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string | null;
}

function fakeServices(calls: Call[]): Fetch {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ method, url, body, auth });
    const path = new URL(url).pathname;
    if (method === "POST" && path === "/v1/jobs") return json(200, { plan_id: "plan-1" });
    if (method === "GET" && path === "/v1/plans/plan-1") return json(200, plan);
    if (method === "POST" && path === "/v1/plans/plan-1/fund-tx") return json(200, { tx_cbor: "84a400", tree_id: TREE });
    if (method === "POST" && path === `/v1/trees/${TREE}/actions`) return json(200, { tx_cbor: "84a401" });
    if (method === "POST" && path === "/v1/tx/preview") return json(200, preview);
    if (method === "GET" && path === `/v1/trees/${TREE}`) {
      return json(200, { tree_id: TREE, asset: "lovelace", root_budget: "150000000", state: "open", frozen: false, nodes: [node("Submitted")] });
    }
    if (method === "GET" && path === `/v1/trees/${TREE}/receipt`) return json(200, { tree_id: TREE, reconciled: true, signature: "f0" });
    if (method === "GET" && path === "/v1/agents") {
      return json(200, { agents: [{ agent_asset_id: AGENT, name: "Scout", api_url: "http://scout", categories: ["research"], rails: ["native"], availability: "available", reputation: { score: 0.82, confidence: 0.5 } }] });
    }
    if (method === "GET" && (path === "/availability" || path === "/input_schema")) return json(200, { status: "available" });
    if (method === "POST" && path === "/v1/admin/agents") return json(201, { ok: true });
    if (method === "GET" && path === "/v1/roles") return json(200, { roles: [{ role: "conductor", address: "addr_test1agent", paymentKeyHash: NODE }] });
    if (method === "POST" && path === "/v1/sign") return json(200, { decision: "allow", signed_tx: "84a4ff", tx_body_hash: "e".repeat(64) });
    return json(404, { error: "not_found" });
  };
}

const baseEndpoints: CascadeEndpoints = {
  network: "local",
  consoleUrl: "http://console.test",
  indexerUrl: "http://indexer.test",
  signer: null,
  indexerAdminToken: null,
};

async function connect(endpoints: CascadeEndpoints, calls: Call[], chain: ChainAccess | null = null): Promise<Client> {
  const api = new CascadeApi(endpoints, { fetch: fakeServices(calls) });
  const server = createCascadeMcpServer({ api, chain, now: () => NOW });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

const textOf = (r: unknown): string => ((r as CallToolResult).content[0] as { text: string }).text;

describe("cascade MCP server", () => {
  it("lists the eight PRD 15.3 tools", async () => {
    const client = await connect(baseEndpoints, []);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cascade_accept_result",
      "cascade_challenge_result",
      "cascade_find_agents",
      "cascade_fund_job",
      "cascade_get_receipt",
      "cascade_job_status",
      "cascade_plan_job",
      "cascade_serve_as_agent",
    ]);
  });

  it("plans a job and describes the tree with agents and prices", async () => {
    const calls: Call[] = [];
    const client = await connect(baseEndpoints, calls);
    const r = await client.callTool({ name: "cascade_plan_job", arguments: { goal: "Write a market brief on Cardano stablecoins", budget: "150000000" } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("Scout sources: budget 40000000 -> Scout, reputation 82/100 (+1 fallback)");
    const job = calls.find((c) => c.url.endsWith("/v1/jobs"));
    expect(job?.body).toMatchObject({ asset: "lovelace", budget: "150000000", deadline: NOW + 120 * 60_000, risk: "balanced", max_depth: 3 });
  });

  it("returns an unsigned FundRoot tx with a plain-language preview and never signs by default", async () => {
    const calls: Call[] = [];
    const client = await connect(baseEndpoints, calls);
    const r = await client.callTool({ name: "cascade_fund_job", arguments: { plan_id: "plan-1", change_address: "addr_test1buyer", utxos: ["8282"] } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ status: "unsigned", tx_cbor: "84a400", tree_id: TREE });
    expect(textOf(r)).toContain("Funds a new tree with 150 ADA");
    expect(calls.some((c) => c.url.includes("/v1/sign"))).toBe(false);
  });

  it("refuses sign: true when no agent key is configured", async () => {
    const client = await connect(baseEndpoints, []);
    const r = await client.callTool({ name: "cascade_fund_job", arguments: { plan_id: "plan-1", sign: true } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("no agent key is configured");
  });

  it("signs only through the signer service when an agent key is configured", async () => {
    const calls: Call[] = [];
    const submitted: string[] = [];
    const chain: ChainAccess = {
      walletContext: async (address) => ({ change_address: address, utxos: ["8282"] }),
      submit: async (cbor) => {
        submitted.push(cbor);
        return "f".repeat(64);
      },
    };
    const endpoints = { ...baseEndpoints, signer: { url: "http://signer.test", token: "t0k", role: "conductor" } };
    const client = await connect(endpoints, calls, chain);
    const r = await client.callTool({ name: "cascade_accept_result", arguments: { tree_id: TREE, node_id: NODE, sign: true } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ status: "submitted", tx_id: "f".repeat(64) });
    const sign = calls.find((c) => c.url === "http://signer.test/v1/sign");
    expect(sign).toMatchObject({ body: { role: "conductor", tx_cbor: "84a401" }, auth: "Bearer t0k" });
    expect(calls.find((c) => c.url.includes("/actions"))?.body).toMatchObject({ action: "Accept", node_id: NODE, change_address: "addr_test1agent" });
    expect(submitted).toEqual(["84a4ff"]);
  });

  it("reports status with pending buyer actions", async () => {
    const client = await connect(baseEndpoints, []);
    const r = await client.callTool({ name: "cascade_job_status", arguments: { tree_id: TREE } });
    expect(textOf(r)).toContain("buyer can accept or challenge");
  });

  describe("a tree the indexer has not seen yet (preprod A18: 404 unknown tree right after funding)", () => {
    /** The indexer answers 404 for the first `misses` reads of the tree, then serves it. */
    async function lagging(misses: number, indexWaitMs?: number) {
      const sleeps: number[] = [];
      let reads = 0;
      const services = fakeServices([]);
      const lag: Fetch = async (input, init) => {
        if (new URL(String(input)).pathname === `/v1/trees/${TREE}` && reads++ < misses) {
          return new Response(JSON.stringify({ error: "not_found", detail: "unknown tree" }), { status: 404, headers: { "content-type": "application/json" } });
        }
        return services(input, init);
      };
      const server = createCascadeMcpServer({ api: new CascadeApi(baseEndpoints, { fetch: lag }), chain: null, now: () => NOW, sleep: async (ms) => void sleeps.push(ms), ...(indexWaitMs === undefined ? {} : { indexWaitMs }) });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: "test", version: "0.0.0" });
      await client.connect(clientSide);
      return { client, sleeps, reads: () => reads };
    }

    it("polls with backoff until the indexer has it", async () => {
      const { client, sleeps } = await lagging(3);
      const r = await client.callTool({ name: "cascade_job_status", arguments: { tree_id: TREE } });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toContain(`Tree ${TREE}: open`);
      expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    });

    it("answers pending, not an error, once the bounded wait runs out", async () => {
      const { client, sleeps, reads } = await lagging(1_000, 60_000);
      const r = await client.callTool({ name: "cascade_job_status", arguments: { tree_id: TREE } });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toMatch(/is funded but not indexed yet .* pending, not failed/);
      expect(r.structuredContent).toMatchObject({ tree_id: TREE, status: "pending_index", tree: null });
      expect(sleeps.reduce((a, b) => a + b, 0)).toBe(60_000);
      expect(reads()).toBe(sleeps.length + 1);
    });
  });

  it("finds agents, fetches receipts and lists a serving agent", async () => {
    const calls: Call[] = [];
    const client = await connect({ ...baseEndpoints, indexerAdminToken: "adm" }, calls);
    expect(textOf(await client.callTool({ name: "cascade_find_agents", arguments: { category: "research", min_reputation: 0.5 } }))).toContain("Scout");
    expect(calls.at(-1)?.url).toBe("http://indexer.test/v1/agents?category=research&min_rep=0.5");
    expect(textOf(await client.callTool({ name: "cascade_get_receipt", arguments: { tree_id: TREE } }))).toContain('"reconciled": true');
    const served = await client.callTool({
      name: "cascade_serve_as_agent",
      arguments: { agent_asset_id: AGENT, name: "Scout", api_url: "http://scout.test", payment_vkh: NODE, categories: ["research"] },
    });
    expect(served.structuredContent).toMatchObject({ listed: true });
    expect(calls.find((c) => c.url.endsWith("/v1/admin/agents"))?.auth).toBe("Bearer adm");
  });

  it("surfaces service errors as tool errors", async () => {
    const client = await connect(baseEndpoints, []);
    const r = await client.callTool({ name: "cascade_get_receipt", arguments: { tree_id: "9".repeat(56) } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("indexer answered 404 not_found");
  });
});

describe("pending actions", () => {
  it("flags refund cranks once a funded node passes refund_after", () => {
    const tree = { tree_id: TREE, asset: "lovelace", root_budget: "1", state: "open", frozen: false, nodes: [node("Funded", { refund_after: NOW - 1 })] };
    expect(pendingActions(tree, NOW)[0]).toContain("anyone can crank Refund");
  });
});

describe("configuration", () => {
  it("refuses networks other than local and preprod, and half-configured signing", () => {
    expect(() => endpointsFromEnv({ CASCADE_NETWORK: "mainnet" })).toThrow("CASCADE_NETWORK");
    expect(() => endpointsFromEnv({ CASCADE_SIGNER_TOKEN: "x" })).toThrow("CASCADE_AGENT_ROLE");
    expect(endpointsFromEnv({}).signer).toBeNull();
  });
});

describe("streamable HTTP transport", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it("serves tools over HTTP and enforces the bearer token", async () => {
    const api = new CascadeApi(baseEndpoints, { fetch: fakeServices([]) });
    const http = await startHttpServer({ api, chain: null, now: () => NOW }, { host: "127.0.0.1", port: 0, token: "secret-token" });
    close = () => new Promise((r) => http.close(() => r()));
    const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);

    const denied = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(denied.status).toBe(401);

    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: "Bearer secret-token" } } }));
    const r = await client.callTool({ name: "cascade_job_status", arguments: { tree_id: TREE } });
    expect(textOf(r)).toContain(`Tree ${TREE}: open`);
    await client.close();
  });

  it("refuses to start without a token when an agent key is configured", () => {
    const api = new CascadeApi({ ...baseEndpoints, signer: { url: "http://s", token: "t", role: "conductor" } });
    expect(() => startHttpServer({ api, chain: null }, { host: "127.0.0.1", port: 0, token: null })).toThrow("CASCADE_MCP_TOKEN");
  });
});
