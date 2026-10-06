/**
 * Cascade MCP server (PRD 15.3): lets any MCP client plan, fund and steer a Cascade agent tree.
 *
 * Money-moving tools return an unsigned transaction and a plain-language preview for the user's
 * wallet. They sign only when the host passes `sign: true` AND an agent key is configured, and
 * even then the key stays in services/signer, whose policy gates decide.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AgentIdSchema, AmountSchema, AssetIdSchema, Hex28Schema, reputationFractionFromPercent, ReputationPercentSchema } from "@cascade/shared/browser";
import { z } from "zod";
import type { ChainAccess } from "./chain.js";
import {
  ACCEPTANCE_PREFERENCES,
  ApiError,
  ConfigError,
  RISK_LEVELS,
  type BuyerAction,
  type CascadeApi,
  type PlanEnvelope,
  type PlanNode,
  type TreeSnapshot,
  type TxPreview,
  type WalletContext,
} from "./client.js";

export const SERVER_NAME = "cascade";
export const SERVER_VERSION = "0.1.0";

export interface ServerDeps {
  api: CascadeApi;
  /** Needed only for the agent-key path (`sign: true`). */
  chain: ChainAccess | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long `cascade_job_status` waits for the indexer to see a just-funded tree. Default 60 s. */
  indexWaitMs?: number;
}

/** Backoff between indexer reads of a tree it does not know yet: 1, 2, 4, 8, then every 15 s. */
const INDEX_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

const walletShape = {
  change_address: z.string().min(1).optional().describe("Buyer wallet change address (bech32). Required unless sign is true."),
  utxos: z
    .array(z.string().regex(/^[0-9a-f]+$/))
    .max(200)
    .optional()
    .describe("Buyer wallet UTxOs as CIP-30 getUtxos() CBOR hex. Required unless sign is true."),
  sign: z
    .boolean()
    .default(false)
    .describe("Sign and submit with the configured agent key through the signer service. Refused when no agent key is configured."),
};

type WalletArgs = { change_address?: string | undefined; utxos?: string[] | undefined; sign: boolean };

function text(body: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: body }], ...(structured === undefined ? {} : { structuredContent: structured }) };
}

function failure(error: unknown): CallToolResult {
  const message =
    error instanceof ApiError || error instanceof ConfigError
      ? error.message
      : error instanceof z.ZodError
        ? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        : error instanceof Error
          ? error.message
          : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    return failure(error);
  }
}

function walkPlan(node: PlanNode, depth: number, agents: PlanEnvelope["agents"], out: string[]): void {
  const primary = node.agents.primary.agent_id;
  const who = agents[primary];
  const title = node.spec.title ?? node.spec.category ?? "task";
  const budget = node.max_budget === undefined ? "" : ` budget ${node.max_budget}`;
  const rep = who === undefined ? "" : `, reputation ${Math.round(who.reputation * 100)}/100`;
  out.push(`${"  ".repeat(depth)}- ${title}:${budget} -> ${who?.name ?? primary}${rep}${node.agents.fallbacks.length > 0 ? ` (+${node.agents.fallbacks.length} fallback)` : ""}`);
  for (const child of node.children) walkPlan(child, depth + 1, agents, out);
}

export function describePlan(env: PlanEnvelope): string {
  const lines = [`Plan ${env.plan.plan_id} (${env.status}) for: ${env.goal}`, `Asset ${env.plan.asset}, fund by ${new Date(env.plan.deadlines.fund_by).toISOString()}`];
  walkPlan(env.plan.root, 0, env.agents, lines);
  return lines.join("\n");
}

export function describePreview(p: TxPreview): string {
  const lines = [p.summary];
  for (const a of p.actions) lines.push(`- ${a.text}`);
  for (const m of p.moves) lines.push(`- pays ${m.value.amount} ${m.value.asset} to ${m.to}`);
  for (const w of p.warnings) lines.push(`WARNING: ${w}`);
  return lines.join("\n");
}

/** Next steps per node, derived from state and deadlines (PRD 11, ADR deadlines are POSIX ms). */
export function pendingActions(tree: TreeSnapshot, now: number): string[] {
  const out: string[] = [];
  if (tree.frozen) out.push("Tree is frozen: only the buyer can Unfreeze.");
  for (const n of tree.nodes) {
    const id = n.node_id.slice(0, 10);
    if (n.state === "Submitted" && now < n.challenge_until) {
      out.push(`Node ${id}: result submitted; buyer can accept or challenge until ${new Date(n.challenge_until).toISOString()}.`);
    } else if (n.state === "Submitted") {
      out.push(`Node ${id}: challenge window over; anyone can crank Accept.`);
    } else if (n.state === "Funded" && now > n.refund_after) {
      out.push(`Node ${id}: missed its deadline; anyone can crank Refund.`);
    } else if (n.state === "Funded") {
      out.push(`Node ${id}: working, result due by ${new Date(n.submit_by).toISOString()}.`);
    } else if (n.state === "Challenged" || n.state === "Disputed") {
      out.push(`Node ${id}: ${n.state.toLowerCase()}, awaiting a ruling until ${new Date(n.dispute_until).toISOString()}.`);
    }
  }
  if (out.length === 0) out.push(`Tree state ${tree.state}; nothing waits on the buyer.`);
  return out;
}

export function createCascadeMcpServer(deps: ServerDeps): McpServer {
  const { api, chain } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const indexWaitMs = deps.indexWaitMs ?? 60_000;

  /**
   * The tree snapshot, or null when the indexer still answers 404 after the wait. A tree funded a
   * moment ago is unknown to the indexer until it projects the FundRoot block (preprod A18 asked
   * right after funding and failed on "404 unknown tree"), so a 404 is retried with bounded backoff.
   */
  async function indexedTree(treeId: string): Promise<TreeSnapshot | null> {
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await api.tree(treeId);
      } catch (e) {
        if (!(e instanceof ApiError && e.service === "indexer" && e.status === 404)) throw e;
      }
      if (waited >= indexWaitMs) return null;
      const delay = Math.min(INDEX_BACKOFF_MS[Math.min(attempt, INDEX_BACKOFF_MS.length - 1)] ?? 15_000, indexWaitMs - waited);
      await sleep(delay);
      waited += delay;
    }
  }

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  /** Builds a buyer tx, previews it, and either returns it unsigned or signs via the signer service. */
  async function buyerTx(args: WalletArgs, build: (wallet: WalletContext) => Promise<{ tx_cbor: string; tree_id?: string }>): Promise<CallToolResult> {
    let wallet: WalletContext;
    if (args.sign) {
      if (!api.canSign || chain === null) {
        throw new ConfigError("sign was requested but no agent key is configured; return the unsigned tx to the user's wallet instead");
      }
      wallet = await chain.walletContext(await api.agentAddress());
    } else {
      if (args.change_address === undefined || args.utxos === undefined || args.utxos.length === 0) {
        throw new ConfigError("change_address and utxos from the buyer's wallet are required to build an unsigned transaction");
      }
      wallet = { change_address: args.change_address, utxos: args.utxos };
    }
    const built = await build(wallet);
    let preview: TxPreview | null = null;
    let previewNote = "";
    try {
      preview = await api.previewTx(built.tx_cbor);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      previewNote = `Preview unavailable (${error.message}). Inspect the transaction in the wallet before signing.`;
    }
    const previewText = preview === null ? previewNote : describePreview(preview);
    const treeLine = built.tree_id === undefined ? "" : `Tree id: ${built.tree_id}\n`;
    if (!args.sign) {
      return text(`${treeLine}Unsigned transaction ready for the buyer's wallet.\n${previewText}\n\nSign it with the wallet (CIP-30 signTx) and submit.`, {
        status: "unsigned",
        tx_cbor: built.tx_cbor,
        ...(built.tree_id === undefined ? {} : { tree_id: built.tree_id }),
        preview,
      });
    }
    if (chain === null) throw new ConfigError("no chain access configured");
    const signed = await api.sign(built.tx_cbor);
    const txId = await chain.submit(signed.signedTx);
    return text(`${treeLine}Signed by the agent key through the signer service and submitted: ${txId}\n${previewText}`, {
      status: "submitted",
      tx_id: txId,
      ...(built.tree_id === undefined ? {} : { tree_id: built.tree_id }),
      preview,
    });
  }

  server.registerTool(
    "cascade_plan_job",
    {
      title: "Plan a Cascade job",
      description: "Turns a goal and constraints into a draft plan: a tree of hired agents with prices. Nothing is funded.",
      inputSchema: {
        goal: z.string().min(10).max(4000).describe("What the buyer wants done, in plain words"),
        budget: AmountSchema.describe("Total budget in the asset's base units (lovelace for ADA)"),
        asset: AssetIdSchema.default("lovelace").describe("lovelace, or policy.assetNameHex for a token"),
        deadline_minutes: z.number().int().min(35).max(7 * 24 * 60).default(120).describe("Minutes until the result is due"),
        max_depth: z.number().int().min(1).max(6).default(3),
        min_reputation: ReputationPercentSchema.default(50).describe("Reputation floor, whole percent 0 to 100"),
        risk: z.enum(RISK_LEVELS).default("balanced"),
        acceptance: z.enum(ACCEPTANCE_PREFERENCES).default("buyer_review"),
        allow_agents: z.array(AgentIdSchema).max(50).default([]),
        block_agents: z.array(AgentIdSchema).max(50).default([]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) =>
      guarded(async () => {
        const { plan_id } = await api.createJob({
          goal: args.goal,
          asset: args.asset,
          budget: args.budget,
          deadline: now() + args.deadline_minutes * 60_000,
          max_depth: args.max_depth,
          min_reputation: args.min_reputation,
          risk: args.risk,
          acceptance: args.acceptance,
          allow_agents: args.allow_agents,
          block_agents: args.block_agents,
        });
        const env = await api.getPlan(plan_id);
        return text(`${describePlan(env)}\n\nNext: cascade_fund_job with plan_id ${plan_id}.`, { plan_id, plan: env });
      }),
  );

  server.registerTool(
    "cascade_fund_job",
    {
      title: "Fund a planned job",
      description:
        "Builds the FundRoot transaction for a drafted plan and explains it in plain words. Returns it unsigned for the buyer's wallet unless sign is true and an agent key is configured.",
      inputSchema: { plan_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/), ...walletShape },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => guarded(() => buyerTx(args, (wallet) => api.fundTx(args.plan_id, wallet))),
  );

  server.registerTool(
    "cascade_job_status",
    {
      title: "Job status",
      description: "Tree snapshot with every node's state and the actions pending on it. Pass a tree_id, or the plan_id of a funded plan.",
      inputSchema: {
        tree_id: Hex28Schema.optional(),
        plan_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      guarded(async () => {
        let treeId = args.tree_id;
        if (treeId === undefined) {
          if (args.plan_id === undefined) throw new ConfigError("pass tree_id or plan_id");
          const env = await api.getPlan(args.plan_id);
          if (env.tree_id === null) return text(`Plan ${args.plan_id} is ${env.status} and has no tree yet.`, { plan_id: args.plan_id, status: env.status });
          treeId = env.tree_id;
        }
        const tree = await indexedTree(treeId);
        if (tree === null) {
          return text(`Tree ${treeId} is funded but not indexed yet (the indexer had not seen it after ${Math.round(indexWaitMs / 1000)} s). It is pending, not failed: ask again in a minute.`, {
            tree_id: treeId,
            status: "pending_index",
            tree: null,
          });
        }
        const pending = pendingActions(tree, now());
        const nodes = tree.nodes.map((n) => `- ${n.node_id.slice(0, 10)} depth ${n.depth} ${n.kind} ${n.state} budget ${n.budget}`);
        return text([`Tree ${tree.tree_id}: ${tree.state}${tree.frozen ? " (frozen)" : ""}, ${tree.nodes.length} nodes`, ...nodes, "Pending:", ...pending.map((p) => `- ${p}`)].join("\n"), {
          tree,
          pending,
        });
      }),
  );

  const actionTool = (name: string, action: BuyerAction, title: string, description: string): void => {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: { tree_id: Hex28Schema, node_id: Hex28Schema, ...walletShape },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => guarded(() => buyerTx(args, (wallet) => api.treeAction(args.tree_id, action, args.node_id, wallet))),
    );
  };
  actionTool("cascade_accept_result", "Accept", "Accept a result", "Buyer accepts a submitted result at a node, releasing its payment. Returns an unsigned tx unless sign is true.");
  actionTool("cascade_challenge_result", "Challenge", "Challenge a result", "Buyer challenges a submitted result within its challenge window. Returns an unsigned tx unless sign is true.");

  server.registerTool(
    "cascade_find_agents",
    {
      title: "Find agents",
      description: "Searches the Cascade Directory (allowlisted Masumi-registered agents) by category, minimum reputation and payment rail.",
      inputSchema: {
        category: z.string().min(1).max(64).optional(),
        min_reputation: ReputationPercentSchema.optional().describe("Whole percent, 0 to 100, the same scale as cascade_plan_job"),
        rail: z.enum(["native", "masumi", "metered"]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      guarded(async () => {
        const agents = await api.findAgents({
          ...(args.category === undefined ? {} : { category: args.category }),
          ...(args.min_reputation === undefined ? {} : { min_rep: reputationFractionFromPercent(args.min_reputation) }),
          ...(args.rail === undefined ? {} : { rail: args.rail }),
        });
        const lines = agents.map(
          (a) => `- ${a.name} (${a.agent_asset_id.slice(0, 12)}…): ${a.categories.join(", ")}; rails ${a.rails.join("/")}; reputation ${Math.round(a.reputation.score * 100)}/100`,
        );
        return text(agents.length === 0 ? "No agents match." : [`${agents.length} agents:`, ...lines].join("\n"), { agents });
      }),
  );

  server.registerTool(
    "cascade_get_receipt",
    {
      title: "Get receipt",
      description: "Reconciled, oracle-signed receipt for a tree: every payment and refund with its transaction.",
      inputSchema: { tree_id: Hex28Schema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      guarded(async () => {
        const receipt = await api.receipt(args.tree_id);
        return text(`Receipt for tree ${args.tree_id}:\n${JSON.stringify(receipt, null, 2)}`, { receipt });
      }),
  );

  server.registerTool(
    "cascade_serve_as_agent",
    {
      title: "Serve as a Cascade agent",
      description:
        "Lists the calling agent's MIP-003 service in the Cascade Directory so trees can hire it. Checks its endpoints first. Registration on the Masumi registry itself goes through the operator's Masumi Payment Service.",
      inputSchema: {
        agent_asset_id: AgentIdSchema.describe("Masumi registry asset id (policy + name hex)"),
        name: z.string().min(1).max(200),
        api_url: z.string().url().describe("Base URL serving MIP-003 (/availability, /input_schema, /start_job, /status)"),
        payment_vkh: Hex28Schema.describe("Payment key hash that receives payouts"),
        categories: z.array(z.string().min(1).max(64)).max(32).default([]),
        rails: z.array(z.enum(["native", "masumi", "metered", "address"])).max(4).default(["native"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) =>
      guarded(async () => {
        const checks = await api.checkAgentEndpoints(args.api_url);
        const failed = checks.filter((c) => !c.ok);
        const checkText = checks.map((c) => `- ${c.path}: ${c.ok ? "ok" : `failed (${c.status ?? "no response"})`}`).join("\n");
        if (failed.length > 0) {
          return { ...text(`Endpoint checks failed; not listed.\n${checkText}`, { listed: false, checks }), isError: true };
        }
        await api.registerAgent(args);
        return text(`Listed ${args.name} in the Cascade Directory.\n${checkText}`, { listed: true, checks });
      }),
  );

  return server;
}
