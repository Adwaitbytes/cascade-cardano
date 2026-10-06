/**
 * Request and response shapes of the orchestrator API, mirroring the proposed contract in
 * apps/web/src/lib/api/schemas.ts (W5). test/api.test.ts parses every response with the web app's
 * own schemas, so any drift fails the build.
 */
import { AmountSchema, AssetIdSchema, Hex28Schema, PlanSchema } from "@cascade/shared/browser";
import { z } from "zod";
import { TEST_SCENARIOS } from "../test-scenarios.js";

const MsSchema = z.number().int().nonnegative();
const HexSchema = z.string().regex(/^[0-9a-f]+$/);

export const RISK_LEVELS = ["cheapest", "balanced", "safest"] as const;
export const ACCEPTANCE_PREFERENCES = ["buyer_review", "auto_after_checks"] as const;

export const CreateJobRequestSchema = z.object({
  goal: z.string().min(10).max(4000),
  asset: AssetIdSchema,
  budget: AmountSchema,
  deadline: MsSchema,
  max_depth: z.number().int().min(1).max(6),
  min_reputation: z.number().int().min(0).max(100),
  risk: z.enum(RISK_LEVELS),
  acceptance: z.enum(ACCEPTANCE_PREFERENCES),
  allow_agents: z.array(z.string().min(1)).max(50),
  block_agents: z.array(z.string().min(1)).max(50),
  /** Plan native Cascade agents only: Masumi slots become native and Masumi contingencies are dropped (their 35-minute windows set the pace of a tree). Not part of the web contract. */
  native_only: z.boolean().optional(),
  /** Labelled acceptance-test scenario (A1, A3, A5, A7, A8, A9); replaces the planner with a fixed draft. Not part of the web contract. */
  test_scenario: z.enum(TEST_SCENARIOS).optional(),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

export const PlanEnvelopeSchema = z.object({
  plan: PlanSchema,
  goal: z.string(),
  status: z.enum(["draft", "funded", "expired"]),
  tree_id: Hex28Schema.nullable(),
  agents: z.record(z.string(), z.object({ name: z.string(), reputation: z.number().min(0).max(1) })),
});
export type PlanEnvelope = z.infer<typeof PlanEnvelopeSchema>;

export const WalletContextSchema = z.object({ change_address: z.string().min(1), utxos: z.array(HexSchema) });
export type WalletContext = z.infer<typeof WalletContextSchema>;

export const FundTxRequestSchema = WalletContextSchema;

export const BUYER_ACTIONS = ["Accept", "Challenge", "Freeze", "Unfreeze"] as const;
export type BuyerAction = (typeof BUYER_ACTIONS)[number];
export const TreeActionRequestSchema = WalletContextSchema.extend({ action: z.enum(BUYER_ACTIONS), node_id: Hex28Schema });

export const ResolveTxRequestSchema = WalletContextSchema.extend({ worker: AmountSchema, parent: AmountSchema });
