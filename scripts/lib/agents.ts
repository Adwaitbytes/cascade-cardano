// Public agent directory for preprod: which agents Cascade exposes, their local ports and the
// payment service each registers through. Ports come from W4's agents/kit/src/roles.ts (the source
// of truth) plus Lisan and Lisan-B, which run the unmodified CrewAI template (ports 24009, 24011).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deploymentPath, readJson, writeJson } from "./deployments.js";
import { REPO_ROOT } from "./env.js";

export const AGENTS_FILE = "agents.preprod.json";
export const LISAN_PORT = 24009;
/** Lisan-B: second copy of the unmodified template that fails every job (A4 Masumi refunds). */
export const LISAN_B_PORT = 24011;
/** The Sokosumi Coworker worker's agent endpoint (agents/cascade-coworker). */
export const COWORKER_PORT = 24012;

export type MasumiServiceId = "orchestrator" | "lisan" | "lisan-b";

export interface PublicAgent {
  agent: string;
  localPort: number;
  /** Masumi payment service instance id in deployments/masumi.preprod.json. */
  paymentService: MasumiServiceId;
  /** Registers itself (Dynamic pricing, agents/cascade-coworker/scripts/register.ts), not through register-agents.ts. */
  registersItself?: true;
}

/** Parses `name: { accountIndex: N, port: P }` entries from agents/kit/src/roles.ts. */
export function readAgentPorts(rolesSource: string): { agent: string; port: number }[] {
  const out: { agent: string; port: number }[] = [];
  const re = /^\s*"?([a-z][a-z0-9-]*)"?:\s*\{\s*accountIndex:\s*\d+,\s*port:\s*(\d+)\s*\}/gm;
  for (const m of rolesSource.matchAll(re)) out.push({ agent: m[1] as string, port: Number(m[2]) });
  return out;
}

/**
 * `CASCADE_<ROLE>_PORT` and `CASCADE_<ROLE>_BASE_URL` for every role, shifted by `offset`. Every
 * local agent gets the whole map: the reference directory resolves a peer's base URL from these, so
 * an agent that only knows its own port hires the preprod agent on the default 240xx port, and one
 * that inherits the repo .env's public BASE_URL hires the preprod agent through its tunnel.
 */
export function agentPortEnv(roles: { agent: string; port: number }[], offset: number): Record<string, string> {
  return Object.fromEntries(
    roles.flatMap((r) => {
      const key = r.agent.toUpperCase().replace(/[^A-Z0-9]/g, "_");
      const port = r.port + offset;
      return [
        [`CASCADE_${key}_PORT`, String(port)],
        [`CASCADE_${key}_BASE_URL`, `http://127.0.0.1:${port}`],
      ];
    }),
  );
}

export function publicAgents(): PublicAgent[] {
  const rolesPath = resolve(REPO_ROOT, "agents", "kit", "src", "roles.ts");
  if (!existsSync(rolesPath)) throw new Error("agents/kit/src/roles.ts not found");
  const roles = readAgentPorts(readFileSync(rolesPath, "utf8"));
  if (roles.length === 0) throw new Error("no agent ports found in agents/kit/src/roles.ts");
  return [
    ...roles.map((r): PublicAgent => ({ agent: r.agent, localPort: r.port, paymentService: "orchestrator" })),
    { agent: "lisan", localPort: LISAN_PORT, paymentService: "lisan" },
    { agent: "lisan-b", localPort: LISAN_B_PORT, paymentService: "lisan-b" },
    { agent: "cascade-coworker", localPort: COWORKER_PORT, paymentService: "orchestrator", registersItself: true },
  ];
}

/** Where an agent is reachable right now (git-ignored runtime file). */
export interface ExposedAgent {
  agent: string;
  localPort: number;
  publicUrl: string;
  /** Result of GET <publicUrl>/availability when last checked. */
  availability: "ok" | "not-answering";
}

export interface AgentsRuntime {
  network: "preprod";
  /** gateway-ngrok: stable domain; gateway-quick: one Cloudflare quick tunnel to the gateway;
   * per-agent-quick: one quick tunnel per agent (the first registration round). */
  mode: "gateway-ngrok" | "gateway-quick" | "gateway-local" | "per-agent-quick";
  gatewayPort: number | null;
  publicBase: string | null;
  startedAt: string;
  agents: ExposedAgent[];
}

export interface Registration {
  agent: string;
  name: string;
  paymentService: MasumiServiceId;
  registryRequestId: string;
  agentIdentifier: string | null;
  state: string;
  txHash: string | null;
  apiBaseUrl: string;
  /**
   * Key hash the agent is paid to and signs quotes with: the Masumi selling wallet for template
   * agents (Lisan, Lisan-B), the role key for Cascade agents. The Directory must seed from this,
   * not from the wallets file: Lisan's role key is not the key it sells with.
   */
  paymentVkh: string;
  pricing: { asset: string; amount: string }[];
  onChainVerified: boolean;
  updatedAt: string;
}

/** Committed registration facts only; live URLs live in the runtime file. */
export interface AgentsFile {
  network: "preprod";
  note: string;
  registrations: Registration[];
}

export const AGENTS_RUNTIME_FILE = "agents.preprod.runtime.json";

export function readAgentsFile(): AgentsFile {
  const empty: AgentsFile = {
    network: "preprod",
    note: "Registry facts. Live public URLs are in the git-ignored deployments/agents.preprod.runtime.json (scripts/agents-gateway.ts).",
    registrations: [],
  };
  if (!existsSync(deploymentPath(AGENTS_FILE))) return empty;
  const raw = readJson(AGENTS_FILE) as Partial<AgentsFile>;
  return { network: "preprod", note: empty.note, registrations: raw.registrations ?? [] };
}

export function writeAgentsFile(file: AgentsFile): void {
  writeJson(AGENTS_FILE, file);
}

export function readAgentsRuntime(): AgentsRuntime | null {
  if (!existsSync(deploymentPath(AGENTS_RUNTIME_FILE))) return null;
  return readJson(AGENTS_RUNTIME_FILE) as AgentsRuntime;
}

export function writeAgentsRuntime(runtime: AgentsRuntime): void {
  writeJson(AGENTS_RUNTIME_FILE, runtime);
}
