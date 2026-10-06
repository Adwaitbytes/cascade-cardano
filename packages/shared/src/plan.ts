/**
 * Plan, node spec, quote and verdict schemas (PRD 9.2, 10.1, 11.2) with JCS hashing, the plan
 * Merkle root (ADR 3) and COSE signing of quotes and verdicts (PRD 9.5).
 *
 * Wire conventions: amounts are canonical decimal strings (never JSON numbers), durations and
 * POSIX-ms times are JSON safe integers, hashes are lowercase hex. Every object is closed, so a
 * spec hash has exactly one preimage shape.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { z } from "zod";
import { bytesToHex } from "./bytes.js";
import { coseKeyFromPublicKey, signCose1, verifyCose1, type CoseVerifyResult } from "./cose.js";
import { nodeDeadlineErrors, nodeWindow, type NodeTiming, type NodeWindow } from "./deadlines.js";
import { jcsSha256, jcsSha256Hex, type JsonValue } from "./jcs.js";
import { acceptanceHash, merkleProof, merkleRoot, ZERO_HASH, ZERO_PAYEE_HASH } from "./merkle.js";
import { Hex28Schema, Hex32Schema } from "./schemas.js";
import type { Acceptance, Hex32, NodeKind, PlanLeaf, ProofStep } from "./types.js";

export * from "./merkle.js";

// ---------------------------------------------------------------------------------------------
// Primitives

/** Canonical non-negative decimal integer string, no leading zeros. */
export const AmountSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/, "canonical decimal integer string");
const U64_MAX = (1n << 64n) - 1n;
const AmountU64Schema = AmountSchema.refine((s) => BigInt(s) <= U64_MAX, "must fit in 64 bits");

/** x402 asset id: `lovelace` or `<policy hex 56>.<asset name hex 0..64>`, lowercase. */
export const AssetIdSchema = z.string().regex(/^(?:lovelace|[0-9a-f]{56}\.(?:[0-9a-f]{2}){0,32})$/, "lovelace or policy.name hex");

/** Masumi registry asset id: 28-byte policy followed by the asset name, lowercase hex. */
export const AgentIdSchema = z.string().regex(/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/, "registry asset id hex");

export const MsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveMsSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const BpsSchema = z.number().int().min(0).max(10_000);
const SpecIdSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, "1-64 chars of A-Z a-z 0-9 _ . -");
const Bech32AddressSchema = z.string().regex(/^addr(?:_test)?1[02-9ac-hj-np-z]{6,}$/, "bech32 payment address");

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);
/** A JSON Schema document (an object). */
export const JsonSchemaObjectSchema = z.record(z.string(), JsonValueSchema);

// ---------------------------------------------------------------------------------------------
// NodeSpec

export const RAILS = ["native", "masumi", "metered", "address"] as const;
export const RailSchema = z.enum(RAILS);
export type Rail = z.infer<typeof RailSchema>;

export const RAIL_KIND: Record<Rail, NodeKind> = {
  native: "Native",
  masumi: "MasumiReceipt",
  metered: "MeteredReceipt",
  address: "AddressPayment",
};

export const AcceptanceRuleSchema = z.enum(["ParentAccept", "VerifierQuorum", "AutoAfterWindow", "BuyerAccept"]);

export const VerifierConfigSchema = z
  .object({
    /** L0 deterministic checks by name, e.g. `schema`, `result_hash`, `sources`. */
    deterministic: z.array(z.string().min(1).max(64)).min(1),
    /** L1 verifier quorum; required exactly when acceptance is `VerifierQuorum`. */
    quorum: z
      .object({
        n: z.number().int().min(1).max(9),
        k: z.number().int().min(1).max(9),
        fee: AmountSchema,
        bond_lovelace: AmountSchema,
        /** Verifier key hashes in datum order; bound into the leaf's acceptance_hash (ADR 1.6, E7). */
        keys: z.array(Hex28Schema).min(1).max(9),
      })
      .strict()
      .refine((q) => q.k <= q.n, "k must be <= n")
      .refine((q) => q.keys.length === q.n, "keys must list exactly n verifiers")
      .nullable(),
    /** L2 challenge window open. */
    challenge: z.boolean(),
    /** L3 arbitration available. */
    arbitration: z.boolean(),
  })
  .strict();

export const SpecTimingSchema = z
  .object({ work_ms: MsSchema, compose_ms: MsSchema, challenge_window_ms: MsSchema, dispute_window_ms: PositiveMsSchema })
  .strict();

export const NodeSpecSchema = z
  .object({
    version: z.literal("1"),
    id: SpecIdSchema,
    task: z.string().min(1).max(4000),
    category: z.string().min(1).max(64),
    input_schema: JsonSchemaObjectSchema,
    output_schema: JsonSchemaObjectSchema,
    acceptance: AcceptanceRuleSchema,
    rail: RailSchema,
    price: z.object({ asset: AssetIdSchema, max_budget: AmountU64Schema, max_fee: AmountU64Schema }).strict(),
    deadlines: SpecTimingSchema,
    may_sub_hire: z.boolean(),
    max_sub_budget_share_bps: BpsSchema,
    verifier: VerifierConfigSchema,
    /** Seller payment key hash; present exactly for the `address` rail (ADR 5.2). */
    payee_hash: Hex28Schema.refine((h) => h !== ZERO_PAYEE_HASH, "payee_hash must not be zero").optional(),
    /**
     * ADR 8.1: this address payment funds the purchase wallet P, which then buys from the named
     * Masumi seller (registry asset id). Only on the `address` rail.
     */
    masumi_followup: z.object({ agent_identifier: AgentIdSchema }).strict().optional(),
  })
  .strict()
  .refine((s) => BigInt(s.price.max_fee) <= BigInt(s.price.max_budget), "max_fee must be <= max_budget")
  .refine((s) => (s.acceptance === "VerifierQuorum") === (s.verifier.quorum !== null), "verifier.quorum is set exactly for VerifierQuorum")
  .refine((s) => s.rail === "native" || !s.may_sub_hire, "only native nodes may sub-hire")
  .refine((s) => (s.rail === "address") === (s.payee_hash !== undefined), "payee_hash is set exactly for the address rail")
  .refine((s) => s.rail !== "address" || s.price.max_fee === "0", "an address payment has no fee")
  .refine((s) => s.rail !== "address" || s.acceptance === "AutoAfterWindow", "an address payment uses AutoAfterWindow (it is final at Draw)")
  .refine((s) => s.masumi_followup === undefined || s.rail === "address", "masumi_followup is allowed only on the address rail (ADR 8.1)");
export type NodeSpec = z.infer<typeof NodeSpecSchema>;

/** `spec_hash = SHA-256(JCS(spec))`. */
export const specHash = (spec: NodeSpec): Hex32 => jcsSha256Hex(spec);

// ---------------------------------------------------------------------------------------------
// Plan

export const AgentRefSchema = z
  .object({ agent_id: AgentIdSchema, quote_id: z.string().min(1).max(128).nullable(), price: AmountSchema })
  .strict();
export type AgentRef = z.infer<typeof AgentRefSchema>;

export interface PlanNode {
  spec: NodeSpec;
  agents: { primary: AgentRef; fallbacks: AgentRef[] };
  children: PlanNode[];
}

export const PlanNodeSchema: z.ZodType<PlanNode> = z
  .object({
    spec: NodeSpecSchema,
    agents: z.object({ primary: AgentRefSchema, fallbacks: z.array(AgentRefSchema) }).strict(),
    get children(): z.ZodArray<z.ZodType<PlanNode>> {
      return z.array(PlanNodeSchema);
    },
  })
  .strict();

export const PlanLimitsSchema = z
  .object({
    max_depth: z.number().int().min(0).max(64),
    max_fanout: z.number().int().min(1).max(256),
    max_child_share_bps: BpsSchema,
    min_challenge_window_ms: MsSchema,
    min_safety_margin_ms: MsSchema,
  })
  .strict();

export const PlanDeadlinesSchema = z
  .object({ fund_by: MsSchema, submit_by: MsSchema, challenge_until: MsSchema, refund_after: MsSchema, dispute_until: MsSchema })
  .strict();

export const PlanSchema = z
  .object({
    version: z.literal("1"),
    plan_id: z.string().min(1).max(128),
    asset: AssetIdSchema,
    limits: PlanLimitsSchema,
    root: PlanNodeSchema,
    totals: z
      .object({ budget: AmountSchema, fees: AmountSchema, structural_lovelace: AmountSchema, reserve: AmountSchema })
      .strict(),
    deadlines: PlanDeadlinesSchema,
    plan_root: Hex32Schema,
  })
  .strict();
export type Plan = z.infer<typeof PlanSchema>;

/** Pre-order walk (node, then its children in order): the leaf order of the plan Merkle tree. */
export function planNodesPreOrder(root: PlanNode): { node: PlanNode; parent: PlanNode | null; depth: number }[] {
  const out: { node: PlanNode; parent: PlanNode | null; depth: number }[] = [];
  const visit = (node: PlanNode, parent: PlanNode | null, depth: number): void => {
    out.push({ node, parent, depth });
    for (const c of node.children) visit(c, node, depth + 1);
  };
  visit(root, null, 0);
  return out;
}

/**
 * The acceptance a node drawn from `spec` will carry, for `acceptance_hash`. ParentAccept and
 * BuyerAccept keys are resolved at Draw and are not part of the hash, so a placeholder is used.
 */
export function specAcceptance(spec: NodeSpec): Acceptance {
  const none = "00".repeat(28);
  switch (spec.acceptance) {
    case "ParentAccept":
      return { type: "ParentAccept", key: none };
    case "BuyerAccept":
      return { type: "BuyerAccept", key: none };
    case "AutoAfterWindow":
      return { type: "AutoAfterWindow" };
    case "VerifierQuorum": {
      const q = spec.verifier.quorum;
      if (q === null) throw new Error(`spec ${spec.id}: VerifierQuorum needs verifier.quorum`);
      return { type: "VerifierQuorum", keys: q.keys, k: BigInt(q.k) };
    }
  }
}

export function planLeafFor(spec: NodeSpec, parentSpec: NodeSpec | null): PlanLeaf {
  return {
    spec_hash: specHash(spec),
    parent_spec_hash: parentSpec === null ? ZERO_HASH : specHash(parentSpec),
    kind: RAIL_KIND[spec.rail],
    max_budget: BigInt(spec.price.max_budget),
    max_fee: BigInt(spec.price.max_fee),
    payee_hash: spec.payee_hash ?? ZERO_PAYEE_HASH,
    acceptance_hash: acceptanceHash(specAcceptance(spec)),
  };
}

/** Plan leaves in pre-order. The root is leaf 0 with `parent_spec_hash` = 32 zero bytes. */
export const planLeaves = (root: PlanNode): PlanLeaf[] =>
  planNodesPreOrder(root).map(({ node, parent }) => planLeafFor(node.spec, parent?.spec ?? null));

export const computePlanRoot = (root: PlanNode): Hex32 => merkleRoot(planLeaves(root));

/** Leaf and Merkle proof for the node whose spec id is `specId`, ready for a Draw `ChildDraw`. */
export function planProof(root: PlanNode, specId: string): { leaf: PlanLeaf; proof: ProofStep[] } {
  const leaves = planLeaves(root);
  const index = planNodesPreOrder(root).findIndex(({ node }) => node.spec.id === specId);
  if (index < 0) throw new Error(`spec ${specId} is not in the plan`);
  return { leaf: leaves[index] as PlanLeaf, proof: merkleProof(leaves, index) };
}

const timingOf = (spec: NodeSpec): NodeTiming => ({
  work_ms: BigInt(spec.deadlines.work_ms),
  compose_ms: BigInt(spec.deadlines.compose_ms),
  challenge_window_ms: BigInt(spec.deadlines.challenge_window_ms),
  dispute_window_ms: BigInt(spec.deadlines.dispute_window_ms),
});

/** Minimal window of every subtree (PRD 7.7), keyed by spec id. */
export function planWindows(plan: Plan): Map<string, NodeWindow> {
  const windows = new Map<string, NodeWindow>();
  const margin = BigInt(plan.limits.min_safety_margin_ms);
  const visit = (node: PlanNode): NodeWindow => {
    const w = nodeWindow(node.spec.rail, timingOf(node.spec), node.children.map(visit), margin, { masumiFollowup: node.spec.masumi_followup !== undefined });
    windows.set(node.spec.id, w);
    return w;
  };
  visit(plan.root);
  return windows;
}

/**
 * Deterministic plan checks (PRD 10.1 step 3): shape, caps, budgets, deadline algebra and the
 * Merkle root. Returns every violation; an empty list means the plan is valid.
 */
export function validatePlan(plan: Plan): string[] {
  const errors: string[] = [];
  const { limits } = plan;
  const nodes = planNodesPreOrder(plan.root);
  const seen = new Set<string>();
  const seenHashes = new Set<string>();

  const root = plan.root.spec;
  if (root.rail !== "native") errors.push("root: rail must be native");
  if (root.acceptance !== "BuyerAccept") errors.push("root: acceptance must be BuyerAccept (forced at FundRoot)");
  if (plan.totals.budget !== root.price.max_budget) errors.push("totals.budget must equal the root max_budget");

  let fees = 0n;
  for (const { node, depth } of nodes) {
    const s = node.spec;
    const at = `spec ${s.id}`;
    if (seen.has(s.id)) errors.push(`${at}: duplicate spec id`);
    seen.add(s.id);
    const hash = specHash(s);
    if (seenHashes.has(hash)) errors.push(`${at}: duplicate spec hash`);
    seenHashes.add(hash);
    fees += BigInt(s.price.max_fee);
    if (s.masumi_followup !== undefined && s.rail !== "address") errors.push(`${at}: masumi_followup is allowed only on the address rail`);
    if (s.price.asset !== plan.asset) errors.push(`${at}: asset ${s.price.asset} differs from plan asset ${plan.asset}`);
    if (depth > limits.max_depth) errors.push(`${at}: depth ${depth} exceeds max_depth ${limits.max_depth}`);
    if (s.deadlines.challenge_window_ms < limits.min_challenge_window_ms) errors.push(`${at}: challenge window below min_challenge_window`);
    if (node.children.length === 0) continue;

    if (!s.may_sub_hire) errors.push(`${at}: has children but may_sub_hire is false`);
    if (node.children.length > limits.max_fanout) errors.push(`${at}: fan-out ${node.children.length} exceeds max_fanout ${limits.max_fanout}`);
    const budget = BigInt(s.price.max_budget);
    let childSum = 0n;
    for (const c of node.children) {
      const cb = BigInt(c.spec.price.max_budget);
      childSum += cb;
      if (cb * 10_000n > budget * BigInt(limits.max_child_share_bps)) errors.push(`spec ${c.spec.id}: exceeds max_child_share_bps of its parent`);
    }
    if (childSum + BigInt(s.price.max_fee) > budget) errors.push(`${at}: children budgets plus fee exceed max_budget`);
    if (childSum * 10_000n > budget * BigInt(s.max_sub_budget_share_bps)) errors.push(`${at}: children budgets exceed max_sub_budget_share_bps`);
  }
  if (plan.totals.fees !== fees.toString()) errors.push(`totals.fees must equal the sum of max_fee (${fees})`);

  const d = plan.deadlines;
  errors.push(
    ...nodeDeadlineErrors(
      { submit_by: BigInt(d.submit_by), challenge_until: BigInt(d.challenge_until), refund_after: BigInt(d.refund_after), dispute_until: BigInt(d.dispute_until) },
      BigInt(limits.min_challenge_window_ms),
    ).map((e) => `root deadlines: ${e}`),
  );
  if (BigInt(d.challenge_until - d.submit_by) < BigInt(root.deadlines.challenge_window_ms)) errors.push("root deadlines: challenge window shorter than the root spec");
  try {
    const rootWindow = planWindows(plan).get(root.id);
    if (rootWindow !== undefined && BigInt(d.fund_by) + rootWindow.submit_offset > BigInt(d.submit_by)) {
      errors.push(`root deadlines: deepest path needs submit_by >= fund_by + ${rootWindow.submit_offset} ms`);
    }
  } catch (e) {
    errors.push(`deadline algebra: ${(e as Error).message}`);
  }

  if (computePlanRoot(plan.root) !== plan.plan_root) errors.push("plan_root does not match the Merkle root of the node specs");
  return errors;
}

// ---------------------------------------------------------------------------------------------
// Signed JSON bodies (quotes, verdicts, subtree reports)

/** 32-byte hash that is signed: `SHA-256(JCS(body without "signature"))`. */
export function signedBodyHash<T extends { signature?: string }>(body: T): Uint8Array {
  const { signature: _omit, ...unsigned } = body;
  return jcsSha256(unsigned);
}

// ---------------------------------------------------------------------------------------------
// Quote (PRD 9.2 `/cascade/quote`)

export const QuoteRequestSchema = z
  .object({
    spec: NodeSpecSchema,
    spec_hash: Hex32Schema,
    window: z.object({ start_by: MsSchema, submit_by: MsSchema }).strict(),
  })
  .strict()
  .refine((r) => specHash(r.spec) === r.spec_hash, "spec_hash must equal SHA-256(JCS(spec))");
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

export const QuoteSchema = z
  .object({
    version: z.literal("1"),
    quote_id: z.string().min(1).max(128),
    agent_id: AgentIdSchema,
    spec_hash: Hex32Schema,
    price: AmountSchema,
    asset: AssetIdSchema,
    eta_ms: PositiveMsSchema,
    rails: z.array(RailSchema).min(1),
    may_sub_hire: z.boolean(),
    max_sub_budget_share_bps: BpsSchema,
    operator: Hex28Schema,
    /** Key address whose payment key signs the quote and receives the fee. */
    payee: Bech32AddressSchema,
    issued_at: MsSchema,
    expires_at: MsSchema,
    /** CBOR `COSE_Key` hex of the signing key. */
    key: z.string().regex(/^[0-9a-f]+$/),
    /** CBOR `COSE_Sign1` hex over `SHA-256(JCS(quote without signature))`. */
    signature: z.string().regex(/^[0-9a-f]+$/),
  })
  .strict()
  .refine((q) => q.expires_at > q.issued_at, "expires_at must be after issued_at");
export type Quote = z.infer<typeof QuoteSchema>;

export function signQuote(unsigned: Omit<Quote, "key" | "signature">, secretKey: Uint8Array): Quote {
  const key = bytesToHex(coseKeyFromPublicKey(ed25519.getPublicKey(secretKey)));
  const body = { ...unsigned, key };
  const { signature } = signCose1({ payload: jcsSha256(body), secretKey, address: unsigned.payee });
  return { ...body, signature };
}

export const verifyQuote = (quote: Quote): CoseVerifyResult =>
  verifyCose1({ signature: quote.signature, key: quote.key }, { payload: signedBodyHash(quote), address: quote.payee });

// ---------------------------------------------------------------------------------------------
// Verdict (PRD 11.2 plus `key`, per DECISIONS.md)

export const VerdictCheckSchema = z
  .object({ name: z.string().min(1).max(64), passed: z.boolean(), detail_hash: Hex32Schema.optional() })
  .strict();

export const VerdictSchema = z
  .object({
    tree_id: Hex28Schema,
    node_id: Hex28Schema,
    result_hash: Hex32Schema,
    verdict: z.enum(["accept", "reject"]),
    score: z.number().min(0).max(1),
    checks: z.array(VerdictCheckSchema),
    evidence_hash: Hex32Schema,
    verifier: AgentIdSchema,
    /** Signer's CBOR `COSE_Key` hex. */
    key: z.string().regex(/^[0-9a-f]+$/),
    /** CBOR `COSE_Sign1` hex over `SHA-256(JCS(verdict without signature and key))`. */
    signature: z.string().regex(/^[0-9a-f]+$/),
  })
  .strict();
export type Verdict = z.infer<typeof VerdictSchema>;

/** The 32-byte hash a verdict signs: `SHA-256(JCS(verdict without signature and key))`. */
export function verdictSigningHash(verdict: Omit<Verdict, "signature" | "key"> & Partial<Pick<Verdict, "signature" | "key">>): Uint8Array {
  const { signature: _signature, key: _key, ...body } = verdict;
  return jcsSha256(body);
}

/** Sign a verdict with the payment key behind the verifier's `address` (bech32). */
export function signVerdict(unsigned: Omit<Verdict, "signature" | "key">, secretKey: Uint8Array, address: string): Verdict {
  const { signature, key } = signCose1({ payload: verdictSigningHash(unsigned), secretKey, address });
  return { ...unsigned, key, signature };
}

/**
 * Verify a verdict against the verifier's payment address, including the Blake2b-224
 * key-to-address check. The address comes from the verifier's registry entry, never from the verdict.
 */
export const verifyVerdict = (verdict: Verdict, address: string): CoseVerifyResult =>
  verifyCose1({ signature: verdict.signature, key: verdict.key }, { payload: verdictSigningHash(verdict), address });
