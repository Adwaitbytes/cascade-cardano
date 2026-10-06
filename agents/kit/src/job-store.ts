/**
 * Durable job store for a reference agent: Postgres when CASCADE_AGENT_DATABASE_URL (or the shared
 * CASCADE_ORCHESTRATOR_DATABASE_URL) is set, so a restart never loses a job the agent was paid for;
 * in memory otherwise (local development and tests).
 */
import pg from "pg";
import { PostgresJobStore, type JobStore } from "@cascade/agent";
import { runtimeFor } from "./config.js";
import { env } from "./env.js";
import type { AgentRoleName } from "./roles.js";

export async function jobStoreFromEnv(role: AgentRoleName): Promise<JobStore | undefined> {
  const url = env("CASCADE_AGENT_DATABASE_URL") ?? env("CASCADE_ORCHESTRATOR_DATABASE_URL");
  if (url === undefined) return undefined;
  // Rows are scoped by the agent's registry id, so every agent can share one database.
  const store = new PostgresJobStore({ pool: new pg.Pool({ connectionString: url, max: 3 }), agentId: runtimeFor(role).registryAsset });
  await store.migrate();
  return store;
}
