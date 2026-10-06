/**
 * `BuyerTxBuilder` over `@cascade/sdk`: unsigned transactions for the buyer's (or arbiter's) CIP-30
 * wallet. The wallet is selected read-only from the change address and the UTxOs the browser sent,
 * so Lucid can balance; nothing here can sign.
 */
import { CML, coreToUtxo, type LucidEvolution, type UTxO } from "@lucid-evolution/lucid";
import { CascadeClient, type CascadeScripts, type ReferenceScripts } from "@cascade/sdk";
import {
  bytesToHex,
  jcsSha256Hex,
  paymentKeyHash,
  plutusAddressFromBech32,
  sha256,
  specHash,
  utf8,
  type AssetClass,
  type Plan,
  type TreeConfig,
} from "@cascade/shared";
import type { BuyerPolicy } from "@cascade/policy";
import { buyerPolicyFor, type BuyerTerms } from "../api/buyer-policy.js";
import type { BuyerAction, WalletContext } from "../api/schemas.js";
import type { TxSigner } from "./signer-client.js";
import type { BuyerTxBuilder } from "../api/server.js";

/**
 * The `arbiter_threshold` arbiters a Resolve names as required signers: the paying wallet first
 * when it is an arbiter, then the tree's other arbiters in Config order. With signer-held keys
 * (`held`), only those arbiters qualify.
 */
export function resolveSigners(arbiters: readonly string[], threshold: number, payer: string, held?: ReadonlySet<string>): string[] {
  const eligible = held === undefined ? arbiters : arbiters.filter((k) => held.has(k));
  const ordered = eligible.includes(payer) ? [payer, ...eligible.filter((k) => k !== payer)] : [...eligible];
  const signers = ordered.slice(0, threshold);
  if (signers.length < threshold) throw new Error(`${held === undefined ? "the tree names" : "the signer holds"} ${signers.length} of the ${threshold} arbiter keys this tree needs`);
  return signers;
}

/** Tree Config values the operator fixes for every tree it runs (PRD 7.3, 11.3). */
export interface TreeDefaults {
  arbiters: string[];
  arbiterThreshold: bigint;
  arbiterFeeAddress: string;
  masumiScriptHash: string;
  protocolFeeBps: bigint;
  protocolFeeAddress: string;
  challengeBondLovelace: bigint;
  slashWrongedBps: bigint;
}

export interface SdkBuyerTxOptions {
  lucid: LucidEvolution;
  scripts: CascadeScripts;
  refs: ReferenceScripts;
  /** Orchestrator operator address: the root's operator and payee. */
  operatorAddress: string;
  defaults: TreeDefaults;
  /** Records the plan (and its tree) with the buyer's policy where the signer's gates read them (indexer `plans`). */
  registerPlan: (plan: Plan, treeId: string, policy: BuyerPolicy) => Promise<void>;
  /** Base buyer policy; the buyer's intake choices override it. Defaults to `@cascade/policy` DEFAULT_BUYER_POLICY, the signer's own default. */
  basePolicy?: BuyerPolicy;
  /**
   * Testnet only: arbiter keys held by the signer service, by payment key hash -> signer role. When
   * set, resolve-tx collects arbiter signatures up to the tree's threshold before returning; the
   * console wallet then adds the fee payer's signature. On mainnet arbiters sign in their own wallets.
   */
  arbiterSigner?: { signer: TxSigner; roles: Map<string, string> };
}

/** The shortest dispute window any spec of the plan uses (always > 0: the schema requires it). */
export function minDisputeWindow(plan: Plan): bigint {
  let min: bigint | null = null;
  const walk = (n: Plan["root"]): void => {
    const w = BigInt(n.spec.deadlines.dispute_window_ms);
    if (min === null || w < min) min = w;
    n.children.forEach(walk);
  };
  walk(plan.root);
  if (min === null) throw new Error("plan has no specs");
  return min;
}

export const MASUMI_VESTED_PAY_V2_HASH = "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad";

export function assetClassOf(assetId: string): AssetClass {
  if (assetId === "lovelace") return { policy: "", name: "" };
  const [policy, name] = assetId.split(".");
  if (policy === undefined || name === undefined) throw new Error(`invalid asset id ${assetId}`);
  return { policy, name };
}

/** CIP-30 `getUtxos()` entries are CBOR `TransactionUnspentOutput` hex. */
export function utxosFromCip30(hex: readonly string[]): UTxO[] {
  return hex.map((h) => coreToUtxo(CML.TransactionUnspentOutput.from_cbor_hex(h)));
}

export class SdkBuyerTxBuilder implements BuyerTxBuilder {
  constructor(private readonly o: SdkBuyerTxOptions) {}

  private clientFor(wallet: WalletContext): CascadeClient {
    this.o.lucid.selectWallet.fromAddress(wallet.change_address, utxosFromCip30(wallet.utxos));
    return new CascadeClient(this.o.lucid, this.o.scripts, this.o.refs);
  }

  treeConfig(plan: Plan, buyerAddress: string, channelHash: string): Omit<TreeConfig, "tree_id"> {
    const d = this.o.defaults;
    return {
      buyer: paymentKeyHash(buyerAddress),
      buyer_refund: plutusAddressFromBech32(buyerAddress),
      asset: assetClassOf(plan.asset),
      arbiters: d.arbiters,
      arbiter_threshold: d.arbiterThreshold,
      arbiter_fee_address: plutusAddressFromBech32(d.arbiterFeeAddress),
      max_depth: BigInt(plan.limits.max_depth),
      max_fanout: BigInt(plan.limits.max_fanout),
      max_child_share_bps: BigInt(plan.limits.max_child_share_bps),
      min_challenge_window: BigInt(plan.limits.min_challenge_window_ms),
      min_safety_margin: BigInt(plan.limits.min_safety_margin_ms),
      // ADR 1.6 (E6): every node keeps at least this long between challenge_until and dispute_until.
      min_dispute_window: minDisputeWindow(plan),
      allowed_leaf_kinds: ["Native", "MasumiReceipt", "MeteredReceipt", "AddressPayment"],
      masumi_script_hash: d.masumiScriptHash,
      channel_script_hash: channelHash,
      plan_root: plan.plan_root,
      protocol_fee_bps: d.protocolFeeBps,
      protocol_fee_address: plutusAddressFromBech32(d.protocolFeeAddress),
      challenge_bond: d.challengeBondLovelace,
      slash_wronged_bps: d.slashWrongedBps,
    };
  }

  async fundRoot(plan: Plan, wallet: WalletContext, terms: BuyerTerms): Promise<{ tx_cbor: string; tree_id: string }> {
    const policy = buyerPolicyFor(this.o.basePolicy, terms);
    const client = this.clientFor(wallet);
    const root = plan.root.spec;
    const operator = paymentKeyHash(this.o.operatorAddress);
    const built = await client.fundRoot({
      config: this.treeConfig(plan, wallet.change_address, this.o.scripts.channelHash),
      root: {
        operator,
        payee: plutusAddressFromBech32(this.o.operatorAddress),
        budget: BigInt(plan.totals.budget),
        fee: BigInt(root.price.max_fee),
        structural: BigInt(plan.totals.structural_lovelace),
        spec_hash: specHash(root),
        input_hash: bytesToHex(sha256(utf8(`${plan.plan_id};${jcsSha256Hex({ task: root.task })}`))),
        submit_by: BigInt(plan.deadlines.submit_by),
        challenge_until: BigInt(plan.deadlines.challenge_until),
        refund_after: BigInt(plan.deadlines.refund_after),
        dispute_until: BigInt(plan.deadlines.dispute_until),
      },
    });
    await this.o.registerPlan(plan, built.treeId, policy);
    return { tx_cbor: built.cbor, tree_id: built.treeId };
  }

  async treeAction(treeId: string, action: BuyerAction, nodeId: string, wallet: WalletContext): Promise<{ tx_cbor: string }> {
    const client = this.clientFor(wallet);
    const buyer = paymentKeyHash(wallet.change_address);
    switch (action) {
      case "Accept":
        return { tx_cbor: (await client.accept(nodeId, [buyer])).cbor };
      case "Challenge": {
        const reasonHash = jcsSha256Hex({ by: "buyer", tree_id: treeId, node_id: nodeId });
        return { tx_cbor: (await client.challenge({ nodeId, reasonHash, challenger: buyer, challengerAddress: wallet.change_address })).cbor };
      }
      case "Freeze":
        return { tx_cbor: (await client.freeze(treeId)).cbor };
      case "Unfreeze":
        return { tx_cbor: (await client.unfreeze(treeId)).cbor };
    }
  }

  /**
   * Arbiter ruling on a Challenged or Disputed node (PRD 11.1 L3). The challenger's bond is returned
   * when the parent wins and slashed when the worker wins (PRD 11.3). Required signers are
   * `arbiter_threshold` arbiters (`resolveSigners`); signer-held arbiters' witnesses are added here,
   * otherwise the paying arbiter's wallet and its co-arbiters sign.
   */
  async resolve(treeId: string, nodeId: string, split: { worker: bigint; parent: bigint }, wallet: WalletContext): Promise<{ tx_cbor: string }> {
    const client = this.clientFor(wallet);
    const cfg = await client.config(treeId);
    const held = this.o.arbiterSigner;
    const arbiters = resolveSigners(cfg.config.arbiters, Number(cfg.config.arbiter_threshold), paymentKeyHash(wallet.change_address), held === undefined ? undefined : new Set(held.roles.keys()));
    const workerWins = split.worker > 0n;
    const bonds = (await client.bonds(nodeId))
      .filter((b) => b.datum.role === "Challenger")
      .map((bond) => ({ bond, ruling: workerWins ? ("SlashBond" as const) : ("ReturnBond" as const) }));
    const built = await client.resolve({ nodeId, mode: "ruling", split, signers: arbiters, bonds });
    if (held === undefined) return { tx_cbor: built.cbor };
    let tx = built.cbor;
    for (const key of arbiters) {
      const role = held.roles.get(key);
      if (role === undefined) throw new Error(`no signer role for arbiter ${key}`);
      tx = await held.signer.sign(role, tx);
    }
    return { tx_cbor: tx };
  }
}
