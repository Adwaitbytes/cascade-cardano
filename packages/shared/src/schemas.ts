import { z } from "zod";
import {
  ACTION_INDEX,
  BOND_ROLES,
  NODE_KINDS,
  NODE_STATES,
  RULINGS,
  type Acceptance,
  logicScriptOf,
  type Action,
  type LogicRedeemer,
  type AssetClass,
  type BondDatum,
  type BondRuling,
  type ChannelDatum,
  type ChannelRedeemer,
  type ChildDraw,
  type Credential,
  type NodeDatum,
  type OutputReference,
  type ParentLink,
  type PlanLeaf,
  type PlutusAddress,
  type ProofStep,
  type Split,
  type StakeCredential,
  type TreeConfig,
} from "./types.js";

/** Lowercase hex of exactly `bytes` bytes. */
export const hexOf = (bytes: number) =>
  z
    .string()
    .regex(/^(?:[0-9a-f]{2})*$/, "lowercase even-length hex")
    .length(bytes * 2, `${bytes} bytes`);

/** Lowercase hex of any even length up to `maxBytes`. */
export const hexUpTo = (maxBytes: number) =>
  z
    .string()
    .regex(/^(?:[0-9a-f]{2})*$/, "lowercase even-length hex")
    .max(maxBytes * 2, `at most ${maxBytes} bytes`);

export const Hex28Schema = hexOf(28);
const ZERO_28 = "00".repeat(28);
export const Hex32Schema = hexOf(32);
export const HexBytesSchema = z.string().regex(/^(?:[0-9a-f]{2})*$/, "lowercase even-length hex");

/** Every on-chain Int that Cascade writes is a non-negative bigint. */
export const UIntSchema = z.bigint().nonnegative();
const bps = z.bigint().min(0n).max(10_000n);

export const CredentialSchema: z.ZodType<Credential> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("VerificationKey"), hash: Hex28Schema }).strict(),
  z.object({ type: z.literal("Script"), hash: Hex28Schema }).strict(),
]);

export const StakeCredentialSchema: z.ZodType<StakeCredential> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Inline"), credential: CredentialSchema }).strict(),
  z
    .object({
      type: z.literal("Pointer"),
      slot_number: UIntSchema,
      transaction_index: UIntSchema,
      certificate_index: UIntSchema,
    })
    .strict(),
]);

export const PlutusAddressSchema: z.ZodType<PlutusAddress> = z
  .object({ payment_credential: CredentialSchema, stake_credential: StakeCredentialSchema.nullable() })
  .strict();

/** An address whose payment credential is a verification key (ADR: buyer_refund, payee, owner_address). */
export const KeyAddressSchema: z.ZodType<PlutusAddress> = PlutusAddressSchema.refine(
  (a) => a.payment_credential.type === "VerificationKey",
  "payment credential must be a verification key",
);

export const OutputReferenceSchema: z.ZodType<OutputReference> = z
  .object({ transaction_id: Hex32Schema, output_index: UIntSchema })
  .strict();

export const AssetClassSchema: z.ZodType<AssetClass> = z
  .object({ policy: z.union([z.literal(""), Hex28Schema]), name: hexUpTo(32) })
  .strict()
  .refine((a) => a.policy !== "" || a.name === "", "lovelace has an empty asset name");

export const NodeKindSchema = z.enum(NODE_KINDS);
export const NodeStateSchema = z.enum(NODE_STATES);
export const BondRoleSchema = z.enum(BOND_ROLES);
export const RulingSchema = z.enum(RULINGS);

export const AcceptanceSchema: z.ZodType<Acceptance> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ParentAccept"), key: Hex28Schema }).strict(),
  z
    .object({ type: z.literal("VerifierQuorum"), keys: z.array(Hex28Schema).min(1), k: z.bigint().min(1n) })
    .strict()
    .refine((a) => a.k <= BigInt(a.keys.length), "k must be at most the number of keys"),
  z.object({ type: z.literal("AutoAfterWindow") }).strict(),
  z.object({ type: z.literal("BuyerAccept"), key: Hex28Schema }).strict(),
]);

export const TreeConfigSchema: z.ZodType<TreeConfig> = z
  .object({
    tree_id: Hex28Schema,
    buyer: Hex28Schema,
    buyer_refund: KeyAddressSchema,
    asset: AssetClassSchema,
    arbiters: z.array(Hex28Schema),
    arbiter_threshold: UIntSchema,
    arbiter_fee_address: PlutusAddressSchema,
    max_depth: UIntSchema,
    max_fanout: UIntSchema,
    max_child_share_bps: bps,
    min_challenge_window: UIntSchema,
    min_safety_margin: UIntSchema,
    allowed_leaf_kinds: z.array(NodeKindSchema),
    masumi_script_hash: Hex28Schema,
    channel_script_hash: Hex28Schema,
    plan_root: Hex32Schema,
    protocol_fee_bps: bps,
    protocol_fee_address: PlutusAddressSchema,
    challenge_bond: UIntSchema,
    slash_wronged_bps: bps,
    min_dispute_window: z.bigint().positive(),
  })
  .strict()
  .refine(
    (c) =>
      c.arbiters.length === 0
        ? c.arbiter_threshold === 0n
        : c.arbiter_threshold >= 1n && c.arbiter_threshold <= BigInt(c.arbiters.length),
    "arbiter_threshold must be 1..len(arbiters), or 0 with no arbiters",
  );

export const NodeDatumSchema: z.ZodType<NodeDatum> = z
  .object({
    tree_id: Hex28Schema,
    node_id: Hex28Schema,
    parent_id: Hex28Schema.nullable(),
    depth: UIntSchema,
    next_child: UIntSchema,
    operator: Hex28Schema,
    payee: KeyAddressSchema,
    kind: NodeKindSchema,
    budget: UIntSchema,
    fee: UIntSchema,
    committed: UIntSchema,
    children_open: UIntSchema,
    structural: UIntSchema,
    external_lovelace: UIntSchema,
    spec_hash: Hex32Schema,
    input_hash: Hex32Schema,
    result_hash: Hex32Schema.nullable(),
    acceptance: AcceptanceSchema,
    submit_by: UIntSchema,
    challenge_until: UIntSchema,
    refund_after: UIntSchema,
    dispute_until: UIntSchema,
    external_ref: OutputReferenceSchema.nullable(),
    frozen: z.boolean(),
    state: NodeStateSchema,
    spent: UIntSchema,
  })
  .strict()
  .refine((d) => d.fee <= d.budget, "fee must not exceed budget")
  .refine((d) => d.committed + d.spent <= d.budget, "committed plus spent must not exceed budget")
  .refine((d) => (d.parent_id === null) === (d.depth === 0n), "parent_id is None exactly at depth 0")
  .refine((d) => d.kind !== "AddressPayment", "AddressPayment never appears in a NodeDatum");

export const BondDatumSchema: z.ZodType<BondDatum> = z
  .object({
    authority: Hex28Schema,
    tree_id: Hex28Schema,
    node_id: Hex28Schema,
    owner: Hex28Schema,
    owner_address: KeyAddressSchema,
    role: BondRoleSchema,
    release_after: UIntSchema,
  })
  .strict();

export const ChannelDatumSchema: z.ZodType<ChannelDatum> = z
  .object({
    authority: Hex28Schema,
    tree_id: Hex28Schema,
    node_id: Hex28Schema,
    payer_vkey: Hex32Schema,
    provider: Hex28Schema,
    provider_address: KeyAddressSchema,
    asset: AssetClassSchema,
    deposit: UIntSchema,
    redeemed: UIntSchema,
    timeout: UIntSchema,
  })
  .strict()
  .refine((c) => c.redeemed <= c.deposit, "redeemed must not exceed deposit");

export const ChannelRedeemerSchema: z.ZodType<ChannelRedeemer> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Redeem"), amount: z.bigint().positive(), signature: hexOf(64), out: UIntSchema }).strict(),
  z.object({ type: z.literal("Close") }).strict(),
]);

export const PlanLeafSchema: z.ZodType<PlanLeaf> = z
  .object({
    spec_hash: Hex32Schema,
    parent_spec_hash: Hex32Schema,
    kind: NodeKindSchema,
    max_budget: z.bigint().min(0n).max((1n << 64n) - 1n),
    max_fee: z.bigint().min(0n).max((1n << 64n) - 1n),
    payee_hash: Hex28Schema,
    acceptance_hash: Hex32Schema,
  })
  .strict()
  .refine(
    (l) => (l.kind === "AddressPayment") === (l.payee_hash !== ZERO_28),
    "payee_hash is a non-zero key hash exactly for AddressPayment leaves",
  );

export const ProofStepSchema: z.ZodType<ProofStep> = z
  .object({ sibling: Hex32Schema, sibling_on_left: z.boolean() })
  .strict();

export const ChildDrawSchema: z.ZodType<ChildDraw> = z
  .object({ out: UIntSchema, external_out: UIntSchema.nullable(), leaf: PlanLeafSchema, proof: z.array(ProofStepSchema) })
  .strict();

export const ParentLinkSchema: z.ZodType<ParentLink> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ParentNode"), parent_in: UIntSchema, parent_out: UIntSchema }).strict(),
  z.object({ type: z.literal("RootExit"), config_in: UIntSchema, refund_out: UIntSchema }).strict(),
]);

export const SplitSchema: z.ZodType<Split> = z.object({ worker: UIntSchema, parent: UIntSchema }).strict();

export const BondRulingSchema: z.ZodType<BondRuling> = z
  .object({ bond_in: UIntSchema, ruling: RulingSchema, outs: z.array(UIntSchema) })
  .strict();

const io = { node_in: UIntSchema, node_out: UIntSchema };

export const ActionSchema: z.ZodType<Action> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("FundRoot"), seed: OutputReferenceSchema, root_out: UIntSchema, config_out: UIntSchema }).strict(),
  z.object({ type: z.literal("TopUp"), ...io, amount: z.bigint().positive() }).strict(),
  z
    .object({
      type: z.literal("Draw"),
      ...io,
      config_ref: UIntSchema,
      root_ref: UIntSchema.nullable(),
      children: z.array(ChildDrawSchema).min(1),
    })
    .strict(),
  z.object({ type: z.literal("Submit"), ...io, result_hash: Hex32Schema }).strict(),
  z.object({ type: z.literal("Accept"), ...io }).strict(),
  z
    .object({
      type: z.literal("Challenge"),
      ...io,
      reason_hash: Hex32Schema,
      challenger: Hex28Schema,
      challenger_address: KeyAddressSchema,
      bond_out: UIntSchema,
      config_ref: UIntSchema,
      parent_ref: UIntSchema.nullable(),
    })
    .strict(),
  z.object({ type: z.literal("Escalate"), ...io }).strict(),
  z
    .object({
      type: z.literal("Resolve"),
      node_in: UIntSchema,
      parent: ParentLinkSchema,
      config_ref: UIntSchema,
      split: SplitSchema,
      payee_out: UIntSchema,
      payee_lovelace: UIntSchema,
      bonds: z.array(BondRulingSchema),
    })
    .strict(),
  z.object({ type: z.literal("Refund"), node_in: UIntSchema, parent: ParentLinkSchema }).strict(),
  z
    .object({
      type: z.literal("SettleChild"),
      node_in: UIntSchema,
      parent_in: UIntSchema,
      parent_out: UIntSchema,
      payee_out: UIntSchema,
      payee_lovelace: UIntSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("CloseReceipt"),
      node_in: UIntSchema,
      parent_in: UIntSchema,
      parent_out: UIntSchema,
      channel_in: UIntSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("CloseRoot"),
      node_in: UIntSchema,
      config_in: UIntSchema,
      payee_out: UIntSchema,
      payee_lovelace: UIntSchema,
      protocol_lovelace: UIntSchema,
      protocol_out: UIntSchema.nullable(),
      refund_out: UIntSchema,
    })
    .strict(),
  z.object({ type: z.literal("Cancel"), node_in: UIntSchema, config_in: UIntSchema, refund_out: UIntSchema }).strict(),
  z.object({ type: z.literal("Freeze"), ...io }).strict(),
  z.object({ type: z.literal("Unfreeze"), ...io }).strict(),
]);

export const LogicRedeemerSchema: z.ZodType<LogicRedeemer> = z
  .object({ node_hash: Hex28Schema, actions: z.array(ActionSchema).min(1) })
  .strict()
  .refine((r) => new Set(r.actions.map((a) => logicScriptOf(a.type))).size === 1, "actions must all belong to one logic script");

export const ActionTypeSchema = z.enum(Object.keys(ACTION_INDEX) as [keyof typeof ACTION_INDEX, ...(keyof typeof ACTION_INDEX)[]]);
