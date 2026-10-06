/**
 * Allowlists the reference agents in the local indexer's Directory. The local Conductor plans with
 * the registered agent ids (CASCADE_AGENT_ID_* from scripts/register-agents.ts, recorded in
 * deployments/agents.preprod.json), but the local indexer only seeds its Directory from an
 * agents.local.json, which does not exist. Without these rows the signer cannot map an agent id
 * to its operator key and refuses every draw (gate 1). Each agent's operator key is its role
 * wallet in deployments/wallets.local.json, the key the local agent signs with.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { repoPath } from "../lib/repo.js";

const Registrations = z.object({
  registrations: z.array(z.looseObject({ agent: z.string(), name: z.string(), agentIdentifier: z.string() })),
});
const Wallets = z.object({ wallets: z.array(z.object({ role: z.string(), paymentKeyHash: z.string() })) });

/** Local agent ports: the preprod port in agents/kit/src/roles.ts plus 10000 (scripts/local-stack.ts). */
function localAgentPorts(): Map<string, number> {
  const source = readFileSync(repoPath("agents", "kit", "src", "roles.ts"), "utf8");
  const ports = new Map<string, number>();
  for (const m of source.matchAll(/^\s*"?([a-z][a-z0-9-]*)"?:\s*\{\s*accountIndex:\s*\d+,\s*port:\s*(\d+)\s*\}/gm)) ports.set(m[1] as string, Number(m[2]) + 10_000);
  return ports;
}

export async function allowlistLocalAgents(indexerUrl: string): Promise<number> {
  const token = readFileSync(repoPath("infra", ".data", "local", "directory-admin.token"), "utf8").trim();
  const { registrations } = Registrations.parse(JSON.parse(readFileSync(repoPath("deployments", "agents.preprod.json"), "utf8")));
  const { wallets } = Wallets.parse(JSON.parse(readFileSync(repoPath("deployments", "wallets.local.json"), "utf8")));
  const ports = localAgentPorts();
  let added = 0;
  for (const r of registrations) {
    const vkh = wallets.find((w) => w.role === r.agent)?.paymentKeyHash;
    const port = ports.get(r.agent);
    // Agents that do not run on the local stack (Lisan behind Masumi) stay out of the local Directory.
    if (vkh === undefined || port === undefined) continue;
    const res = await fetch(`${indexerUrl}/v1/admin/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent_asset_id: r.agentIdentifier, name: r.name, api_url: `http://127.0.0.1:${port}`, payment_vkh: vkh }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status !== 201) throw new Error(`allowlisting ${r.agent} in the local Directory: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    added += 1;
  }
  return added;
}
