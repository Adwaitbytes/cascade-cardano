/**
 * One Cascade job on preprod, driven through the running Conductor's buyer API: draft a plan for
 * the Task's goal, fund its root from the coworker-buyer wallet, read the root's composed result
 * from the tree's Temporal workflow, and accept the root. Every response from the Conductor, the
 * indexer and the workflow is schema-parsed before it is used or rendered.
 */
import { Client, Connection, WorkflowNotFoundError } from "@temporalio/client";
import { utxoToCore, type LucidEvolution } from "@lucid-evolution/lucid";
import { z } from "zod";

const Hex28 = z.string().regex(/^[0-9a-f]{56}$/);
const Hex32 = z.string().regex(/^[0-9a-f]{64}$/);

export const ChildOutcomeSchema = z.object({
  status: z.string(),
  spec_id: z.string(),
  result: z.unknown().optional(),
  hire: z
    .object({
      agent_id: z.string(),
      job_id: z.string().nullable().optional(),
      draw_tx_id: z.string().optional(),
      masumi: z.object({ lock_tx: z.string(), blockchain_identifier: z.string() }).partial().optional(),
    })
    .partial()
    .optional(),
  actions: z.array(z.string()).optional(),
});

export const RootOutcomeSchema = z.object({
  node_id: Hex28,
  result: z.unknown(),
  result_hash: Hex32,
  partial: z.boolean(),
  children: z.array(ChildOutcomeSchema),
});
export type RootOutcome = z.infer<typeof RootOutcomeSchema>;

export const TreeNodeSchema = z.object({
  node_id: Hex28,
  parent_id: Hex28.nullable(),
  depth: z.number(),
  kind: z.string(),
  agent_name: z.string().nullable().optional(),
  state: z.string(),
  budget: z.string(),
  fee: z.string(),
  tx_ids: z.array(z.string()),
});
export const TreeSchema = z.object({ tree_id: Hex28, asset: z.string(), root_budget: z.string(), state: z.string(), nodes: z.array(TreeNodeSchema) });
export type TreeView = z.infer<typeof TreeSchema>;

const Value = z.object({ asset: z.string(), amount: z.string() });
export const ReceiptSchema = z.object({
  tree_id: Hex28,
  deposits: Value,
  payouts: Value,
  refunds: Value,
  balanced: z.boolean(),
  lines: z.array(z.object({ node_id: z.string(), kind: z.string(), to: z.string(), value: Value, tx_id: z.string() })),
});
export type TreeReceipt = z.infer<typeof ReceiptSchema>;

const PlanEnvelopeSchema = z.object({ status: z.enum(["draft", "funded", "expired"]), tree_id: Hex28.nullable() });

export interface CascadeRunnerDeps {
  conductorUrl: string;
  indexerUrl: string;
  temporalAddress: string;
  temporalNamespace: string;
  /** Lucid with the coworker-buyer wallet selected; never handed to anything else. */
  lucid: LucidEvolution;
  buyerAddress: string;
  fetchImpl?: typeof fetch;
}

export interface CascadeRunner {
  draftPlan(goal: string, budgetLovelace: string, deadline: number): Promise<string>;
  planStatus(planId: string): Promise<z.infer<typeof PlanEnvelopeSchema>>;
  /** Builds, signs and submits the FundRoot; returns the tree id and tx hash. */
  fund(planId: string): Promise<{ treeId: string; fundTx: string }>;
  /** The root's composed outcome once its workflow completed; null while it runs. */
  rootOutcome(treeId: string): Promise<RootOutcome | null>;
  acceptRoot(treeId: string): Promise<string>;
  tree(treeId: string): Promise<TreeView>;
  receipt(treeId: string): Promise<TreeReceipt>;
}

export function cascadeRunner(deps: CascadeRunnerDeps): CascadeRunner {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let temporal: Promise<Client> | null = null;
  const client = () => (temporal ??= Connection.connect({ address: deps.temporalAddress }).then((connection) => new Client({ connection, namespace: deps.temporalNamespace })));

  async function json(url: string, init?: RequestInit): Promise<unknown> {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(120_000) });
    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} answered ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    return body;
  }
  const post = (path: string, body: unknown) => json(`${deps.conductorUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  async function walletContext() {
    const utxos = await deps.lucid.wallet().getUtxos();
    return { change_address: deps.buyerAddress, utxos: utxos.map((u) => utxoToCore(u).to_cbor_hex()) };
  }
  async function signAndSubmit(txCbor: string): Promise<string> {
    const signed = await deps.lucid.fromTx(txCbor).sign.withWallet().complete();
    return signed.submit();
  }

  return {
    async draftPlan(goal, budgetLovelace, deadline) {
      const res = z.object({ plan_id: z.string().min(1) }).parse(
        await post("/v1/jobs", {
          goal,
          asset: "lovelace",
          budget: budgetLovelace,
          deadline,
          max_depth: 3,
          min_reputation: 0,
          risk: "balanced",
          acceptance: "buyer_review",
          allow_agents: [],
          block_agents: [],
        }),
      );
      return res.plan_id;
    },
    planStatus: async (planId) => PlanEnvelopeSchema.parse(await json(`${deps.conductorUrl}/v1/plans/${encodeURIComponent(planId)}`)),
    async fund(planId) {
      const res = z.object({ tx_cbor: z.string().min(1), tree_id: Hex28 }).parse(await post(`/v1/plans/${encodeURIComponent(planId)}/fund-tx`, await walletContext()));
      return { treeId: res.tree_id, fundTx: await signAndSubmit(res.tx_cbor) };
    },
    async rootOutcome(treeId) {
      const handle = (await client()).workflow.getHandle(`tree-${treeId}`);
      try {
        const info = await handle.describe();
        if (info.status.name === "RUNNING") return null;
        if (info.status.name !== "COMPLETED") throw new Error(`tree workflow ended ${info.status.name}`);
      } catch (e) {
        if (e instanceof WorkflowNotFoundError) return null;
        throw e;
      }
      return RootOutcomeSchema.parse(await handle.result());
    },
    async acceptRoot(treeId) {
      const res = z.object({ tx_cbor: z.string().min(1) }).parse(await post(`/v1/trees/${treeId}/actions`, { action: "Accept", node_id: treeId, ...(await walletContext()) }));
      return signAndSubmit(res.tx_cbor);
    },
    tree: async (treeId) => TreeSchema.parse(await json(`${deps.indexerUrl}/v1/trees/${treeId}`)),
    receipt: async (treeId) => ReceiptSchema.parse(await json(`${deps.indexerUrl}/v1/trees/${treeId}/receipt`)),
  };
}
