import { describe, expect, it } from "vitest";
import { booleanEnv, InvalidEnvError, MissingEnvError, requireEnv } from "../lib/env.js";
import { FUNDING_TARGETS_ADA, LOVELACE_PER_ADA, planTopUps, totalTopUp } from "../lib/funding.js";
import { networkFromArgv, parseNetwork, UnsupportedNetworkError } from "../lib/network.js";
import { deriveAllWallets, deriveWallet, RESERVED_ACCOUNT_INDICES, WALLET_ROLES, type DerivedWallet } from "../lib/wallets.js";

// Yaci DevKit's published default mnemonic. Public test data, not a secret.
const YACI_DEFAULT_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const YACI_ADDRESS_0 =
  "addr_test1qryvgass5dsrf2kxl3vgfz76uhp83kv5lagzcp29tcana68ca5aqa6swlq6llfamln09tal7n5kvt4275ckwedpt4v7q48uhex";

describe("network guard", () => {
  it("accepts local and preprod only", () => {
    expect(parseNetwork("local")).toBe("local");
    expect(parseNetwork("Preprod")).toBe("preprod");
    for (const bad of ["mainnet", "preview", "Mainnet", "", undefined]) {
      expect(() => parseNetwork(bad)).toThrow(UnsupportedNetworkError);
    }
  });

  it("requires an explicit --network flag", () => {
    expect(networkFromArgv(["--network", "local"])).toBe("local");
    expect(networkFromArgv(["--network=preprod"])).toBe("preprod");
    expect(() => networkFromArgv([])).toThrow(UnsupportedNetworkError);
    expect(() => networkFromArgv(["--network", "mainnet"])).toThrow(UnsupportedNetworkError);
  });
});

describe("env getters", () => {
  it("names the variable, never the value", () => {
    delete process.env.CASCADE_TEST_UNSET;
    expect(() => requireEnv("CASCADE_TEST_UNSET")).toThrow(MissingEnvError);
    expect(() => requireEnv("CASCADE_TEST_UNSET")).toThrow("CASCADE_TEST_UNSET");
    process.env.CASCADE_TEST_BOOL = "secret-looking-value";
    try {
      booleanEnv("CASCADE_TEST_BOOL", false);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEnvError);
      expect((error as Error).message).not.toContain("secret-looking-value");
    }
    delete process.env.CASCADE_TEST_BOOL;
  });
});

describe("wallet derivation", () => {
  it("has 44 roles with unique, ascending account indices that skip reserved ones", () => {
    const indices = WALLET_ROLES.map((r) => r.accountIndex);
    expect(indices).toEqual([...Array(45).keys()].filter((i) => !RESERVED_ACCOUNT_INDICES.includes(i)));
    expect(new Set(WALLET_ROLES.map((r) => r.role)).size).toBe(44);
  });

  it("gives each acceptance test A1 to A20 its own buyer role, buyer-a01 at index 24 through buyer-a20 at 43", () => {
    const buyers = WALLET_ROLES.filter((r) => r.role.startsWith("buyer-a"));
    expect(buyers.map((r) => r.role)).toEqual(Array.from({ length: 20 }, (_, i) => `buyer-a${String(i + 1).padStart(2, "0")}`));
    expect(buyers.map((r) => r.accountIndex)).toEqual(Array.from({ length: 20 }, (_, i) => 24 + i));
  });

  it("reproduces Yaci's default address #0 at account index 0", () => {
    const w = deriveWallet(YACI_DEFAULT_MNEMONIC, "treasury", "local");
    expect(w.address).toBe(YACI_ADDRESS_0);
    expect(w.paymentKeyHash).toMatch(/^[0-9a-f]{56}$/);
    expect(w.stakeKeyHash).toMatch(/^[0-9a-f]{56}$/);
  });

  it("derives identical keys on local and preprod", () => {
    expect(deriveAllWallets(YACI_DEFAULT_MNEMONIC, "local")).toEqual(deriveAllWallets(YACI_DEFAULT_MNEMONIC, "preprod"));
  });
});

describe("top-up planner", () => {
  const wallets: DerivedWallet[] = deriveAllWallets(YACI_DEFAULT_MNEMONIC, "preprod");
  const ada = (n: number): bigint => BigInt(n) * LOVELACE_PER_ADA;

  it("funds every non-treasury role from zero on preprod", () => {
    const balances = new Map(wallets.map((w) => [w.address, 0n]));
    const plan = planTopUps(wallets, balances, "preprod");
    expect(plan.map((t) => t.role)).not.toContain("treasury");
    // Roles with a zero target (acceptance buyers that never sign on preprod) are derived, not funded.
    const unfunded = Object.entries(FUNDING_TARGETS_ADA).filter(([, ada]) => ada === 0).map(([role]) => role);
    expect(unfunded).toEqual(["buyer-a16", "buyer-a17", "buyer-a20"]);
    expect(plan).toHaveLength(43 - unfunded.length);
    const expected = Object.values(FUNDING_TARGETS_ADA).reduce((a, b) => a + b, 0);
    expect(totalTopUp(plan)).toBe(ada(expected));
  });

  it("includes the treasury on local", () => {
    const balances = new Map(wallets.map((w) => [w.address, 0n]));
    expect(planTopUps(wallets, balances, "local").map((t) => t.role)).toContain("treasury");
  });

  it("skips wallets at or above 90% of target and tops the rest up to target", () => {
    const buyer = wallets.find((w) => w.role === "buyer")!;
    const scout = wallets.find((w) => w.role === "scout")!;
    const balances = new Map(wallets.map((w) => [w.address, ada(FUNDING_TARGETS_ADA[w.role as "buyer"] ?? 0)]));
    balances.set(buyer.address, ada(2700));
    balances.set(scout.address, ada(150));
    const plan = planTopUps(wallets, balances, "preprod");
    expect(plan).toEqual([
      { role: "scout", address: scout.address, currentLovelace: ada(150), targetLovelace: ada(200), topUpLovelace: ada(50) },
    ]);
  });
});

describe("script deployment order", () => {
  it("lists every parameter before the script that takes it", async () => {
    const { CASCADE_SCRIPTS, SCRIPT_PARAMETERS, STAKE_SCRIPTS } = await import("../lib/blueprint.js");
    CASCADE_SCRIPTS.forEach((name, i) => {
      for (const dep of SCRIPT_PARAMETERS[name]) expect(CASCADE_SCRIPTS.indexOf(dep)).toBeLessThan(i);
    });
    expect(SCRIPT_PARAMETERS.cascade_node).toEqual([
      "cascade_config",
      "cascade_bond",
      "cascade_channel",
      "cascade_logic_core",
      "cascade_logic_draw",
      "cascade_logic_ext",
    ]);
    expect([...STAKE_SCRIPTS]).toEqual(["cascade_logic_core", "cascade_logic_draw", "cascade_logic_ext"]);
  });
});

describe("public agents", () => {
  it("reads every agent port from agents/kit/src/roles.ts and adds Lisan", async () => {
    const { publicAgents, readAgentPorts } = await import("../lib/agents.js");
    expect(readAgentPorts('  "lookup-api": { accountIndex: 5, port: 24004 },\n  scout: { accountIndex: 3, port: 24002 },')).toEqual([
      { agent: "lookup-api", port: 24004 },
      { agent: "scout", port: 24002 },
    ]);
    const agents = publicAgents();
    expect(agents.find((a) => a.agent === "lisan")).toEqual({ agent: "lisan", localPort: 24009, paymentService: "lisan" });
    expect(agents.filter((a) => a.paymentService === "orchestrator").length).toBeGreaterThanOrEqual(8);
    expect(new Set(agents.map((a) => a.localPort)).size).toBe(agents.length);
  });
});

// Regression: the local stack gave each agent only its own port, so the local Conductor resolved
// Scout to the preprod default 24002; the preprod Scout's facilitator then looked for the devnet
// Draw's nonce on preprod and every local hire failed with nonce_not_on_chain.
describe("local agent ports", () => {
  it("gives every local agent every peer's shifted port, matching the kit's env keys", async () => {
    const { agentPortEnv, readAgentPorts } = await import("../lib/agents.js");
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { REPO_ROOT } = await import("../lib/env.js");
    const roles = readAgentPorts(readFileSync(resolve(REPO_ROOT, "agents", "kit", "src", "roles.ts"), "utf8"));
    const env = agentPortEnv(roles, 10_000);
    expect(env["CASCADE_SCOUT_PORT"]).toBe("34002");
    expect(env["CASCADE_LOOKUP_API_PORT"]).toBe("34004");
    expect(env["CASCADE_CHECKER_C_PORT"]).toBe("34010");
    expect(Object.keys(env)).toHaveLength(2 * roles.length);
    const ports = Object.entries(env).filter(([k]) => k.endsWith("_PORT")).map(([, v]) => Number(v));
    expect(ports.every((p) => p >= 34_000 && p < 35_000)).toBe(true);
  });

  // Regression: the repo .env names each agent's public tunnel URL (CASCADE_<ROLE>_BASE_URL) for the
  // preprod agents; the local Scout inherited it and hired the preprod checkers, whose hires timed out.
  it("pins every peer's base URL to its local port, over the .env's public URLs", async () => {
    const { agentPortEnv, readAgentPorts } = await import("../lib/agents.js");
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { REPO_ROOT } = await import("../lib/env.js");
    const roles = readAgentPorts(readFileSync(resolve(REPO_ROOT, "agents", "kit", "src", "roles.ts"), "utf8"));
    const env = agentPortEnv(roles, 10_000);
    expect(env["CASCADE_CHECKER_A_BASE_URL"]).toBe("http://127.0.0.1:34006");
    expect(env["CASCADE_CONDUCTOR_BASE_URL"]).toBe("http://127.0.0.1:34001");
    for (const r of roles) expect(env[`CASCADE_${r.agent.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BASE_URL`]).toBe(`http://127.0.0.1:${r.port + 10_000}`);
  });
});

describe("agents gateway routing", () => {
  it("strips the agent prefix and keeps the query", async () => {
    const { routeRequest } = await import("../agents-gateway.js");
    const ports = new Map([
      ["scout", 24002],
      ["lisan", 24009],
    ]);
    expect(routeRequest("/scout/availability", ports)).toEqual({ port: 24002, path: "/availability" });
    expect(routeRequest("/lisan/status?job_id=7", ports)).toEqual({ port: 24009, path: "/status?job_id=7" });
    expect(routeRequest("/scout", ports)).toEqual({ port: 24002, path: "/" });
    expect(routeRequest("/unknown/availability", ports)).toBeNull();
    expect(routeRequest("/../etc/passwd", ports)).toBeNull();
  });
});
