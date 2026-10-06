/**
 * Metered leaf, payer side (PRD 8.6, ADR 9): a sub-hiring agent (Pricer) draws a MeteredReceipt
 * whose channel holds the deposit, signs cumulative Ed25519 vouchers per call off chain, and closes
 * the receipt once the provider has redeemed. On chain: Draw, one batch redeem (provider), and a
 * co-signed close: three L1 transactions for any number of calls.
 */
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import { CascadeClient, tipTime, type CascadeScripts, type ReferenceScripts } from "@cascade/sdk";
import { bytesToHex, planProof, PlanSchema, plutusAddressFromBech32, signVoucher, specHash, type ChannelDatum, type NodeSpec, type Plan } from "@cascade/shared";
import { acceptanceForSpec, submitOwnTx, type TxSigner } from "@cascade/orchestrator";

/** Fetches the buyer-approved plan from the Conductor and checks it is the one the tree committed to on chain. */
export async function fetchTreePlan(plansApi: string, planId: string, treeId: string, client: CascadeClient, fetchImpl: typeof fetch = fetch): Promise<Plan> {
  const res = await fetchImpl(`${plansApi.replace(/\/$/, "")}/v1/plans/${encodeURIComponent(planId)}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`plan ${planId} answered ${res.status}`);
  const plan = PlanSchema.parse(((await res.json()) as { plan: unknown }).plan);
  const onChain = (await client.config(treeId)).config.plan_root;
  if (plan.plan_root !== onChain) throw new Error(`plan ${planId} has root ${plan.plan_root}, the tree committed to ${onChain}`);
  return plan;
}

export interface VoucherChannelOptions {
  lucid: LucidEvolution;
  scripts: CascadeScripts;
  refs: ReferenceScripts;
  signer: TxSigner;
  /** Signer role and address of the payer (the receipt operator, e.g. Pricer). */
  role: string;
  payerAddress: string;
  /** Extra time beyond the spec's work time before the receipt's submit_by. */
  slackMs?: number;
}

export class VoucherChannel {
  private amount = 0n;
  private constructor(
    private readonly o: VoucherChannelOptions,
    private readonly client: CascadeClient,
    readonly treeId: string,
    readonly receiptId: string,
    readonly deposit: bigint,
    private readonly voucherKey: Uint8Array,
    readonly txIds: string[],
  ) {}

  /** Draws the MeteredReceipt under `parentNodeId` for `spec`, paying `providerAddress`. */
  static async open(o: VoucherChannelOptions, p: { treeId: string; parentNodeId: string; plan: Plan; spec: NodeSpec; providerAddress: string }): Promise<VoucherChannel> {
    const client = new CascadeClient(o.lucid, o.scripts, o.refs);
    o.lucid.selectWallet.fromAddress(o.payerAddress, await o.lucid.utxosAt(o.payerAddress));
    const parent = await client.node(p.parentNodeId);
    const cfg = await client.config(p.treeId);
    const { leaf, proof } = planProof(p.plan.root, p.spec.id);
    const voucherKey = new Uint8Array(randomBytes(32));
    const now = BigInt(tipTime(o.lucid));
    const d = p.spec.deadlines;
    const submitBy = now + BigInt(d.work_ms) + BigInt(o.slackMs ?? 30_000);
    const challengeUntil = submitBy + (BigInt(d.challenge_window_ms) > cfg.config.min_challenge_window ? BigInt(d.challenge_window_ms) : cfg.config.min_challenge_window);
    const disputeUntil = challengeUntil + BigInt(d.dispute_window_ms);
    const deposit = BigInt(p.spec.price.max_budget);
    const built = await client.draw(p.parentNodeId, [
      {
        kind: "metered",
        leaf,
        proof,
        operator: parent.datum.operator,
        payee: plutusAddressFromBech32(p.providerAddress),
        budget: deposit,
        input_hash: bytesToHex(new Uint8Array(32)),
        acceptance: acceptanceForSpec(p.spec, parent.datum.operator),
        submit_by: submitBy,
        challenge_until: challengeUntil,
        refund_after: submitBy,
        dispute_until: disputeUntil,
        payerVkey: bytesToHex(ed25519.getPublicKey(voucherKey)),
        timeout: disputeUntil,
      },
    ]);
    const receiptId = built.childIds[0];
    if (receiptId === undefined) throw new Error("the Draw created no receipt");
    const txId = await submitOwnTx(o.lucid, await o.signer.sign(o.role, built.cbor), "Draw");
    return new VoucherChannel(o, client, p.treeId, receiptId, deposit, voucherKey, [txId]);
  }

  /** Cumulative voucher for one more call at `price`. */
  next(price: bigint): { tree_id: string; node_id: string; amount: string; signature: string } {
    const amount = this.amount + price;
    if (amount > this.deposit) throw new Error(`the channel deposit ${this.deposit} is spent`);
    this.amount = amount;
    return { tree_id: this.treeId, node_id: this.receiptId, amount: amount.toString(), signature: signVoucher(this.voucherKey, this.treeId, this.receiptId, amount) };
  }

  get spent(): bigint {
    return this.amount;
  }

  /** Builds the close (operator and provider sign), has the provider co-sign it, signs, submits. */
  async close(cosign: (txCbor: string) => Promise<string>): Promise<string> {
    this.o.lucid.selectWallet.fromAddress(this.o.payerAddress, await this.o.lucid.utxosAt(this.o.payerAddress));
    const built = await this.client.closeReceipt(this.receiptId, "both");
    const signed = await this.o.signer.sign(this.o.role, await cosign(built.cbor));
    const txId = await submitOwnTx(this.o.lucid, signed, "CloseReceipt");
    this.txIds.push(txId);
    return txId;
  }
}



/** Metered leaf, provider side: read channels, batch-redeem the latest vouchers, co-sign closes. */
export interface ProviderChannelOps {
  channel(receiptId: string): Promise<ChannelDatum>;
  redeem(claims: { receiptId: string; amount: bigint; signature: string }[]): Promise<string>;
  cosign(txCbor: string): Promise<string>;
}

/**
 * A TxSigner over a wallet key held by the caller (a third-party provider's own wallet), adding its
 * vkey witness to whatever witnesses the transaction already carries.
 */
export function privateKeyTxSigner(lucid: LucidEvolution, privateKeyBech32: string): TxSigner {
  return {
    async sign(_role, txCbor) {
      const signed = await lucid.fromTx(txCbor).sign.withPrivateKey(privateKeyBech32).complete();
      return signed.toCBOR();
    },
  };
}

/**
 * `redeemSigner`: who signs the provider's channel redeem. The Lookup API is a third-party x402
 * provider (PRD 21.1), so by default it signs its redeem with its own wallet key, outside the Cascade
 * spend policy; the CloseReceipt co-signature (a Cascade action) goes through `signer`.
 */
export function providerChannelOps(o: { lucid: LucidEvolution; scripts: CascadeScripts; refs: ReferenceScripts; signer: TxSigner; role: string; providerAddress: string; redeemSigner?: TxSigner }): ProviderChannelOps {
  const client = new CascadeClient(o.lucid, o.scripts, o.refs);
  return {
    channel: async (receiptId) => (await client.channel(receiptId)).datum,
    async redeem(claims) {
      o.lucid.selectWallet.fromAddress(o.providerAddress, await o.lucid.utxosAt(o.providerAddress));
      const built = await client.redeemChannels(claims);
      return submitOwnTx(o.lucid, await (o.redeemSigner ?? o.signer).sign(o.role, built.cbor), "RedeemChannels");
    },
    cosign: (txCbor) => o.signer.sign(o.role, txCbor),
  };
}

/**
 * Resolves, for a job bound to `nodeId`, the tree's plan (from the Conductor named in the job
 * context, checked against the on-chain plan_root) and the metered child spec of that node.
 */
export function meteredPlanResolver(client: CascadeClient, fetchImpl: typeof fetch = fetch) {
  return async (treeId: string, nodeId: string, context: Record<string, unknown>): Promise<{ plan: Plan; spec: NodeSpec }> => {
    const planId = context["plan_id"];
    const plansApi = context["plans_api"];
    if (typeof planId !== "string" || typeof plansApi !== "string") throw new Error("the job context names no plan_id and plans_api");
    const plan = await fetchTreePlan(plansApi, planId, treeId, client, fetchImpl);
    const own = (await client.node(nodeId)).datum.spec_hash;
    const find = (n: Plan["root"]): Plan["root"] | null => (specHash(n.spec) === own ? n : n.children.map(find).find((x) => x !== null) ?? null);
    const mine = find(plan.root);
    const metered = mine?.children.find((c) => c.spec.rail === "metered");
    if (metered === undefined) throw new Error(`the plan has no metered child under node ${nodeId}`);
    return { plan, spec: metered.spec };
  };
}
