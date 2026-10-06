/**
 * Dry planning run: plans a goal with the configured planner LLM and the Conductor's agent source,
 * then checks every hired slot's output schema against the schema its agent serves live at
 * `/output_schema`. No plan is stored, funded or sent anywhere. Exit 0 only when every native slot
 * matches its live agent.
 *
 * Usage: npx tsx agents/conductor/scripts/plan-dry.ts ["goal"]
 * Env (from .env, read in code): planner LLM keys, CASCADE_AGENT_ID_*, CASCADE_NETWORK.
 * Default goal: the demo job description (demo/record.ts).
 */
import { agentIdFor, cascadeNetworkFromEnv, env, llmFromEnv, referenceDirectory } from "@cascade/agent-kit";
import { planJob } from "@cascade/orchestrator";
import { planNodesPreOrder } from "@cascade/shared/browser";
import { referenceAgentSource, referenceVerifierKeys, type ReferenceAgentIds } from "../src/agent.js";

const DEMO_GOAL = "Market-entry brief for cold-pressed juice in Dubai, with a competitor price table, an Arabic summary and a fact check.";
const goal = process.argv[2] ?? DEMO_GOAL;
const network = cascadeNetworkFromEnv();
const roles = ["conductor", "scout", "pricer", "lookup-api", "flaky-lisan", "lisan", "checker-a", "checker-b", "checker-c", "scribe"] as const;
const ids = Object.fromEntries(roles.map((r) => [r, agentIdFor(r).id])) as unknown as ReferenceAgentIds;
const directory = referenceDirectory(network);
const now = Date.now();

const planned = await planJob(
  { goal, asset: "lovelace", budget: "150000000", fund_by: now + 30 * 60_000, submit_by: now + 6 * 3_600_000, max_depth: 3, reputation_floor: 0.6, risk: "balanced" },
  { llm: llmFromEnv(), agents: referenceAgentSource(ids), verifierKeyOf: referenceVerifierKeys({ a: "61".repeat(28), b: "62".repeat(28), c: "63".repeat(28) }), masumiPurchaserHash: "9f".repeat(28) },
);

const rows: { slot: string; rail: string; agent: string; schema: "matches live agent" | "Masumi string result" | "MISMATCH" | "unreachable" }[] = [];
for (const { node } of planNodesPreOrder(planned.built.plan.root).slice(1)) {
  const role = roles.find((r) => ids[r] === node.agents.primary.agent_id) ?? node.agents.primary.agent_id;
  if (node.spec.masumi_followup !== undefined) {
    rows.push({ slot: node.spec.id, rail: node.spec.rail, agent: role, schema: "Masumi string result" });
    continue;
  }
  try {
    const { base_url } = await directory.resolve(node.agents.primary.agent_id);
    const res = await fetch(`${base_url.replace(/\/$/, "")}/output_schema`, { signal: AbortSignal.timeout(15_000) });
    const live: unknown = res.ok ? await res.json() : null;
    rows.push({ slot: node.spec.id, rail: node.spec.rail, agent: role, schema: JSON.stringify(live) === JSON.stringify(node.spec.output_schema) ? "matches live agent" : "MISMATCH" });
  } catch {
    rows.push({ slot: node.spec.id, rail: node.spec.rail, agent: role, schema: "unreachable" });
  }
}
console.table(rows);
const bad = rows.filter((r) => r.schema === "MISMATCH" || r.schema === "unreachable");
process.stdout.write(`${JSON.stringify({ goal, llm: planned.llm, fallback_reason: planned.fallback_reason ?? null, plan_root: planned.built.plan.plan_root, slots: rows.length, bad: bad.map((r) => r.slot) })}\n`);
process.exit(bad.length === 0 ? 0 : 1);
