/**
 * Response schemas for the indexer and directory REST API. Everything in the first section mirrors
 * packages/shared/openapi/directory.yaml exactly. The second section covers routes the web app
 * needs that directory.yaml does not define yet; they are the proposed contract for W3 and W4 and
 * are marked `pending` in the UI until the services serve them.
 */
import {
  AmountSchema,
  AssetIdSchema,
  Hex28Schema,
  Hex32Schema,
  NodeSpecSchema,
  PlanSchema,
  ReputationPercentSchema,
} from "@cascade/shared/browser";
import { z } from "zod";

const OutRefSchema = z.string().regex(/^[0-9a-f]{64}#\d+$/);
const AgentIdSchema = z.string().regex(/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/);
const MsSchema = z.number().int().nonnegative();

export const ValueSchema = z.object({ asset: AssetIdSchema, amount: AmountSchema }).strict();
export type Value = z.infer<typeof ValueSchema>;

// ---------------------------------------------------------------------------------------------
// directory.yaml

export const API_NODE_STATES = ["Funded", "Submitted", "Challenged", "Disputed", "Accepted", "Refunded", "Settled"] as const;
export const ApiNodeStateSchema = z.enum(API_NODE_STATES);
export type ApiNodeState = z.infer<typeof ApiNodeStateSchema>;

export const NodeKindSchema = z.enum(["Native", "MasumiReceipt", "MeteredReceipt"]);
export type ApiNodeKind = z.infer<typeof NodeKindSchema>;

export const ApiNodeSchema = z.object({
  node_id: Hex28Schema,
  tree_id: Hex28Schema,
  parent_id: Hex28Schema.nullable(),
  depth: z.number().int().nonnegative(),
  kind: NodeKindSchema,
  operator_vkh: Hex28Schema,
  payee: z.string(),
  agent_asset_id: AgentIdSchema.nullable().optional(),
  /** Directory name, joined by the indexer so a tree renders without one request per agent. */
  agent_name: z.string().nullable().optional(),
  budget: AmountSchema,
  fee: AmountSchema,
  committed: AmountSchema,
  /** ADR 0001 1.5: value that has left the tree from this node. Held value is budget - committed - spent. */
  spent: AmountSchema.optional(),
  children_open: z.number().int().nonnegative(),
  spec_hash: Hex32Schema,
  input_hash: Hex32Schema,
  result_hash: Hex32Schema.nullable(),
  acceptance: z.object({
    type: z.enum(["ParentAccept", "VerifierQuorum", "AutoAfterWindow", "BuyerAccept"]),
    key: Hex28Schema.optional(),
    keys: z.array(Hex28Schema).optional(),
    k: z.number().int().optional(),
  }),
  submit_by: MsSchema,
  challenge_until: MsSchema,
  refund_after: MsSchema,
  dispute_until: MsSchema,
  state: ApiNodeStateSchema,
  current_utxo: OutRefSchema.nullable(),
  external_ref: OutRefSchema.nullable(),
  tx_ids: z.array(Hex32Schema),
});
export type ApiNode = z.infer<typeof ApiNodeSchema>;

export const TreeSchema = z.object({
  tree_id: Hex28Schema,
  buyer_vkh: Hex28Schema,
  asset: AssetIdSchema,
  root_budget: AmountSchema,
  plan_root: Hex32Schema,
  config_utxo: OutRefSchema,
  state: z.enum(["open", "closed", "cancelled"]),
  frozen: z.boolean(),
  created_slot: z.number().int(),
  closed_slot: z.number().int().nullable(),
  /** TreeConfig field 20 (ADR 0001 1.6, E6), ms. Optional until the indexer exposes the config. */
  min_dispute_window: z.number().int().positive().optional(),
  nodes: z.array(ApiNodeSchema),
});
export type Tree = z.infer<typeof TreeSchema>;

export const RECEIPT_LINE_KINDS = ["deposit", "fee", "masumi", "refund", "protocol_fee", "bond_return", "bond_slash", "structural"] as const;

/** ADR 0001 8.1: a Masumi hire goes Draw -> purchase wallet P -> plain vested_pay lock -> withdrawal or refund. */
export const MASUMI_OUTCOMES = ["awaiting_lock", "locked", "refunded", "withdrawn"] as const;
export type MasumiOutcome = (typeof MASUMI_OUTCOMES)[number];
const BlockchainIdentifierSchema = z.string().min(1).max(4096);

export const ReceiptSchema = z.object({
  tree_id: Hex28Schema,
  deposits: ValueSchema,
  payouts: ValueSchema,
  refunds: ValueSchema,
  fees: ValueSchema,
  structural_returned_lovelace: AmountSchema,
  /** Structural ADA put in and paid out (min-UTxO on payee outputs); deposited = paid + returned. */
  structural_deposited_lovelace: AmountSchema.optional(),
  structural_paid_lovelace: AmountSchema.optional(),
  balanced: z.boolean(),
  lines: z.array(
    z.object({
      node_id: Hex28Schema,
      kind: z.enum(RECEIPT_LINE_KINDS),
      to: z.string(),
      value: ValueSchema,
      tx_id: Hex32Schema,
      blockchain_identifier: BlockchainIdentifierSchema.optional(),
      payment_out_ref: OutRefSchema.optional(),
      lock_tx: Hex32Schema.nullable().optional(),
      outcome: z.enum(MASUMI_OUTCOMES).optional(),
      outcome_tx: Hex32Schema.nullable().optional(),
    }),
  ),
  key: z.string(),
  signature: z.string(),
});
export type Receipt = z.infer<typeof ReceiptSchema>;
export type ReceiptLine = Receipt["lines"][number];

/** Events are validated one by one in `events.ts`, so one bad event never fails the page. */
export const EventsPageSchema = z.object({ events: z.array(z.unknown()), next: z.string().nullable() });

export const RailSchema = z.enum(["native", "masumi", "metered"]);

export const AgentSummarySchema = z.object({
  agent_asset_id: AgentIdSchema,
  name: z.string(),
  api_url: z.string(),
  categories: z.array(z.string()),
  rails: z.array(RailSchema),
  availability: z.enum(["available", "unavailable", "unknown"]),
  reputation: z.object({ score: z.number().min(0).max(1), confidence: z.number().min(0).max(1) }),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const CascadeCapabilitiesSchema = z.looseObject({
  version: z.literal("1"),
  roles: z.array(z.enum(["specialist", "orchestrator", "verifier"])),
  categories: z.array(z.string()),
  max_depth: z.number().int().nonnegative(),
  rails: z.array(z.string()),
  bond_lovelace: AmountSchema,
  registry_asset_id: AgentIdSchema,
});

export const AgentProfileSchema = AgentSummarySchema.extend({
  payment_vkh: Hex28Schema,
  capabilities: CascadeCapabilitiesSchema,
  signals: z.record(z.string(), z.record(z.string(), z.number())),
  last_seen: MsSchema,
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const ACTION_TYPES = [
  "FundRoot", "TopUp", "Draw", "Submit", "Accept", "Challenge", "Escalate", "Resolve",
  "Refund", "SettleChild", "CloseReceipt", "CloseRoot", "Cancel", "Freeze", "Unfreeze",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const TxPreviewSchema = z.object({
  tx_body_hash: Hex32Schema,
  summary: z.string(),
  actions: z.array(z.object({ type: z.enum(ACTION_TYPES), node_id: Hex28Schema.optional(), text: z.string() })),
  moves: z.array(z.object({ to: z.string(), value: ValueSchema })),
  warnings: z.array(z.string()).optional(),
});
export type TxPreview = z.infer<typeof TxPreviewSchema>;

// ---------------------------------------------------------------------------------------------
// Pending: not in directory.yaml yet. Proposed contract for W3 (indexer) and W4 (orchestrator).

/** `GET /v1/trees/:tree_id/nodes/:node_id` (pending W3): drawer detail. */
export const NodeDetailSchema = z.object({
  node_id: Hex28Schema,
  spec: NodeSpecSchema.nullable(),
  datum: z.record(z.string(), z.unknown()),
  verdicts: z.array(
    z.object({
      verifier: z.string(),
      verifier_name: z.string().optional(),
      verdict: z.enum(["accept", "reject"]),
      score: z.number().min(0).max(1),
      evidence_hash: Hex32Schema,
      checks: z.array(z.object({ name: z.string(), passed: z.boolean() })),
    }),
  ),
  gate_logs: z.array(
    z.object({
      tx_body_hash: Hex32Schema,
      action: z.enum(ACTION_TYPES),
      decision: z.enum(["signed", "refused"]),
      gates: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string().optional() })),
      at: MsSchema,
    }),
  ),
  txs: z.array(z.object({ tx_id: Hex32Schema, action: z.enum(ACTION_TYPES), slot: z.number().int() })),
  /** MasumiReceipt nodes: the tracked lock and its blockchainIdentifier. */
  masumi: z.object({ lock: OutRefSchema.nullable(), blockchain_identifier: BlockchainIdentifierSchema.nullable() }).nullable().optional(),
  /** ADR 0001 8.1: Masumi hires this node paid through the purchase wallet, with lock and outcome. */
  masumi_leaves: z
    .array(
      z.object({
        node_id: Hex28Schema,
        payment_out_ref: OutRefSchema,
        draw_tx: Hex32Schema,
        value: z.object({ lovelace: AmountSchema, assets: z.record(z.string(), AmountSchema) }),
        lock_tx: Hex32Schema.nullable(),
        lock_out_ref: OutRefSchema.nullable(),
        blockchain_identifier: BlockchainIdentifierSchema.nullable(),
        lock_state: z.string().nullable(),
        outcome: z.enum(MASUMI_OUTCOMES),
        outcome_tx: Hex32Schema.nullable(),
      }),
    )
    .default([]),
  /** Metered leaves only (PRD 8.6): calls made, total paid, L1 transactions used. */
  metered: z.object({ calls: z.number().int().nonnegative(), paid: ValueSchema, l1_txs: z.number().int().nonnegative() }).nullable(),
});
export type NodeDetail = z.infer<typeof NodeDetailSchema>;

export const RISK_LEVELS = ["cheapest", "balanced", "safest"] as const;
export const ACCEPTANCE_PREFERENCES = ["buyer_review", "auto_after_checks"] as const;

/** `GET /api/deployment` (this app): script hashes from deployments/<network>.json. */
export const DeploymentSchema = z.object({
  network: z.enum(["local", "preprod"]),
  scripts: z.object({ node: Hex28Schema, config: Hex28Schema }),
  /** Public address of the oracle that signs receipts; null when the wallets file has none. */
  oracle_address: z.string().nullable().optional(),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

/** `POST /v1/jobs` (pending W4): the new job form. Amounts are base units. */
export const CreateJobRequestSchema = z.object({
  goal: z.string().min(10).max(4000),
  asset: AssetIdSchema,
  budget: AmountSchema,
  deadline: MsSchema,
  max_depth: z.number().int().min(1).max(6),
  /** Whole percent (0 to 100); the Conductor converts it to the canonical fraction (0 to 1). */
  min_reputation: ReputationPercentSchema,
  risk: z.enum(RISK_LEVELS),
  acceptance: z.enum(ACCEPTANCE_PREFERENCES),
  allow_agents: z.array(z.string().min(1)).max(50),
  block_agents: z.array(z.string().min(1)).max(50),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;
export const CreateJobResponseSchema = z.object({ plan_id: z.string().min(1).max(128) });

/** `GET /v1/plans/:plan_id` (pending W4): signed plan plus the names of the agents it names. */
export const PlanEnvelopeSchema = z.object({
  plan: PlanSchema,
  goal: z.string(),
  status: z.enum(["draft", "funded", "expired"]),
  tree_id: Hex28Schema.nullable(),
  agents: z.record(z.string(), z.object({ name: z.string(), reputation: z.number().min(0).max(1) })),
});
export type PlanEnvelope = z.infer<typeof PlanEnvelopeSchema>;

/** `POST /v1/plans/:plan_id/fund-tx` (pending W4 with the W2 SDK): unsigned FundRoot tx. */
export const FundTxRequestSchema = z.object({ change_address: z.string().min(1), utxos: z.array(z.string().regex(/^[0-9a-f]+$/)) });
export type FundTxRequest = z.infer<typeof FundTxRequestSchema>;
export const FundTxResponseSchema = z.object({ tx_cbor: z.string().regex(/^[0-9a-f]+$/), tree_id: Hex28Schema });
export type FundTxResponse = z.infer<typeof FundTxResponseSchema>;

/** `POST /v1/trees/:tree_id/actions` (pending W4 with the W2 SDK): unsigned buyer action tx. */
export const BUYER_ACTIONS = ["Accept", "Challenge", "Freeze", "Unfreeze"] as const;
export const TreeActionRequestSchema = z.object({
  action: z.enum(BUYER_ACTIONS),
  node_id: Hex28Schema,
  change_address: z.string().min(1),
  utxos: z.array(z.string().regex(/^[0-9a-f]+$/)),
});
export type TreeActionRequest = z.infer<typeof TreeActionRequestSchema>;
export const UnsignedTxSchema = z.object({ tx_cbor: z.string().regex(/^[0-9a-f]+$/) });

/** `GET /v1/trees?buyer=` (pending W3): job history. */
export const TreeListItemSchema = z.object({
  tree_id: Hex28Schema,
  goal: z.string(),
  asset: AssetIdSchema,
  root_budget: AmountSchema,
  paid: AmountSchema,
  refunded: AmountSchema,
  recovered: AmountSchema,
  state: z.enum(["open", "closed", "cancelled"]),
  created_at: MsSchema,
  node_count: z.number().int().nonnegative(),
  agents: z.array(z.string()),
  spend_by_category: z.record(z.string(), AmountSchema),
});
export type TreeListItem = z.infer<typeof TreeListItemSchema>;
export const TreeListSchema = z.object({ trees: z.array(TreeListItemSchema) });

/** `GET /v1/disputes` (pending W3): open Challenged and Disputed native nodes. */
export const DisputeSchema = z.object({
  tree_id: Hex28Schema,
  node_id: Hex28Schema,
  agent_name: z.string(),
  state: z.enum(["Challenged", "Disputed"]),
  dispute_until: MsSchema,
  locked: ValueSchema,
  fee: AmountSchema,
  arbiters: z.array(Hex28Schema),
  threshold: z.number().int().min(1),
  spec: NodeSpecSchema.nullable(),
  spec_hash: Hex32Schema,
  input_hash: Hex32Schema,
  result_hash: Hex32Schema.nullable(),
  reason_hash: Hex32Schema,
  bundles: z.object({ worker: Hex32Schema.nullable(), challenger: Hex32Schema.nullable() }),
  verdicts: NodeDetailSchema.shape.verdicts,
  gate_logs: NodeDetailSchema.shape.gate_logs,
  challenge_tx: Hex32Schema,
});
export type Dispute = z.infer<typeof DisputeSchema>;
export const DisputeListSchema = z.object({ disputes: z.array(DisputeSchema) });

/** `GET /v1/ops/status` (pending W3): read-only operations view. */
export const OpsStatusSchema = z.object({
  indexer: z.object({ tip_slot: z.number().int(), indexed_slot: z.number().int(), lag_ms: MsSchema, rollbacks_24h: z.number().int() }),
  facilitator: z.object({ queued: z.number().int(), settlement_pending: z.number().int(), settled_24h: z.number().int(), rejected_24h: z.number().int() }),
  cranks: z.array(z.object({ action: z.enum(ACTION_TYPES), tree_id: Hex28Schema, node_id: Hex28Schema, tx_id: Hex32Schema, at: MsSchema })),
  failed_txs: z.array(z.object({ action: z.enum(ACTION_TYPES), tx_id: Hex32Schema.nullable(), error: z.string(), at: MsSchema })),
  exec_units: z.array(
    z.object({ redeemer: z.enum(ACTION_TYPES), mem: z.number().int(), steps: z.number().int(), max_mem: z.number().int(), max_steps: z.number().int(), samples: z.number().int() }),
  ),
});
export type OpsStatus = z.infer<typeof OpsStatusSchema>;

/** `GET /v1/agents/:asset_id/work` (pending W3): provider inbox and earnings. */
export const ProviderWorkSchema = z.object({
  quote_requests: z.array(z.object({ spec_hash: Hex32Schema, task: z.string(), max_budget: ValueSchema, submit_by: MsSchema, received_at: MsSchema })),
  active_jobs: z.array(z.object({ tree_id: Hex28Schema, node_id: Hex28Schema, task: z.string(), fee: ValueSchema, state: ApiNodeStateSchema, state_tx: Hex32Schema, next_deadline: MsSchema })),
  earnings: z.object({ paid: ValueSchema, pending: ValueSchema, jobs_settled: z.number().int(), jobs_refunded: z.number().int() }),
  bonds_at_risk_lovelace: AmountSchema,
});
export type ProviderWork = z.infer<typeof ProviderWorkSchema>;

/** Result of the provider endpoint check route in this app (`/api/provider/check`). */
export const EndpointCheckSchema = z.object({
  base_url: z.string(),
  checks: z.array(
    z.object({ path: z.string(), required: z.boolean(), status: z.enum(["pass", "fail"]), http_status: z.number().int().nullable(), detail: z.string() }),
  ),
});
export type EndpointCheck = z.infer<typeof EndpointCheckSchema>;
