// Registers the preprod agents on the Masumi V2 registry through their operators' Masumi Payment
// Services (POST /registry), waits for RegistrationConfirmed, verifies the NFT on chain under the V2
// registry policy, records everything in deployments/agents.preprod.json and writes each agent's
// CASCADE_AGENT_ID_<ROLE> to the repo .env (asset ids are public; no value is printed from .env).
//
//   Lisan                 -> Lisan operator's service (localhost:23101), its selling wallet
//   Cascade reference set -> orchestrator operator's service (localhost:23100), its selling wallet
//
// API base URLs are the public gateway URLs from agents-gateway.ts (runtime file). Idempotent: an agent already
// confirmed with the same URL is skipped; a confirmed agent whose URL changed is updated through
// POST /registry/update (the V2 contract burns the old NFT and mints a replacement, so its
// identifier changes and .env is rewritten).
//
// Usage: tsx register-agents.ts [--only scout,lisan]
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddressDetails } from "@lucid-evolution/lucid";
import { parse } from "dotenv";
import { publicAgents, readAgentsFile, readAgentsRuntime, writeAgentsFile, type MasumiServiceId, type PublicAgent, type Registration } from "./lib/agents.js";
import { readJson } from "./lib/deployments.js";
import { REPO_ROOT, requireEnv } from "./lib/env.js";

const REGISTRY_POLICY_V2 = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b";
const V2_ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
/** Preprod tUSDM (docs/research/sokosumi.md); Sokosumi lists preprod agents priced in it. */
const TUSDM_PREPROD = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";
const KOIOS = "https://preprod.koios.rest/api/v1";
const POLL_MS = 20_000;
const CONFIRM_TIMEOUT_MS = 40 * 60_000;

interface AgentProfile {
  name: string;
  description: string;
  tags: string[];
  /**
   * Payment options. Cascade agents offer tUSDM (Sokosumi listing) and lovelace (tADA-funded trees).
   * Masumi template agents (Lisan, Lisan-B) take lovelace only: their payment service requests the
   * first registry price, which must match the lovelace amount their /start_job reports.
   */
  tusdm: string | null;
  lovelace: string;
}

const AUTHOR = { name: "Cascade", organization: "Cascade (TOKEN2049 Origins build)", contactOther: "https://github.com/Adwaitbytes/cascade" };

const PROFILES: Record<string, AgentProfile> = {
  conductor: {
    name: "Cascade Conductor",
    description: "Orchestrator: plans a goal into an escrow tree of hired agents, prices it, and returns the plan to fund.",
    tags: ["orchestration", "planning", "cascade"],
    tusdm: "2000000",
    lovelace: "5000000",
  },
  scout: {
    name: "Cascade Scout",
    description: "Market researcher: competitors, positioning and sourced findings; hires Pricer for a competitor price table.",
    tags: ["research", "market", "cascade"],
    tusdm: "1000000",
    lovelace: "3000000",
  },
  pricer: {
    name: "Cascade Pricer",
    description: "Collects competitor retail prices by buying per-call lookups from an x402 data API.",
    tags: ["pricing", "data", "cascade"],
    tusdm: "1000000",
    lovelace: "3000000",
  },
  "lookup-api": {
    name: "Cascade Lookup API",
    description: "One price lookup by brand, sold per call.",
    tags: ["data", "lookup", "cascade"],
    tusdm: "100000",
    lovelace: "1000000",
  },
  "flaky-lisan": {
    name: "Flaky Lisan (test agent)",
    description: "Test agent: fails on purpose to demonstrate refunds. Arabic translator configured to time out.",
    tags: ["test", "translation", "cascade"],
    tusdm: "1000000",
    lovelace: "3000000",
  },
  "checker-a": {
    name: "Cascade Checker A",
    description: "Verifier: checks a submitted result against its spec and signs a verdict.",
    tags: ["verification", "cascade"],
    tusdm: "500000",
    lovelace: "2000000",
  },
  "checker-b": {
    name: "Cascade Checker B",
    description: "Second verifier on a different model provider; checks a submitted result and signs a verdict.",
    tags: ["verification", "cascade"],
    tusdm: "500000",
    lovelace: "2000000",
  },
  "checker-c": {
    name: "Cascade Checker C",
    description: "Third verifier for 2-of-3 quorum acceptance; checks a submitted result and signs a verdict.",
    tags: ["verification", "cascade"],
    tusdm: "500000",
    lovelace: "2000000",
  },
  scribe: {
    name: "Cascade Scribe",
    description: "Writes the final brief and an executive summary from verified research.",
    tags: ["writing", "summary", "cascade"],
    tusdm: "1000000",
    lovelace: "3000000",
  },
  lisan: {
    name: "Lisan",
    description: "Unmodified Masumi CrewAI quickstart agent: researches and summarises the text it is given.",
    tags: ["translation", "research", "crewai"],
    tusdm: null,
    lovelace: "10000000",
  },
  "lisan-b": {
    name: "Lisan-B (test agent: fails on purpose)",
    description:
      "Test agent: fails on purpose to demonstrate Masumi refunds. Unmodified Masumi CrewAI quickstart configured with an invalid model, so every job errors and no result is ever submitted.",
    tags: ["test", "refund-demo", "crewai"],
    tusdm: null,
    lovelace: "10000000",
  },
};

interface MasumiInstance {
  id: MasumiServiceId;
  apiBase: string;
  adminKeyEnv: string;
  v2SellingWallet: string;
}

interface RegistryEntry {
  id: string;
  name: string;
  apiBaseUrl: string | null;
  state: string;
  agentIdentifier: string | null;
  error: string | null;
  CurrentTransaction: { txHash: string | null } | null;
}

class Service {
  readonly sellingVkey: string;

  constructor(readonly instance: MasumiInstance) {
    const hash = getAddressDetails(instance.v2SellingWallet).paymentCredential?.hash;
    if (hash === undefined) throw new Error(`${instance.id} selling wallet has no payment key hash`);
    this.sellingVkey = hash;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.instance.apiBase}${path}`, {
      method,
      headers: { token: requireEnv(this.instance.adminKeyEnv), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${this.instance.id} ${method} ${path} answered ${res.status}: ${text.slice(0, 400)}`);
    return (JSON.parse(text) as { data: T }).data;
  }

  async entries(): Promise<RegistryEntry[]> {
    const q = new URLSearchParams({ network: "Preprod", filterPaymentSourceType: "Web3CardanoV2", limit: "100" });
    return (await this.call<{ Assets: RegistryEntry[] }>("GET", `/registry?${q.toString()}`)).Assets;
  }

  register(body: Record<string, unknown>): Promise<RegistryEntry> {
    return this.call("POST", "/registry", { ...body, sellingWalletVkey: this.sellingVkey });
  }

  update(body: Record<string, unknown>, agentIdentifier: string): Promise<RegistryEntry> {
    return this.call("POST", "/registry/update", { ...body, agentIdentifier, smartContractAddress: V2_ESCROW });
  }
}

function registryBody(profile: AgentProfile, apiBaseUrl: string): Record<string, unknown> {
  const source = (asset: string, amount: string) => ({
    chain: "Cardano",
    network: "Preprod",
    paymentSourceType: "Web3CardanoV2",
    address: V2_ESCROW,
    pricing: { pricingType: "Fixed", fixed: [{ asset, amount }] },
  });
  return {
    network: "Preprod",
    name: profile.name,
    description: profile.description,
    apiBaseUrl,
    Tags: profile.tags,
    Capability: { name: "cascade-agent", version: "0.1.0" },
    Author: AUTHOR,
    Legal: { other: "Preprod testnet agent for the Cascade hackathon build. No real funds." },
    ExampleOutputs: [],
    supportedPaymentSources: [...(profile.tusdm === null ? [] : [source(TUSDM_PREPROD, profile.tusdm)]), source("", profile.lovelace)],
  };
}

const CONFIRMED = new Set(["RegistrationConfirmed", "UpdateConfirmed"]);
const FAILED = new Set(["RegistrationFailed", "UpdateFailed"]);

async function verifyOnChain(agentIdentifier: string): Promise<{ ok: boolean; mintTx: string | null }> {
  const policy = agentIdentifier.slice(0, 56);
  const name = agentIdentifier.slice(56);
  if (policy !== REGISTRY_POLICY_V2) return { ok: false, mintTx: null };
  const res = await fetch(`${KOIOS}/asset_info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ _asset_list: [[policy, name]] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Koios asset_info answered ${res.status}`);
  const rows = (await res.json()) as { total_supply?: string; minting_tx_hash?: string }[];
  const row = rows[0];
  return { ok: row !== undefined && row.total_supply === "1", mintTx: row?.minting_tx_hash ?? null };
}

/** Sets KEY='value' lines in the repo .env, replacing existing keys, keeping mode 600. */
function setEnvValues(values: Record<string, string>): void {
  const path = resolve(REPO_ROOT, ".env");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const existing = parse(text);
  let lines = text.split("\n");
  for (const [key, value] of Object.entries(values)) {
    if (!/^[0-9a-f]+$/.test(value)) throw new Error(`refusing to write a non-hex value for ${key}`);
    const line = `${key}='${value}'`;
    if (key in existing) lines = lines.map((l) => (new RegExp(`^\\s*${key}\\s*=`).test(l) ? line : l));
    else lines.splice(lines.length > 0 && lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, line);
  }
  writeFileSync(path, lines.join("\n").replace(/\n?$/, "\n"));
  chmodSync(path, 0o600);
}

/** Masumi template agents are paid to their payment service's selling wallet; Cascade agents to their role key. */
function paymentVkhOf(agent: PublicAgent, service: Service): string {
  if (agent.paymentService !== "orchestrator") return service.sellingVkey;
  const wallets = (readJson("wallets.preprod.json") as { wallets: { role: string; paymentKeyHash: string }[] }).wallets;
  const vkh = wallets.find((w) => w.role === agent.agent)?.paymentKeyHash;
  if (vkh === undefined) throw new Error(`no wallet role ${agent.agent} in deployments/wallets.preprod.json`);
  return vkh;
}

const envKey = (role: string): string => role.toUpperCase().replace(/[^A-Z0-9]/g, "_");

async function main(): Promise<void> {
  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex >= 0 ? new Set((process.argv[onlyIndex + 1] ?? "").split(",")) : null;
  const { instances } = readJson("masumi.preprod.json") as { instances: MasumiInstance[] };
  const services = new Map(instances.map((i) => [i.id, new Service(i)]));
  const runtime = readAgentsRuntime();
  if (runtime === null) throw new Error("deployments/agents.preprod.runtime.json is missing; run agents-gateway.ts first");
  // Re-registering burns and re-mints the registry NFT (new agent id), so a URL change is applied
  // only when asked for explicitly.
  const updateUrls = process.argv.includes("--update-urls");
  // --update re-applies the profile (pricing, description) to a confirmed entry even when its URL is current.
  const forceUpdate = process.argv.includes("--update");
  const agents = publicAgents().filter((a) => a.registersItself !== true && (only === null || only.has(a.agent)));

  const pending: { agent: PublicAgent; service: Service; apiBaseUrl: string; profile: AgentProfile; requestId: string | null }[] = [];
  for (const agent of agents) {
    const profile = PROFILES[agent.agent];
    if (profile === undefined) throw new Error(`no registry profile for ${agent.agent}`);
    const tunnel = runtime.agents.find((t) => t.agent === agent.agent);
    if (tunnel === undefined) throw new Error(`no public URL for ${agent.agent}; run agents-gateway.ts first`);
    const service = services.get(agent.paymentService);
    if (service === undefined) throw new Error(`no ${agent.paymentService} instance in deployments/masumi.preprod.json`);

    const existing = (await service.entries()).filter((e) => e.name === profile.name && !e.state.startsWith("Deregistration"));
    const live = existing.find((e) => CONFIRMED.has(e.state) || e.state.endsWith("Requested") || e.state.endsWith("Initiated"));
    const body = registryBody(profile, tunnel.publicUrl);
    let requestId: string | null = null;
    if (live === undefined) {
      const created = await service.register(body);
      requestId = created.id;
      console.log(`${agent.agent}: registration requested (${created.state})`);
    } else if (forceUpdate && CONFIRMED.has(live.state) && live.agentIdentifier !== null) {
      const updated = await service.update(body, live.agentIdentifier);
      requestId = updated.id;
      console.log(`${agent.agent}: profile update requested (${updated.state})`);
    } else if (live.apiBaseUrl === tunnel.publicUrl) {
      console.log(`${agent.agent}: already ${live.state} with this URL`);
    } else if (!updateUrls) {
      console.log(`${agent.agent}: registered at ${live.apiBaseUrl}, now served at ${tunnel.publicUrl}; rerun with --update-urls to re-register (new agent id)`);
      continue;
    } else if (CONFIRMED.has(live.state) && live.agentIdentifier !== null) {
      const updated = await service.update(body, live.agentIdentifier);
      requestId = updated.id;
      console.log(`${agent.agent}: URL changed, update requested (${updated.state})`);
    } else {
      console.log(`${agent.agent}: ${live.state} in progress with an older URL; rerun once it confirms to update it`);
    }
    pending.push({ agent, service, apiBaseUrl: tunnel.publicUrl, profile, requestId });
  }

  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  const done = new Map<string, Registration>();
  while (done.size < pending.length) {
    for (const p of pending) {
      if (done.has(p.agent.agent)) continue;
      const entries = await p.service.entries();
      // A just-requested registration or update is followed by its own id; the old confirmed
      // entry with the same URL must not count as done.
      const entry = p.requestId === null ? entries.find((e) => e.name === p.profile.name && e.apiBaseUrl === p.apiBaseUrl) : entries.find((e) => e.id === p.requestId);
      if (entry === undefined) continue;
      if (FAILED.has(entry.state)) throw new Error(`${p.agent.agent} registration failed: ${entry.error ?? entry.state}`);
      if (!CONFIRMED.has(entry.state) || entry.agentIdentifier === null) continue;
      const chain = await verifyOnChain(entry.agentIdentifier);
      done.set(p.agent.agent, {
        agent: p.agent.agent,
        name: p.profile.name,
        paymentService: p.agent.paymentService,
        registryRequestId: entry.id,
        agentIdentifier: entry.agentIdentifier,
        state: entry.state,
        txHash: entry.CurrentTransaction?.txHash ?? chain.mintTx,
        apiBaseUrl: p.apiBaseUrl,
        paymentVkh: paymentVkhOf(p.agent, p.service),
        pricing: [...(p.profile.tusdm === null ? [] : [{ asset: TUSDM_PREPROD, amount: p.profile.tusdm }]), { asset: "lovelace", amount: p.profile.lovelace }],
        onChainVerified: chain.ok,
        updatedAt: new Date().toISOString(),
      });
      console.log(`${p.agent.agent}: ${entry.state} ${entry.agentIdentifier} (on chain: ${chain.ok ? "yes" : "not yet indexed"})`);
    }
    if (done.size === pending.length) break;
    if (Date.now() > deadline) throw new Error(`timed out; confirmed ${[...done.keys()].join(", ") || "none"}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  const latest = readAgentsFile();
  const registrations = [...latest.registrations.filter((r) => !done.has(r.agent)), ...done.values()].sort((a, b) => a.agent.localeCompare(b.agent));
  writeAgentsFile({ ...latest, registrations });
  setEnvValues(Object.fromEntries([...done.values()].map((r) => [`CASCADE_AGENT_ID_${envKey(r.agent)}`, r.agentIdentifier as string])));
  console.log(`Recorded ${done.size} registrations in deployments/agents.preprod.json and CASCADE_AGENT_ID_* in .env`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
