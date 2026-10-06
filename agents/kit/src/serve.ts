/** Starts an agent and prints where it listens and how it signs. Never prints secrets. */
import type { CascadeAgent } from "@cascade/agent";
import type { AgentRuntime } from "./config.js";
import type { SignerSource } from "./signer.js";

export function serveAgent(agent: CascadeAgent, runtime: AgentRuntime, signerSource: SignerSource, notice?: string): void {
  agent.listen(runtime.port, "0.0.0.0");
  const lines = [
    `${runtime.role} listening on ${runtime.baseUrl}`,
    `  registry asset: ${runtime.registryAsset}${runtime.registered ? "" : " (unregistered placeholder, local run only)"}`,
    `  signer: ${signerSource}`,
  ];
  if (notice !== undefined) lines.push(`  ${notice}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  const stop = () => {
    agent.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/**
 * x402 plug-ins for `/jobs`. `@cascade/x402` (W2) supplies the verifier and the `script` and
 * `masumi` requirement builders; until it is wired, agents answer `/jobs` with 503 and say why.
 */
export const PAYMENTS_STATUS = "x402 verifier not wired: /jobs answers 503 until @cascade/x402 (W2) provides PaymentVerifier";

export const CHAIN_STATUS = "x402 script payments verified by the Cascade facilitator; on-chain Submit through the signer service";
