/** Per-agent runtime settings from the environment. */
import type { CardanoNetwork } from "@cascade/agent";
import { LlmClient, llmOptionsFromEnv } from "@cascade/orchestrator/llm";
import { AGENT_ROLES, type AgentRoleName } from "./roles.js";
import { cascadeNetworkFromEnv, env, envKey, loadEnv } from "./env.js";

const REGISTRY_POLICY_V2 = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b";

export interface AgentRuntime {
  role: AgentRoleName;
  port: number;
  baseUrl: string;
  network: CardanoNetwork;
  /** Masumi registry asset id; a labelled placeholder only when unregistered runs are allowed. */
  registryAsset: string;
  registered: boolean;
  asset: string;
}

export class UnregisteredAgentError extends Error {
  constructor(role: string) {
    super(`CASCADE_AGENT_ID_${envKey(role)} is not set. Register the agent (PRD 12.5) or set CASCADE_ALLOW_UNREGISTERED=1 for a local run.`);
    this.name = "UnregisteredAgentError";
  }
}

/**
 * Registry asset id of any agent role (including `lisan`, the unmodified Masumi agent) from
 * `CASCADE_AGENT_ID_<ROLE>`, or a labelled placeholder when `CASCADE_ALLOW_UNREGISTERED=1`.
 */
export function agentIdFor(role: string): { id: string; registered: boolean } {
  const id = env(`CASCADE_AGENT_ID_${envKey(role)}`);
  if (id !== undefined) return { id, registered: true };
  if (env("CASCADE_ALLOW_UNREGISTERED") !== "1") throw new UnregisteredAgentError(role);
  return { id: `${REGISTRY_POLICY_V2}${Buffer.from(`unregistered-${role}`).toString("hex")}`, registered: false };
}

/** The x402 network id this process offers and pays on: `cardano:local` is the facilitator's Yaci DevKit profile. */
export const x402NetworkFromEnv = (): CardanoNetwork => (cascadeNetworkFromEnv() === "preprod" ? "cardano:preprod" : "cardano:local");

export function runtimeFor(role: AgentRoleName): AgentRuntime {
  loadEnv();
  const key = envKey(role);
  const port = Number(env(`CASCADE_${key}_PORT`) ?? AGENT_ROLES[role].port);
  const { id, registered } = agentIdFor(role);
  return {
    role,
    port,
    baseUrl: env(`CASCADE_${key}_BASE_URL`) ?? `http://127.0.0.1:${port}`,
    network: x402NetworkFromEnv(),
    registryAsset: id,
    registered,
    asset: env("CASCADE_TREE_ASSET") ?? "lovelace",
  };
}

export const llmFromEnv = (): LlmClient => {
  loadEnv();
  return new LlmClient(llmOptionsFromEnv());
};
