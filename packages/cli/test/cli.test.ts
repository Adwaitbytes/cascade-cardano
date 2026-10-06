import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CascadeApi, PlanEnvelopeSchema, type CascadeEndpoints, type TreeSnapshot } from "@cascade/mcp/client";
import { describe, expect, it } from "vitest";
import { parseCommand, UsageError } from "../src/args.js";
import { BudgetError, formatUnits, parseDeadline, resolveAsset, toBaseUnits } from "../src/budget.js";
import { run, type Deps, type Io } from "../src/commands.js";
import { referenceRefs } from "../src/deployments.js";
import { renderPlan, renderTree } from "../src/render.js";

const TREE = "a".repeat(56);
const NODE = "b".repeat(56);
const CHILD = "c".repeat(56);
const AGENT = "d".repeat(56);
const NOW = 1_800_000_000_000;

const envelope = {
  plan: {
    plan_id: "plan-1",
    plan_root: "e".repeat(64),
    asset: "lovelace",
    budget: "150000000",
    deadlines: { fund_by: NOW + 1_800_000 },
    root: {
      spec: { title: "Market brief" },
      kind: "Native",
      max_budget: "150000000",
      max_fee: "5000000",
      agents: { primary: { agent_id: AGENT }, fallbacks: [] },
      children: [
        {
          spec: { title: "Price lookup" },
          kind: "Native",
          max_budget: "20000000",
          max_fee: "0",
          agents: { primary: { agent_id: "f".repeat(56) }, fallbacks: [{ agent_id: AGENT }] },
          children: [],
        },
      ],
    },
  },
  goal: "Write a market brief on Cardano stablecoins",
  status: "draft",
  tree_id: null,
  agents: { [AGENT]: { name: "Conductor", reputation: 0.82 } },
};

const tree: TreeSnapshot = {
  tree_id: TREE,
  asset: "lovelace",
  root_budget: "150000000",
  state: "open",
  frozen: false,
  nodes: [
    { node_id: NODE, parent_id: null, depth: 0, kind: "Native", agent_asset_id: AGENT, budget: "150000000", fee: "0", state: "Funded", submit_by: NOW + 600_000, challenge_until: 0, refund_after: 0, dispute_until: 0, tx_ids: [] },
    { node_id: CHILD, parent_id: NODE, depth: 1, kind: "Native", agent_asset_id: null, budget: "20000000", fee: "0", state: "Submitted", submit_by: 0, challenge_until: NOW + 120_000, refund_after: 0, dispute_until: 0, tx_ids: [] },
  ],
};

type Route = (init: RequestInit | undefined) => { status: number; body: unknown };

function fakeFetch(routes: Record<string, Route>, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push(key);
    const route = routes[key];
    const { status, body } = route === undefined ? { status: 404, body: { error: "not_found" } } : route(init);
    return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const endpoints: CascadeEndpoints = {
  network: "local",
  consoleUrl: "http://console.test",
  indexerUrl: "http://indexer.test",
  signer: null,
  indexerAdminToken: "admin",
};

function harness(routes: Record<string, Route>, overrides: Partial<Deps> = {}, eps: CascadeEndpoints = endpoints) {
  const out: string[] = [];
  const calls: string[] = [];
  const io: Io = { out: (t) => out.push(t), err: (t) => out.push(`ERR ${t}`), isTty: false, confirm: async () => false, clear: () => undefined };
  const cwd = mkdtempSync(join(tmpdir(), "cascade-cli-"));
  const deps: Deps = {
    api: new CascadeApi(eps, { fetch: fakeFetch(routes, calls) }),
    network: eps.network,
    root: cwd,
    cwd,
    io,
    now: () => NOW,
    chain: async () => {
      throw new Error("no chain in tests");
    },
    crank: async () => ({ selected: 0, ran: [] }),
    subscribe: () => () => undefined,
    untilInterrupted: async () => undefined,
    ...overrides,
  };
  return { deps, out, calls, cwd };
}

describe("argument parsing", () => {
  it("parses job plan with defaults", () => {
    const cmd = parseCommand(["job", "plan", "Market brief on stablecoins", "--budget", "150", "--asset", "usdm"]);
    expect(cmd).toEqual({
      kind: "job-plan",
      goal: "Market brief on stablecoins",
      budget: "150",
      asset: "usdm",
      deadline: "2h",
      maxDepth: 3,
      risk: "balanced",
      minRep: 50,
      json: false,
      out: null,
    });
  });

  it("rejects bad input with usage errors", () => {
    expect(() => parseCommand(["job", "plan", "short", "--budget", "1", "--asset", "ada"])).toThrow(UsageError);
    expect(() => parseCommand(["tree", "watch", "xyz"])).toThrow(UsageError);
    expect(() => parseCommand(["init", "agent", "--template", "rust"])).toThrow(UsageError);
    expect(() => parseCommand(["crank"])).toThrow(UsageError);
    expect(() => parseCommand(["job", "fund", "p1", "--change-address", "addr_test1x"])).toThrow(UsageError);
    expect(() => parseCommand(["nope"])).toThrow(UsageError);
  });

  it("parses the other commands", () => {
    expect(parseCommand(["receipt", TREE, "--json"])).toEqual({ kind: "receipt", treeId: TREE, json: true });
    expect(parseCommand(["crank", "--all"])).toEqual({ kind: "crank", all: true });
    expect(parseCommand(["init", "agent", "--template", "crewai", "--name", "my-crew"])).toEqual({
      kind: "init-agent",
      template: "crewai",
      name: "my-crew",
      dir: "my-crew",
    });
    expect(parseCommand(["register", "--registry-asset", AGENT, "--api-url", "http://a", "--name", "A", "--payment-vkh", NODE])).toMatchObject({
      kind: "register",
      rails: ["native"],
      categories: [],
    });
  });
});

describe("budget conversion", () => {
  const token = { policyId: "1".repeat(56), assetNameHex: "745553444d", decimals: 6, ticker: "tUSDM" };

  it("converts human amounts to base units exactly", () => {
    expect(toBaseUnits("150", 6)).toBe("150000000");
    expect(toBaseUnits("12.5", 6)).toBe("12500000");
    expect(toBaseUnits("0.000001", 6)).toBe("1");
    expect(() => toBaseUnits("0.0000001", 6)).toThrow(BudgetError);
    expect(() => toBaseUnits("-1", 6)).toThrow(BudgetError);
    expect(() => toBaseUnits("0", 6)).toThrow(BudgetError);
    expect(formatUnits("12500000", 6)).toBe("12.5");
  });

  it("resolves assets per network", () => {
    expect(resolveAsset("ada", "preprod", null)).toMatchObject({ assetId: "lovelace", decimals: 6 });
    expect(resolveAsset("usdm", "local", token)).toMatchObject({ assetId: `${token.policyId}.745553444d`, decimals: 6 });
    expect(() => resolveAsset("usdm", "preprod", token)).toThrow(/PREPROD_TUSDM_AVAILABLE=false/);
    expect(() => resolveAsset("usdm", "local", null)).toThrow(BudgetError);
    expect(() => resolveAsset("btc", "local", null)).toThrow(BudgetError);
  });

  it("parses relative deadlines", () => {
    expect(parseDeadline("2h", NOW)).toBe(NOW + 7_200_000);
    expect(parseDeadline("90m", NOW)).toBe(NOW + 5_400_000);
    expect(() => parseDeadline("soon", NOW)).toThrow(BudgetError);
  });
});

describe("rendering", () => {
  it("renders a plan tree with agents and prices", () => {
    const text = renderPlan(PlanEnvelopeSchema.parse(envelope));
    expect(text).toContain("Market brief [Native] Conductor (rep 82) budget 150 ADA, fee 5 ADA");
    expect(text).toContain("└─ Price lookup [Native] ffffffff…ffff budget 20 ADA +1 fallback");
  });

  it("renders a live tree with deadlines", () => {
    const text = renderTree(tree, undefined, NOW);
    expect(text).toContain(`Tree ${TREE}  state open  budget 150 ADA`);
    expect(text).toContain("bbbbbbbb…bbbb Funded [Native] dddddddd…dddd 150 ADA, 10 min left");
    expect(text).toContain("└─ cccccccc…cccc Submitted [Native] 20 ADA, 2 min left");
  });
});

describe("commands against a fake API", () => {
  it("job plan posts the job in base units and prints the plan", async () => {
    let posted: unknown;
    const { deps, out, calls, cwd } = harness({
      "POST /v1/jobs": (init) => {
        posted = JSON.parse(String(init?.body));
        return { status: 200, body: { plan_id: "plan-1" } };
      },
      "GET /v1/plans/plan-1": () => ({ status: 200, body: envelope }),
    });
    await run(parseCommand(["job", "plan", "Write a market brief on stablecoins", "--budget", "150", "--asset", "ada", "--out", "plan.json"]), deps, "");
    expect(calls).toEqual(["POST /v1/jobs", "GET /v1/plans/plan-1"]);
    expect(posted).toMatchObject({ asset: "lovelace", budget: "150000000", deadline: NOW + 7_200_000, max_depth: 3, acceptance: "buyer_review" });
    expect(out.join("\n")).toContain("Next: cascade job fund plan.json");
    expect(JSON.parse(readFileSync(join(cwd, "plan.json"), "utf8")).plan.plan_id).toBe("plan-1");
  });

  it("job fund with a user wallet prints the unsigned tx and falls back when preview is unavailable", async () => {
    const { deps, out, cwd } = harness({
      "POST /v1/plans/plan-1/fund-tx": () => ({ status: 200, body: { tx_cbor: "84a400", tree_id: TREE } }),
      "POST /v1/tx/preview": () => ({ status: 503, body: { error: "unavailable" } }),
    });
    writeFileSync(join(cwd, "utxos.json"), JSON.stringify(["82825820aa"]));
    await run(parseCommand(["job", "fund", "plan-1", "--change-address", "addr_test1qq", "--utxos", "utxos.json"]), deps, "");
    const text = out.join("\n");
    expect(text).toContain(`FundRoot for tree ${TREE} (3 bytes; indexer preview unavailable)`);
    expect(text).toContain("84a400");
  });

  it("job fund refuses to sign with an agent key without confirmation off a terminal", async () => {
    const signing = { ...endpoints, signer: { url: "http://signer.test", token: "t", role: "conductor" } };
    const { deps } = harness(
      {
        "GET /v1/roles": () => ({ status: 200, body: { roles: [{ role: "conductor", address: "addr_test1agent" }] } }),
        "POST /v1/plans/plan-1/fund-tx": () => ({ status: 200, body: { tx_cbor: "84a400", tree_id: TREE } }),
        "POST /v1/tx/preview": () => ({ status: 200, body: { summary: "Funds tree", warnings: [] } }),
      },
      { chain: async () => ({ walletUtxos: async () => ["82"], submit: async () => "tx" }) },
      signing,
    );
    await expect(run(parseCommand(["job", "fund", "plan-1"]), deps, "")).rejects.toThrow(/--yes/);
  });

  it("register probes MIP-003 endpoints before listing", async () => {
    const { deps } = harness({
      "GET /availability": () => ({ status: 200, body: { status: "available" } }),
      "GET /input_schema": () => ({ status: 500, body: {} }),
    });
    const cmd = parseCommand(["register", "--registry-asset", AGENT, "--api-url", "http://agent.test", "--name", "A", "--payment-vkh", NODE]);
    await expect(run(cmd, deps, "")).rejects.toThrow(/MIP-003/);
  });

  it("receipt prints totals and lines", async () => {
    const { deps, out } = harness({
      [`GET /v1/trees/${TREE}/receipt`]: () => ({
        status: 200,
        body: {
          tree_id: TREE,
          balanced: true,
          deposits: { asset: "lovelace", amount: "150000000" },
          payouts: { asset: "lovelace", amount: "140000000" },
          refunds: { asset: "lovelace", amount: "10000000" },
          fees: { asset: "lovelace", amount: "0" },
          lines: [{ node_id: NODE, kind: "fee", to: "addr_test1qq", value: { asset: "lovelace", amount: "140000000" }, tx_id: "9".repeat(64) }],
          key: "k",
          signature: "s",
        },
      }),
    });
    await run(parseCommand(["receipt", TREE]), deps, "");
    const text = out.join("\n");
    expect(text).toContain("balanced");
    expect(text).toContain("payouts   140 ADA");
    expect(text).toContain("fee          140 ADA");
  });

  it("tree watch redraws on each event and stops on interrupt", async () => {
    let fire: () => void = () => undefined;
    let stop: () => void = () => undefined;
    let closed = false;
    let url = "";
    const { deps, out, calls } = harness(
      { [`GET /v1/trees/${TREE}`]: () => ({ status: 200, body: tree }) },
      {
        subscribe: (u, onEvent) => {
          url = u;
          fire = onEvent;
          return () => {
            closed = true;
          };
        },
        untilInterrupted: () =>
          new Promise<void>((r) => {
            stop = r;
          }),
      },
    );
    const done = run(parseCommand(["tree", "watch", TREE]), deps, "");
    await new Promise((r) => setTimeout(r, 20));
    fire();
    await new Promise((r) => setTimeout(r, 20));
    stop();
    await done;
    expect(url).toBe(`ws://indexer.test/v1/ws?tree_id=${TREE}`);
    expect(calls.filter((c) => c === `GET /v1/trees/${TREE}`)).toHaveLength(2);
    expect(out.join("\n")).toContain("Submitted");
    expect(closed).toBe(true);
  });

  it("init agent writes a template and refuses a non-empty directory", async () => {
    const { deps, cwd } = harness({});
    await run(parseCommand(["init", "agent", "--template", "ts", "--name", "demo-agent"]), deps, "");
    expect(readdirSync(join(cwd, "demo-agent")).sort()).toEqual(["README.md", "package.json", "src", "tsconfig.json"]);
    expect(readFileSync(join(cwd, "demo-agent", "src", "main.ts"), "utf8")).toContain("cascadeAgent({");
    await expect(run(parseCommand(["init", "agent", "--template", "crewai", "--name", "demo-agent"]), deps, "")).rejects.toThrow(/not empty/);
  });
});

describe("deployment files", () => {
  it("maps deploy-scripts output to SDK reference refs and needs every script", () => {
    const ref = (i: number) => ({ referenceUtxo: { txHash: String(i).repeat(64), outputIndex: 0 } });
    const scripts = {
      cascade_node: ref(1),
      cascade_logic_core: ref(2),
      cascade_logic_draw: ref(3),
      cascade_config: ref(4),
      cascade_bond: ref(5),
      cascade_channel: ref(6),
      cascade_logic_ext: ref(7),
    };
    expect(referenceRefs({ scripts })?.logicCore).toEqual({ txHash: "2".repeat(64), outputIndex: 0 });
    const { cascade_channel: _missing, ...partial } = scripts;
    expect(referenceRefs({ scripts: partial })).toBeNull();
  });
});
