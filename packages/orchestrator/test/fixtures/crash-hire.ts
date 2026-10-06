/**
 * Child process for the A15 crash test: runs one `hire` activity against a real @cascade/agent
 * server with a Postgres hire ledger and a chain fake that counts Draws in a file. The parent runs it
 * twice: once with CASCADE_TEST_CRASH_AFTER_SIGN=payment-recorded (it must exit 86), then without.
 */
import { appendFileSync, readFileSync } from "node:fs";
import pg from "pg";
import { cascadeAgent, defaultRailRequirement, localKeySigner, type PaymentRequirements } from "@cascade/agent";
import { jcs, type NodeSpec } from "@cascade/shared/browser";
import { createActivities, type ChainActions } from "../../src/activities.js";
import { composeByMerge } from "../../src/compose.js";
import { LlmClient } from "../../src/llm.js";
import { PostgresHireLedger } from "../../src/state/postgres.js";

const [dbUrl, prefix, drawsFile, jobsFile] = process.argv.slice(2) as [string, string, string, string];
const signer = localKeySigner(new Uint8Array(32).fill(3));
const offer = (amount: string, asset: string): PaymentRequirements[] => [defaultRailRequirement({ network: "cardano:preprod", payTo: signer.address, amount, asset })];
// The "agent" remembers paid jobs across both processes in a file, like a real agent's own store.
const agent = cascadeAgent({
  name: "Worker",
  description: "Works.",
  baseUrl: "http://worker.test",
  registryAsset: `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b02`,
  network: "cardano:preprod",
  inputSchema: { input_data: [{ id: "context", type: "textarea", name: "Context" }] },
  outputSchema: { type: "object" },
  handler: async () => ({ result: { ok: true } }),
  pricing: { asset: "lovelace", amount: "1000000", etaMs: 1_000 },
  rails: ["native"],
  capabilities: { roles: ["specialist"], categories: ["research"], maxDepth: 1, bondLovelace: "0" },
  signer,
  payments: {
    verifier: {
      verify: async () => ({ isValid: true, node: { tree_id: "11".repeat(28), node_id: "22".repeat(28) } }),
      settle: async (payload) => {
        appendFileSync(jobsFile, `${jcs(payload)}\n`);
        return { success: true, network: "cardano:preprod", transaction: "ab".repeat(32) };
      },
    },
    requirements: { offer: async (c) => offer(c.amount, c.asset), match: async (a, c) => offer(c.amount, c.asset).find((r) => jcs(r) === jcs(a)) ?? null, discovery: () => offer("1000000", "lovelace") },
  },
});
const chain = {
  draw: async (i: { offer: PaymentRequirements[] }) => {
    appendFileSync(drawsFile, "draw\n");
    return { node_id: "22".repeat(28), tx_id: "cd".repeat(32), submit_by: Date.now() + 60_000, challenge_until: Date.now() + 120_000, payment: { x402Version: 2 as const, accepted: i.offer[0]!, payload: { transaction: "84a4", nonce: `${"ef".repeat(32)}#0` } } };
  },
  awaitTx: async () => undefined,
} as unknown as ChainActions;
const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
const activities = createActivities({
  chain,
  directory: { resolve: async () => ({ base_url: "http://worker.test", payment_address: signer.address }) },
  compose: composeByMerge,
  llm: new LlmClient({}),
  fetch: async (u, init) => agent.fetch(new Request(String(u), init)),
  ledger: new PostgresHireLedger(pool, prefix),
  activityKey: () => "wf-crash/activity-1",
  heartbeat: () => undefined,
});
const record = await activities.hire({
  tree_id: "11".repeat(28),
  parent_node_id: "11".repeat(28),
  spec: { id: "research", task: "Research", rail: "native" } as unknown as NodeSpec,
  agent: { agent_id: "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b02", quote_id: null, price: "1000000" },
  input: {},
});
process.stdout.write(`${JSON.stringify({ node_id: record.node_id, draws: readFileSync(drawsFile, "utf8").trim().split("\n").length })}\n`);
await pool.end();
agent.close();
