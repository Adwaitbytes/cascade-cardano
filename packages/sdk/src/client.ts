/**
 * Cascade tree client: reads tree state and builds one transaction per ADR 5.1 action.
 *
 * Every builder:
 * - spends node, config and bond inputs with an ignored spend redeemer, and runs exactly one logic
 *   withdrawal of 0 (core, draw or ext, never two, ADR 1.3 and 1.4) whose `LogicRedeemer` indices are computed
 *   from the final, balanced transaction (inputs and reference inputs in ledger order);
 * - takes every script from reference inputs;
 * - bounds validity by the action's deadline and at most 240 s ahead of the tip;
 * - evaluates the finished transaction through the provider (Ogmios on Yaci and preprod) and
 *   throws on any script failure before returning.
 * The returned transaction is unsigned: callers add every required signature.
 */
import { CML, Data, type Assets, type EvalRedeemer, type LucidEvolution, type OutRef, type TxBuilder, type TxSignBuilder, type UTxO } from "@lucid-evolution/lucid";
import {
  childTokenName,
  configTokenName,
  decodeBondDatum,
  decodeNodeDatum,
  decodeTreeConfig,
  acceptanceHash,
  encodeBondDatum,
  encodeChannelDatum,
  encodeChannelRedeemer,
  encodeMasumiDatum,
  decodeChannelDatum,
  masumiCollateralLovelace,
  masumiMinUtxoLovelace,
  channelTokenName,
  type ChannelDatum,
  type MasumiDatum,
  encodeLogicRedeemer,
  encodeNodeDatum,
  encodeTreeConfig,
  logicScriptOf,
  minUtxoForOutput,
  plutusAddressFromBech32,
  plutusAddressToBech32,
  rootTokenName,
  type Acceptance,
  type Action,
  type BondDatum,
  type BondRuling,
  type ChildDraw,
  type LogicScript,
  type NodeDatum,
  type PlanLeaf,
  type PlutusAddress,
  type ProofStep,
  type Ruling,
  type Split,
  type TreeConfig,
} from "@cascade/shared";
import { cascadeAddresses, type CascadeAddresses, type CascadeScripts } from "./blueprint.js";
import { confirm, isStaleInputs, type ReferenceScripts } from "./deploy.js";

export { isStaleInputs } from "./deploy.js";
import { attachWitness, type KeySigner } from "./witness.js";
import { DEFAULT_TIP_LAG_MS, LOCAL_TIP_LAG_MS, windowAfter, windowBefore, type ValidityWindow } from "./time.js";
import { addAssets, assertNonNegative, assetPlusLovelace, isLovelace, negate, nodeValue } from "./values.js";

/** Upper bound on payee lovelace beside a fee, mirrored from the validator (`max_payee_lovelace`). */
export const MAX_PAYEE_LOVELACE = 2_000_000n;

export interface BuiltTx {
  tx: TxSignBuilder;
  txHash: string;
  /** Unsigned transaction CBOR hex. */
  cbor: string;
  /** Execution units per redeemer, from the provider's evaluation. */
  evaluation: EvalRedeemer[];
  /** The logic script whose withdrawal validates the actions; null for a bond reclaim. */
  logic: LogicScript | null;
  /** Key hashes that must sign besides the fee payer. */
  signers: string[];
}

export class CascadeTxError extends Error {
  override readonly name = "CascadeTxError";
}

/** A node output would fall below min-UTxO; `shortfall` is the missing lovelace. */
export class StructuralShortfallError extends CascadeTxError {
  constructor(
    readonly nodeId: string,
    readonly shortfall: bigint,
  ) {
    super(`node ${nodeId} would hold ${shortfall} lovelace less than its min-UTxO (largest datum); add structural reserve`);
  }
}

export interface NodeRef {
  utxo: UTxO;
  datum: NodeDatum;
}

export interface ConfigRef {
  utxo: UTxO;
  config: TreeConfig;
}

export interface BondRef {
  utxo: UTxO;
  datum: BondDatum;
}

interface OutputPlan {
  address: string;
  assets: Assets;
  datum?: string;
}

interface Indexer {
  input(ref: OutRef): bigint;
  reference(ref: OutRef): bigint;
}

interface TxPlan {
  spend: UTxO[];
  /** Channel inputs spent through the `Close` path (ADR 9). */
  closeChannels?: UTxO[];
  walletInputs?: UTxO[];
  read: UTxO[];
  outputs: OutputPlan[];
  mint: Assets;
  signers: string[];
  window: ValidityWindow;
  actions: (ix: Indexer) => Action[];
}

/** The node rejected a tx whose inputs are already spent (stale indexer view), not a script failure. */

/** Ledger order of transaction inputs: by transaction id bytes, then output index. */
export function ledgerOrder<T extends OutRef>(refs: readonly T[]): T[] {
  return [...refs].sort((a, b) => (a.txHash === b.txHash ? a.outputIndex - b.outputIndex : a.txHash < b.txHash ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------
// Builder inputs

export interface RootParams {
  operator: string;
  payee: PlutusAddress;
  budget: bigint;
  fee: bigint;
  /** Structural reserve for the whole tree (PRD 7.8). Defaults to the root output's own min-UTxO. */
  structural?: bigint;
  spec_hash: string;
  input_hash: string;
  submit_by: bigint;
  challenge_until: bigint;
  refund_after: bigint;
  dispute_until: bigint;
}

export interface NativeChild {
  kind: "native";
  leaf: PlanLeaf;
  proof: ProofStep[];
  operator: string;
  payee: PlutusAddress;
  budget: bigint;
  fee: bigint;
  /** Lovelace moved from the parent's reserve. Defaults to the child output's min-UTxO. */
  structural?: bigint;
  input_hash: string;
  acceptance: Acceptance;
  submit_by: bigint;
  challenge_until: bigint;
  refund_after: bigint;
  dispute_until: bigint;
}

export interface AddressPaymentChild {
  kind: "address";
  leaf: PlanLeaf;
  proof: ProofStep[];
  amount: bigint;
  /** Bech32 address whose payment key hash is `leaf.payee_hash`. Defaults to the enterprise address. */
  payeeAddress?: string;
  /** Token trees only: lovelace from the parent's reserve. Defaults to the output's min-UTxO. */
  extraLovelace?: bigint;
}

interface ReceiptBase {
  leaf: PlanLeaf;
  proof: ProofStep[];
  /** Receipt operator: may close the receipt before `dispute_until`. */
  operator: string;
  /** Seller (Masumi) or provider (Metered) key address. */
  payee: PlutusAddress;
  /** Amount locked in the external escrow, in tree asset units. */
  budget: bigint;
  structural?: bigint;
  input_hash: string;
  acceptance: Acceptance;
  submit_by: bigint;
  challenge_until: bigint;
  refund_after: bigint;
  dispute_until: bigint;
}

/** ADR 8: a Masumi `vested_pay` V2 lock written exactly as Masumi's purchase flow writes it. */
export interface MasumiChild extends ReceiptBase {
  kind: "masumi";
  lock: {
    /** Defaults to the parent operator's enterprise key address (it requests refunds). */
    buyer?: PlutusAddress;
    seller_return_address?: PlutusAddress | null;
    reference_key: string;
    reference_signature: string;
    seller_nonce: string;
    buyer_nonce: string;
    agent_identifier: string;
    /** Defaults to the x402/Masumi formula from live coinsPerUtxoByte. */
    collateral_return_lovelace?: bigint;
    pay_by_time: bigint;
    submit_result_time: bigint;
    unlock_time: bigint;
    external_dispute_unlock_time: bigint;
  };
}

/** ADR 9: a voucher channel funded with the receipt budget. */
export interface MeteredChild extends ReceiptBase {
  kind: "metered";
  /** 32-byte Ed25519 key that signs vouchers. */
  payerVkey: string;
  /** Last instant the provider may redeem; at most `dispute_until`. */
  timeout: bigint;
  /** Lovelace beside the deposit. Defaults to what the channel output needs for min-UTxO. */
  externalLovelace?: bigint;
}

export type ChildSpec = NativeChild | AddressPaymentChild | MasumiChild | MeteredChild;

export interface BondRulingSpec {
  bond: BondRef;
  ruling: Ruling;
}

// ---------------------------------------------------------------------------------------------

export class CascadeClient {
  readonly addresses: CascadeAddresses;
  readonly policyId: string;
  readonly networkId: 0 | 1;

  constructor(
    readonly lucid: LucidEvolution,
    readonly scripts: CascadeScripts,
    readonly refs: ReferenceScripts,
    /**
     * `tipLagMs`: how far "after T" lower bounds trail the clock. Defaults to 2 s on a local devnet
     * (`Custom`, one block per second) and 60 s on public networks (one block per about 20 s).
     */
    readonly options: { tipLagMs?: number } = {},
  ) {
    const network = lucid.config().network;
    if (network === undefined) throw new Error("Lucid instance has no network");
    this.addresses = cascadeAddresses(network, scripts);
    this.policyId = scripts.nodeHash;
    this.networkId = network === "Mainnet" ? 1 : 0;
  }

  // -------------------------------------------------------------------------------------------
  // Reads

  bech32(address: PlutusAddress): string {
    return plutusAddressToBech32(address, this.networkId);
  }

  /**
   * One UTxO at `address` holding `unit`. Queried by address and unit rather than by asset holder:
   * indexers serve the address index as fresh as wallet UTxOs, while asset-holder views can lag.
   */
  private async unique(address: string, unit: string, what: string): Promise<UTxO> {
    const found = await this.lucid.utxosAtWithUnit(address, unit);
    const utxo = found[0];
    if (utxo === undefined) throw new CascadeTxError(`${what} not found`);
    if (found.length > 1) throw new CascadeTxError(`${what} is held by ${found.length} UTxOs`);
    return utxo;
  }

  async node(nodeId: string): Promise<NodeRef> {
    const utxo = await this.unique(this.addresses.node, this.policyId + nodeId, `node ${nodeId}`);
    if (utxo.datum === undefined || utxo.datum === null) throw new CascadeTxError(`node ${nodeId} has no inline datum`);
    const datum = decodeNodeDatum(utxo.datum);
    if (datum.node_id !== nodeId) throw new CascadeTxError(`node UTxO datum names ${datum.node_id}, expected ${nodeId}`);
    return { utxo, datum };
  }

  async config(treeId: string): Promise<ConfigRef> {
    const utxo = await this.unique(this.addresses.config, this.policyId + configTokenName(treeId), `config of ${treeId}`);
    if (utxo.datum === undefined || utxo.datum === null) throw new CascadeTxError(`config of ${treeId} has no inline datum`);
    return { utxo, config: decodeTreeConfig(utxo.datum) };
  }

  async bonds(nodeId: string): Promise<BondRef[]> {
    const utxos = await this.lucid.utxosAt(this.addresses.bond);
    return utxos.flatMap((utxo) => {
      if (utxo.datum === undefined || utxo.datum === null) return [];
      try {
        const datum = decodeBondDatum(utxo.datum);
        return datum.node_id === nodeId ? [{ utxo, datum }] : [];
      } catch {
        // Foreign outputs at the bond address are not Cascade bonds; ignore them.
        return [];
      }
    });
  }

  // -------------------------------------------------------------------------------------------
  // Submission

  /**
   * Wait until every output of `txHash` that carries a Cascade token is visible through the same
   * address-and-unit queries the builders use. Indexers can confirm a transaction before their
   * per-asset views catch up, which would make the next build read the previous state.
   */
  async awaitIndexed(txHash: string, cbor: string, timeoutMs = 180_000): Promise<void> {
    const tx = CML.Transaction.from_cbor_hex(cbor);
    const outputs = tx.body().outputs();
    const wanted: { address: string; unit: string }[] = [];
    for (let i = 0; i < outputs.len(); i++) {
      const out = outputs.get(i);
      const assets = out.amount().multi_asset();
      const policies = assets.keys();
      for (let p = 0; p < policies.len(); p++) {
        const policy = policies.get(p);
        if (policy.to_hex() !== this.policyId) continue;
        const names = assets.get_assets(policy)?.keys();
        if (names === undefined) continue;
        for (let n = 0; n < names.len(); n++) wanted.push({ address: out.address().to_bech32(), unit: this.policyId + names.get(n).to_hex() });
      }
    }
    const deadline = Date.now() + timeoutMs;
    for (const w of wanted) {
      for (;;) {
        const found = await this.lucid.utxosAtWithUnit(w.address, w.unit);
        if (found.some((u) => u.txHash === txHash)) break;
        if (Date.now() > deadline) throw new CascadeTxError(`output ${w.unit} of ${txHash} not indexed within ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  /**
   * Sign with the wallet, `privateKeys` (tests only) and `signers` (external witnesses, e.g. the
   * signer service), submit, confirm, and wait until the tree state is indexed.
   */
  async signAndSubmit(built: BuiltTx, privateKeys: string[] = [], signers: KeySigner[] = []): Promise<string> {
    let signer = built.tx.sign.withWallet();
    for (const k of privateKeys) signer = signer.sign.withPrivateKey(k);
    const signed = await signer.complete();
    let cbor = signed.toCBOR();
    if (signers.length > 0) cbor = attachWitness(cbor, ...(await Promise.all(signers.map((s) => s(built.cbor)))));
    const provider = this.lucid.config().provider;
    if (provider === undefined) throw new Error("Lucid instance has no provider");
    const txHash = await provider.submitTx(cbor);
    if (txHash !== built.txHash) throw new CascadeTxError(`submitted ${txHash}, built ${built.txHash}`);
    await confirm(this.lucid, txHash);
    await this.awaitIndexed(txHash, cbor);
    return txHash;
  }

  /**
   * Build, sign and submit, rebuilding when the node rejects the transaction because an indexer
   * listed inputs that were already spent (Blockfrost lags right after a confirmation). Only that
   * rejection is retried; every other error is thrown as is.
   */
  async buildAndSubmit<T extends BuiltTx>(build: () => Promise<T>, privateKeys: string[] = [], attempts = 4, signers: KeySigner[] = []): Promise<{ built: T; txHash: string }> {
    for (let attempt = 1; ; attempt++) {
      const built = await build();
      try {
        return { built, txHash: await this.signAndSubmit(built, privateKeys, signers) };
      } catch (e) {
        if (attempt >= attempts || !isStaleInputs(e)) throw e;
        await new Promise((r) => setTimeout(r, 20_000));
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Output sizing (PRD 7.8)

  private coinsPerUtxoByte(): bigint {
    const pp = this.lucid.config().protocolParameters;
    if (pp === undefined) throw new Error("protocol parameters are not loaded");
    return pp.coinsPerUtxoByte;
  }

  nodeOutput(asset: TreeConfig["asset"], d: NodeDatum): OutputPlan {
    return { address: this.addresses.node, assets: nodeValue(asset, this.policyId, d), datum: encodeNodeDatum(d) };
  }

  /**
   * Smallest `structural` that keeps the node output above min-UTxO for its whole life. Submit,
   * Draw and settlements keep the value but grow the datum (a 32-byte `result_hash`, larger
   * counters), so the size is taken from the largest datum the node can reach; the value is the
   * node's actual value.
   */
  minStructural(asset: TreeConfig["asset"], d: NodeDatum): bigint {
    const big = (x: bigint, floor: bigint): bigint => (x > floor ? x : floor);
    let structural = 0n;
    for (let round = 0; round < 8; round++) {
      const candidate = { ...d, structural };
      const largest: NodeDatum = {
        ...candidate,
        result_hash: "ff".repeat(32),
        next_child: big(d.next_child, 65_535n),
        children_open: big(d.children_open, 65_535n),
        committed: big(d.committed, d.budget),
        spent: big(d.spent, d.budget),
        state: "Disputed",
      };
      const out = this.nodeOutput(asset, candidate);
      const required = minUtxoForOutput({ address: out.address, assets: out.assets, datum: encodeNodeDatum(largest) }, this.coinsPerUtxoByte());
      // Held lovelace (lovelace trees) shrinks as children are drawn, so it never counts here.
      if (required <= structural) return structural;
      structural = required;
    }
    throw new Error("structural sizing did not converge");
  }

  /**
   * Lovelace by which a node output would miss min-UTxO once its datum reaches its largest form
   * (32-byte result hash, large counters); 0 when it is covered. Held lovelace counts in lovelace
   * trees, since it stays in the output.
   */
  nodeReserveShortfall(asset: TreeConfig["asset"], d: NodeDatum): bigint {
    const big = (x: bigint, floor: bigint): bigint => (x > floor ? x : floor);
    const largest: NodeDatum = {
      ...d,
      result_hash: "ff".repeat(32),
      next_child: big(d.next_child, 65_535n),
      children_open: big(d.children_open, 65_535n),
      committed: big(d.committed, d.budget),
      spent: big(d.spent, d.budget),
      state: "Disputed",
    };
    const out = this.nodeOutput(asset, d);
    const required = minUtxoForOutput({ address: out.address, assets: out.assets, datum: encodeNodeDatum(largest) }, this.coinsPerUtxoByte());
    const have = out.assets.lovelace ?? 0n;
    return required > have ? required - have : 0n;
  }

  /** Lovelace a payee output must carry beside `fee` of `asset` to meet min-UTxO. */
  payeeLovelaceFor(asset: TreeConfig["asset"], payee: string, fee: bigint): bigint {
    const base = assetPlusLovelace(asset, fee, 0n);
    const required = minUtxoForOutput({ address: payee, assets: base }, this.coinsPerUtxoByte());
    const have = base.lovelace ?? 0n;
    return required > have ? required - have : 0n;
  }

  // -------------------------------------------------------------------------------------------
  // Assembly

  private async build(logic: LogicScript, plan: TxPlan): Promise<BuiltTx> {
    const reward = { core: this.addresses.logicCoreReward, draw: this.addresses.logicDrawReward, ext: this.addresses.logicExtReward }[logic];
    const needsNode = plan.spend.some((u) => u.address === this.addresses.node) || Object.keys(plan.mint).length > 0;
    const needsConfig = plan.spend.some((u) => u.address === this.addresses.config);
    const needsBond = plan.spend.some((u) => u.address === this.addresses.bond);
    const closeChannels = plan.closeChannels ?? [];
    const refScripts = [
      { core: this.refs.logicCore, draw: this.refs.logicDraw, ext: this.refs.logicExt }[logic],
      ...(needsNode ? [this.refs.node] : []),
      ...(needsConfig ? [this.refs.config] : []),
      ...(needsBond ? [this.refs.bond] : []),
      ...(closeChannels.length > 0 ? [this.refs.channel] : []),
    ];
    const expected = plan.outputs;
    const nodeHash = this.scripts.nodeHash;

    let tx: TxBuilder = this.lucid.newTx().readFrom([...refScripts, ...plan.read]);
    if (plan.walletInputs !== undefined && plan.walletInputs.length > 0) tx = tx.collectFrom(plan.walletInputs);
    if (plan.spend.length > 0) tx = tx.collectFrom(plan.spend, Data.void());
    if (closeChannels.length > 0) tx = tx.collectFrom(closeChannels, encodeChannelRedeemer({ type: "Close" }));
    for (const o of expected) {
      tx = o.datum === undefined ? tx.pay.ToAddress(o.address, o.assets) : tx.pay.ToContract(o.address, { kind: "inline", value: o.datum }, o.assets);
    }
    if (Object.keys(plan.mint).length > 0) tx = tx.mintAssets(plan.mint, Data.void());
    // ADR 1.5 (F2): the logic credential only has to be present; the ledger forces the amount to
    // equal the reward balance, which anyone can make non-zero.
    const balance = await this.rewardBalance(reward);
    tx = tx.withdraw(reward, balance, (rc) => {
      expected.forEach((o, i) => {
        if (rc.outputs[i]?.address !== o.address) throw new CascadeTxError(`output ${i} moved during balancing`);
      });
      // The script context lists inputs and reference inputs sorted by output reference, whatever
      // order the body serialises them in, so indices come from that order (ADR 5).
      const find = (list: readonly OutRef[], ref: OutRef, what: string): bigint => {
        const i = ledgerOrder(list).findIndex((u) => u.txHash === ref.txHash && u.outputIndex === ref.outputIndex);
        if (i < 0) throw new CascadeTxError(`${what} ${ref.txHash}#${ref.outputIndex} is not in the transaction`);
        return BigInt(i);
      };
      const actions = plan.actions({
        input: (ref) => find(rc.inputs, ref, "input"),
        reference: (ref) => find(rc.referenceInputs, ref, "reference input"),
      });
      for (const a of actions) {
        if (logicScriptOf(a.type) !== logic) throw new CascadeTxError(`${a.type} does not belong to the ${logic} logic script`);
      }
      return encodeLogicRedeemer({ node_hash: nodeHash, actions });
    });
    for (const s of [...new Set(plan.signers)]) tx = tx.addSignerKey(s);
    if (plan.window.validFrom !== undefined) tx = tx.validFrom(plan.window.validFrom);
    tx = tx.validTo(plan.window.validTo);

    const signBuilder = await tx.complete({ localUPLCEval: false });
    const cbor = signBuilder.toCBOR();
    const provider = this.lucid.config().provider;
    if (provider === undefined) throw new Error("Lucid instance has no provider");
    const evaluation = await provider.evaluateTx(cbor);
    return { tx: signBuilder, txHash: signBuilder.toHash(), cbor, evaluation, logic, signers: [...new Set(plan.signers)] };
  }

  private async rewardBalance(reward: string): Promise<bigint> {
    const provider = this.lucid.config().provider;
    if (provider?.getRewardAccount === undefined) return 0n;
    return (await provider.getRewardAccount(reward)).rewards;
  }

  private after(t: bigint): Required<ValidityWindow> {
    const lag = this.options.tipLagMs ?? (this.lucid.config().network === "Custom" ? LOCAL_TIP_LAG_MS : DEFAULT_TIP_LAG_MS);
    return windowAfter(this.lucid, t, null, lag);
  }

  private window(before: bigint | null): ValidityWindow {
    return windowBefore(this.lucid, before);
  }

  // -------------------------------------------------------------------------------------------
  // FundRoot

  /** Mints the root and config tokens. The seed is a wallet UTxO spent by the transaction. */
  async fundRoot(params: { config: Omit<TreeConfig, "tree_id">; root: RootParams; seed?: UTxO }): Promise<BuiltTx & { treeId: string }> {
    const seed = params.seed ?? (await this.lucid.wallet().getUtxos())[0];
    if (seed === undefined) throw new CascadeTxError("wallet has no UTxO to use as the tree seed");
    const treeId = rootTokenName({ transaction_id: seed.txHash, output_index: BigInt(seed.outputIndex) });
    const config: TreeConfig = { ...params.config, tree_id: treeId };
    const r = params.root;
    const root: NodeDatum = {
      tree_id: treeId,
      node_id: treeId,
      parent_id: null,
      depth: 0n,
      next_child: 0n,
      operator: r.operator,
      payee: r.payee,
      kind: "Native",
      budget: r.budget,
      fee: r.fee,
      committed: 0n,
      children_open: 0n,
      structural: 0n,
      external_lovelace: 0n,
      spec_hash: r.spec_hash,
      input_hash: r.input_hash,
      result_hash: null,
      acceptance: { type: "BuyerAccept", key: config.buyer },
      submit_by: r.submit_by,
      challenge_until: r.challenge_until,
      refund_after: r.refund_after,
      dispute_until: r.dispute_until,
      external_ref: null,
      frozen: false,
      state: "Funded",
      spent: 0n,
    };
    if (config.allowed_leaf_kinds.includes("Native") && config.arbiter_threshold < 1n) {
      throw new CascadeTxError("arbiter_threshold must be >= 1 when Native leaves are allowed (ADR 1.5, F5)");
    }
    if (config.min_dispute_window <= 0n) throw new CascadeTxError("min_dispute_window must be positive (ADR 1.6, E6)");
    for (const [name, a] of [["protocol_fee_address", config.protocol_fee_address], ["arbiter_fee_address", config.arbiter_fee_address]] as const) {
      if (a.payment_credential.type !== "VerificationKey") throw new CascadeTxError(`${name} must be a key address (ADR 1.6, E14)`);
    }
    this.checkWindows(root, config);
    const minimum = this.minStructural(config.asset, root);
    if (r.structural !== undefined && r.structural < minimum) throw new CascadeTxError(`root structural ${r.structural} is below the root min-UTxO ${minimum}`);
    root.structural = r.structural ?? minimum;

    const configName = configTokenName(treeId);
    const configDatum = encodeTreeConfig(config);
    const configToken = { [this.policyId + configName]: 1n };
    const configLovelace = minUtxoForOutput({ address: this.addresses.config, assets: configToken, datum: configDatum }, this.coinsPerUtxoByte());
    const built = await this.build("core", {
      spend: [],
      walletInputs: [seed],
      read: [],
      outputs: [this.nodeOutput(config.asset, root), { address: this.addresses.config, assets: { ...configToken, lovelace: configLovelace }, datum: configDatum }],
      mint: { [this.policyId + treeId]: 1n, ...configToken },
      signers: [config.buyer],
      window: this.window(null),
      actions: () => [{ type: "FundRoot", seed: { transaction_id: seed.txHash, output_index: BigInt(seed.outputIndex) }, root_out: 0n, config_out: 1n }],
    });
    return { ...built, treeId };
  }

  // -------------------------------------------------------------------------------------------
  // TopUp, Submit, Accept, Escalate, Freeze, Unfreeze (single node, continuing output)

  async topUp(treeId: string, amount: bigint): Promise<BuiltTx> {
    const [root, cfg] = await Promise.all([this.node(treeId), this.config(treeId)]);
    const next = { ...root.datum, budget: root.datum.budget + amount };
    return this.build("core", {
      spend: [root.utxo],
      read: [cfg.utxo],
      outputs: [this.nodeOutput(cfg.config.asset, next)],
      mint: {},
      signers: [cfg.config.buyer],
      window: this.window(null),
      actions: (ix) => [{ type: "TopUp", node_in: ix.input(root.utxo), node_out: 0n, amount }],
    });
  }

  async submit(nodeId: string, resultHash: string): Promise<BuiltTx> {
    const n = await this.node(nodeId);
    const next: NodeDatum = { ...n.datum, result_hash: resultHash, state: "Submitted" };
    return this.build("core", {
      spend: [n.utxo],
      read: [],
      outputs: [{ address: n.utxo.address, assets: n.utxo.assets, datum: encodeNodeDatum(next) }],
      mint: {},
      signers: [n.datum.operator],
      window: this.window(n.datum.submit_by),
      actions: (ix) => [{ type: "Submit", node_in: ix.input(n.utxo), node_out: 0n, result_hash: resultHash }],
    });
  }

  /**
   * Accept by the acceptance rule's signatures (`signers`), or with no signers once
   * `challenge_until` has passed.
   */
  async accept(nodeId: string, signers: string[] = []): Promise<BuiltTx> {
    const n = await this.node(nodeId);
    return this.build("core", {
      spend: [n.utxo],
      read: [],
      outputs: [{ address: n.utxo.address, assets: n.utxo.assets, datum: encodeNodeDatum({ ...n.datum, state: "Accepted" }) }],
      mint: {},
      signers,
      window: signers.length > 0 ? this.window(null) : this.after(n.datum.challenge_until),
      actions: (ix) => [{ type: "Accept", node_in: ix.input(n.utxo), node_out: 0n }],
    });
  }

  async escalate(nodeId: string): Promise<BuiltTx> {
    const n = await this.node(nodeId);
    return this.build("core", {
      spend: [n.utxo],
      read: [],
      outputs: [{ address: n.utxo.address, assets: n.utxo.assets, datum: encodeNodeDatum({ ...n.datum, state: "Disputed" }) }],
      mint: {},
      signers: [n.datum.operator],
      window: this.window(n.datum.dispute_until),
      actions: (ix) => [{ type: "Escalate", node_in: ix.input(n.utxo), node_out: 0n }],
    });
  }

  async setFrozen(treeId: string, frozen: boolean): Promise<BuiltTx> {
    const root = await this.node(treeId);
    if (root.datum.acceptance.type !== "BuyerAccept") throw new CascadeTxError("root acceptance is not BuyerAccept");
    const buyer = root.datum.acceptance.key;
    return this.build("core", {
      spend: [root.utxo],
      read: [],
      outputs: [{ address: root.utxo.address, assets: root.utxo.assets, datum: encodeNodeDatum({ ...root.datum, frozen }) }],
      mint: {},
      signers: [buyer],
      window: this.window(null),
      actions: (ix) => [{ type: frozen ? "Freeze" : "Unfreeze", node_in: ix.input(root.utxo), node_out: 0n }],
    });
  }

  freeze = (treeId: string): Promise<BuiltTx> => this.setFrozen(treeId, true);
  unfreeze = (treeId: string): Promise<BuiltTx> => this.setFrozen(treeId, false);

  /** ADR 4.3 deadline order plus the dispute window floor (ADR 1.6, E6), checked before building. */
  private checkWindows(d: Pick<NodeDatum, "submit_by" | "challenge_until" | "refund_after" | "dispute_until">, cfg: Pick<TreeConfig, "min_challenge_window" | "min_dispute_window">): void {
    if (d.submit_by > d.refund_after) throw new CascadeTxError("submit_by must be <= refund_after");
    if (d.submit_by + cfg.min_challenge_window > d.challenge_until) throw new CascadeTxError("challenge window below min_challenge_window");
    if (d.dispute_until - d.challenge_until < cfg.min_dispute_window) throw new CascadeTxError("dispute window below min_dispute_window (ADR 1.6, E6)");
  }

  // -------------------------------------------------------------------------------------------
  // Receipts (ADR 8, 9)

  /** Enterprise script address of a script hash (Masumi escrow, channel). */
  private scriptAddress(hash: string): string {
    return plutusAddressToBech32({ payment_credential: { type: "Script", hash }, stake_credential: null }, this.networkId);
  }

  /** Builds the `vested_pay` lock and sets `child.external_lovelace` to the lovelace it carries. */
  private masumiLockOutput(cfg: TreeConfig, parent: NodeDatum, child: NodeDatum, c: MasumiChild): OutputPlan {
    const asset = cfg.asset;
    const buyer = c.lock.buyer ?? { payment_credential: { type: "VerificationKey" as const, hash: parent.operator }, stake_credential: null };
    const datumFor = (collateral: bigint): MasumiDatum => ({
      buyer,
      buyer_return_address: cfg.buyer_refund,
      seller: child.payee,
      seller_return_address: c.lock.seller_return_address ?? null,
      reference_key: c.lock.reference_key,
      reference_signature: c.lock.reference_signature,
      seller_nonce: c.lock.seller_nonce,
      buyer_nonce: c.lock.buyer_nonce,
      agent_identifier: c.lock.agent_identifier,
      collateral_return_lovelace: collateral,
      input_hash: child.input_hash,
      result_hash: "",
      pay_by_time: c.lock.pay_by_time,
      submit_result_time: c.lock.submit_result_time,
      unlock_time: c.lock.unlock_time,
      external_dispute_unlock_time: c.lock.external_dispute_unlock_time,
      seller_cooldown_time: 0n,
      buyer_cooldown_time: 0n,
      state: "FundsLocked",
    });
    const sellerReturn = c.lock.seller_return_address ?? null;
    if (sellerReturn !== null && sellerReturn.payment_credential.type !== "VerificationKey") throw new CascadeTxError("seller_return_address must be a key address (ADR 1.6, E8)");
    if (c.lock.external_dispute_unlock_time > child.dispute_until) throw new CascadeTxError("Masumi external dispute unlock must end by the receipt's dispute_until");
    const requestedLovelace = isLovelace(asset) ? child.budget : 0n;
    let collateral = c.lock.collateral_return_lovelace ?? 0n;
    if (c.lock.collateral_return_lovelace === undefined) {
      // Twice: the collateral's own CBOR width can change the datum size.
      for (let round = 0; round < 2; round++) {
        const bytes = encodeMasumiDatum(datumFor(collateral)).length / 2;
        const min = masumiMinUtxoLovelace(bytes, isLovelace(asset) ? 0 : 1, this.coinsPerUtxoByte());
        collateral = masumiCollateralLovelace(requestedLovelace, min);
      }
    }
    child.external_lovelace = collateral;
    return {
      address: this.scriptAddress(cfg.masumi_script_hash),
      assets: assetPlusLovelace(asset, child.budget, collateral),
      datum: encodeMasumiDatum(datumFor(collateral)),
    };
  }

  /** Builds the channel output (deposit, lovelace, channel token) and sets `child.external_lovelace`. */
  private channelOutput(cfg: TreeConfig, child: NodeDatum, c: MeteredChild): OutputPlan {
    if (child.payee.payment_credential.type !== "VerificationKey") throw new CascadeTxError("a Metered provider must be a key address");
    if (c.timeout > child.dispute_until) throw new CascadeTxError("channel timeout must be <= the receipt's dispute_until");
    if (c.timeout < child.submit_by) throw new CascadeTxError("channel timeout must be >= the receipt's submit_by (ADR 1.6, E14)");
    const datum: ChannelDatum = {
      authority: this.scripts.nodeHash,
      tree_id: child.tree_id,
      node_id: child.node_id,
      payer_vkey: c.payerVkey,
      provider: child.payee.payment_credential.hash,
      provider_address: child.payee,
      asset: cfg.asset,
      deposit: child.budget,
      redeemed: 0n,
      timeout: c.timeout,
    };
    const address = this.scriptAddress(this.scripts.channelHash);
    const token = { [this.policyId + channelTokenName(child.node_id)]: 1n };
    const encoded = encodeChannelDatum(datum);
    let lovelace = c.externalLovelace;
    if (lovelace === undefined) {
      // Redeem must continue the channel with exactly its value minus the claim (cascade_channel),
      // so the lovelace beside the deposit alone must carry min-UTxO once the deposit is fully
      // redeemed, with the largest datum (`redeemed = deposit`). A lovelace deposit does not count:
      // the provider can claim all of it.
      const drained = encodeChannelDatum({ ...datum, redeemed: child.budget });
      const assets = isLovelace(cfg.asset) ? token : addAssets(assetPlusLovelace(cfg.asset, child.budget, 0n), token);
      lovelace = minUtxoForOutput({ address, assets, datum: drained }, this.coinsPerUtxoByte());
    }
    child.external_lovelace = lovelace;
    return { address, assets: addAssets(assetPlusLovelace(cfg.asset, child.budget, lovelace), token), datum: encoded };
  }

  async channel(receiptId: string): Promise<{ utxo: UTxO; datum: ChannelDatum }> {
    const utxo = await this.unique(this.scriptAddress(this.scripts.channelHash), this.policyId + channelTokenName(receiptId), `channel of ${receiptId}`);
    if (utxo.datum === undefined || utxo.datum === null) throw new CascadeTxError(`channel of ${receiptId} has no inline datum`);
    return { utxo, datum: decodeChannelDatum(utxo.datum) };
  }

  /**
   * Close a receipt into its parent (ADR 5.1 CloseReceipt, ext logic). Masumi: the escrow settled
   * outside the tree. Metered: the channel's unredeemed deposit returns into the parent.
   * `by` names who signs: the receipt operator, the channel provider (Metered), both, or nobody
   * once the deadlines have passed; each missing signature is replaced by waiting for its deadline.
   */
  async closeReceipt(receiptId: string, by: "operator" | "provider" | "both" | "deadline" = "operator"): Promise<BuiltTx> {
    const r = await this.node(receiptId);
    const d = r.datum;
    if (d.parent_id === null) throw new CascadeTxError("a receipt always has a parent");
    const p = await this.node(d.parent_id);
    const metered = d.kind === "MeteredReceipt";
    if (!metered && d.kind !== "MasumiReceipt") throw new CascadeTxError(`${receiptId} is not a receipt`);
    const ch = metered ? await this.channel(receiptId) : null;

    let remaining = 0n;
    let beside = 0n;
    let returned: Assets = {};
    if (ch !== null) {
      remaining = ch.datum.deposit - ch.datum.redeemed;
      beside = (ch.utxo.assets.lovelace ?? 0n) - (isLovelace(ch.datum.asset) ? remaining : 0n);
      returned = addAssets(ch.utxo.assets, { [this.policyId + channelTokenName(receiptId)]: -1n });
    }
    const next: NodeDatum = {
      ...p.datum,
      committed: p.datum.committed - d.budget,
      children_open: p.datum.children_open - 1n,
      structural: p.datum.structural + d.structural + beside,
      spent: p.datum.spent + d.budget - remaining,
    };
    const value = addAssets(p.utxo.assets, r.utxo.assets, { [this.policyId + d.node_id]: -1n }, returned);

    // Receipt side: operator signature, or after the receipt's dispute_until. Metered channel
    // side (ADR 1.5, F4): provider signature, or after the channel timeout.
    const operatorSigns = by === "operator" || by === "both";
    const providerSigns = by === "provider" || by === "both";
    if (providerSigns && ch === null) throw new CascadeTxError("only a Metered receipt has a provider");
    const signers = [...(operatorSigns ? [d.operator] : []), ...(providerSigns && ch !== null ? [ch.datum.provider] : [])];
    const waits = [...(operatorSigns ? [] : [d.dispute_until]), ...(ch !== null && !providerSigns ? [ch.datum.timeout] : [])];
    const after = waits.length === 0 ? null : waits.reduce((m, t) => (t > m ? t : m));
    const window = after === null ? this.window(null) : this.after(after);

    const mint: Assets = { [this.policyId + d.node_id]: -1n };
    if (ch !== null) mint[this.policyId + channelTokenName(receiptId)] = -1n;
    return this.build("ext", {
      spend: [r.utxo, p.utxo],
      closeChannels: ch === null ? [] : [ch.utxo],
      read: [],
      outputs: [{ address: p.utxo.address, assets: value, datum: encodeNodeDatum(next) }],
      mint,
      signers,
      window,
      actions: (ix) => [
        { type: "CloseReceipt", node_in: ix.input(r.utxo), parent_in: ix.input(p.utxo), parent_out: 0n, channel_in: ch === null ? null : ix.input(ch.utxo) },
      ],
    });
  }

  /**
   * Provider redeem of one or more channels in one transaction (ADR 9 batch redeem). Each channel
   * continues at its own output with `redeemed = amount`; the claims go to `payTo` (default the
   * provider address). The provider must sign. No logic script runs.
   */
  async redeemChannels(claims: { receiptId: string; amount: bigint; signature: string }[], payTo?: string): Promise<BuiltTx> {
    if (claims.length === 0) throw new CascadeTxError("nothing to redeem");
    const channels = await Promise.all(claims.map((c) => this.channel(c.receiptId)));
    const providers = new Set(channels.map((c) => c.datum.provider));
    if (providers.size !== 1) throw new CascadeTxError("a batch redeem covers channels of one provider");
    const provider = channels[0]?.datum;
    if (provider === undefined) throw new CascadeTxError("nothing to redeem");
    const timeout = channels.reduce((m, c) => (c.datum.timeout < m ? c.datum.timeout : m), provider.timeout);

    let tx: TxBuilder = this.lucid.newTx().readFrom([this.refs.channel]);
    const payouts: Assets[] = [];
    const continuing: { address: string; assets: Assets; datum: string }[] = [];
    channels.forEach((ch, i) => {
      const claim = claims[i];
      if (claim === undefined) throw new CascadeTxError("claim missing");
      if (claim.amount <= ch.datum.redeemed || claim.amount > ch.datum.deposit) throw new CascadeTxError(`claim ${claim.amount} out of range for ${claim.receiptId}`);
      const delta = assetPlusLovelace(ch.datum.asset, claim.amount - ch.datum.redeemed, 0n);
      tx = tx.collectFrom([ch.utxo], encodeChannelRedeemer({ type: "Redeem", amount: claim.amount, signature: claim.signature, out: BigInt(i) }));
      continuing.push({ address: ch.utxo.address, assets: addAssets(ch.utxo.assets, negate(delta)), datum: encodeChannelDatum({ ...ch.datum, redeemed: claim.amount }) });
      payouts.push(delta);
    });
    // Continuing channels first (outputs 0..n-1, as each redeemer names), then the claims.
    for (const o of continuing) tx = tx.pay.ToContract(o.address, { kind: "inline", value: o.datum }, o.assets);
    tx = tx.pay.ToAddress(payTo ?? this.bech32(provider.provider_address), addAssets(...payouts));
    const window = this.window(timeout);
    tx = tx.addSignerKey(provider.provider).validTo(window.validTo);
    if (window.validFrom !== undefined) tx = tx.validFrom(window.validFrom);
    const signBuilder = await tx.complete({ localUPLCEval: false });
    const cbor = signBuilder.toCBOR();
    const providerApi = this.lucid.config().provider;
    if (providerApi === undefined) throw new Error("Lucid instance has no provider");
    const evaluation = await providerApi.evaluateTx(cbor);
    return { tx: signBuilder, txHash: signBuilder.toHash(), cbor, evaluation, logic: null, signers: [provider.provider] };
  }

  // -------------------------------------------------------------------------------------------
  // Draw

  /**
   * `options.maxValidityMs` shortens the validity window below the 240 s default, e.g. to an x402
   * requirement's `maxTimeoutSeconds`.
   */
  async draw(
    parentId: string,
    children: ChildSpec[],
    options: { maxValidityMs?: number } = {},
  ): Promise<BuiltTx & { childIds: string[]; externals: { nodeId: string; outputIndex: number }[] }> {
    if (children.length === 0) throw new CascadeTxError("a Draw needs at least one child");
    const p = await this.node(parentId);
    const cfg = await this.config(p.datum.tree_id);
    const root = p.datum.parent_id === null ? null : await this.node(p.datum.tree_id);
    const asset = cfg.config.asset;

    const outputs: OutputPlan[] = [];
    const draws: ChildDraw[] = [];
    const childIds: string[] = [];
    const externals: { nodeId: string; outputIndex: number }[] = [];
    const mint: Assets = {};
    let nextChild = p.datum.next_child;
    let committed = 0n;
    let paid = 0n;
    let structural = 0n;
    let natives = 0n;
    // Output 0 is the continuing parent; children follow in order.
    const nextIndex = (): bigint => BigInt(outputs.length + 1);

    for (const c of children) {
      if (c.kind === "address") {
        const address = c.payeeAddress ?? plutusAddressToBech32({ payment_credential: { type: "VerificationKey", hash: c.leaf.payee_hash }, stake_credential: null }, this.networkId);
        const cred = plutusAddressFromBech32(address).payment_credential;
        if (cred.type !== "VerificationKey" || cred.hash !== c.leaf.payee_hash) throw new CascadeTxError("payeeAddress does not carry leaf.payee_hash");
        const extra = isLovelace(asset) ? 0n : (c.extraLovelace ?? this.payeeLovelaceFor(asset, address, c.amount));
        draws.push({ out: nextIndex(), external_out: null, leaf: c.leaf, proof: c.proof });
        outputs.push({ address, assets: assetPlusLovelace(asset, c.amount, extra) });
        paid += c.amount;
        structural += extra;
        continue;
      }
      const nodeId = childTokenName(p.datum.node_id, nextChild);
      const kind = c.kind === "native" ? "Native" : c.kind === "masumi" ? "MasumiReceipt" : "MeteredReceipt";
      if (kind !== c.leaf.kind) throw new CascadeTxError(`leaf kind ${c.leaf.kind} does not match a ${c.kind} child`);
      if (acceptanceHash(c.acceptance) !== c.leaf.acceptance_hash) throw new CascadeTxError("child acceptance does not match leaf.acceptance_hash (ADR 1.6, E7)");
      this.checkWindows(c, cfg.config);
      const child: NodeDatum = {
        tree_id: p.datum.tree_id,
        node_id: nodeId,
        parent_id: p.datum.node_id,
        depth: p.datum.depth + 1n,
        next_child: 0n,
        operator: c.operator,
        payee: c.payee,
        kind,
        budget: c.budget,
        fee: c.kind === "native" ? c.fee : 0n,
        committed: 0n,
        children_open: 0n,
        structural: 0n,
        external_lovelace: 0n,
        spec_hash: c.leaf.spec_hash,
        input_hash: c.input_hash,
        result_hash: null,
        acceptance: c.acceptance,
        submit_by: c.submit_by,
        challenge_until: c.challenge_until,
        refund_after: c.refund_after,
        dispute_until: c.dispute_until,
        // ADR 8 (amended): receipts are drawn with external_ref None; the escrow is
        // OutputReference(draw tx, external_out) off chain, a channel is found by its token.
        external_ref: null,
        frozen: false,
        state: "Funded",
        spent: 0n,
      };
      let external: OutputPlan | null = null;
      if (c.kind === "masumi") {
        external = this.masumiLockOutput(cfg.config, p.datum, child, c);
      } else if (c.kind === "metered") {
        external = this.channelOutput(cfg.config, child, c);
        mint[this.policyId + channelTokenName(nodeId)] = 1n;
      }
      child.structural = c.structural ?? this.minStructural(asset, child);
      const out = nextIndex();
      outputs.push(this.nodeOutput(asset, child));
      let externalOut: bigint | null = null;
      if (external !== null) {
        externalOut = nextIndex();
        outputs.push(external);
      }
      draws.push({ out, external_out: externalOut, leaf: c.leaf, proof: c.proof });
      if (externalOut !== null) externals.push({ nodeId, outputIndex: Number(externalOut) });
      mint[this.policyId + nodeId] = 1n;
      childIds.push(nodeId);
      committed += child.budget;
      structural += child.structural + child.external_lovelace;
      natives += 1n;
      nextChild += 1n;
    }

    const next: NodeDatum = {
      ...p.datum,
      committed: p.datum.committed + committed,
      spent: p.datum.spent + paid,
      children_open: p.datum.children_open + natives,
      next_child: p.datum.next_child + natives,
      structural: p.datum.structural - structural,
    };
    if (next.structural < 0n) throw new StructuralShortfallError(next.node_id, -next.structural);
    const shortfall = this.nodeReserveShortfall(asset, next);
    if (shortfall > 0n) throw new StructuralShortfallError(next.node_id, shortfall);
    if (committed + paid + p.datum.fee > p.datum.budget - p.datum.committed - p.datum.spent) {
      throw new CascadeTxError("children exceed the parent's free budget");
    }

    const built = await this.build("draw", {
      spend: [p.utxo],
      read: root === null ? [cfg.utxo] : [cfg.utxo, root.utxo],
      outputs: [this.nodeOutput(asset, next), ...outputs],
      mint,
      signers: [p.datum.operator],
      window: windowBefore(this.lucid, p.datum.submit_by, options.maxValidityMs),
      actions: (ix) => [
        {
          type: "Draw",
          node_in: ix.input(p.utxo),
          node_out: 0n,
          config_ref: ix.reference(cfg.utxo),
          root_ref: root === null ? null : ix.reference(root.utxo),
          children: draws,
        },
      ],
    });
    return { ...built, childIds, externals };
  }

  // -------------------------------------------------------------------------------------------
  // Challenge

  async challenge(params: { nodeId: string; reasonHash: string; challenger: string; challengerAddress: string; bondLovelace?: bigint }): Promise<BuiltTx> {
    const n = await this.node(params.nodeId);
    const cfg = await this.config(n.datum.tree_id);
    const isBuyer = params.challenger === cfg.config.buyer;
    const parent = isBuyer || n.datum.parent_id === null ? null : await this.node(n.datum.parent_id);
    if (!isBuyer && parent?.datum.operator !== params.challenger) throw new CascadeTxError("only the buyer or the parent operator may challenge");
    const bond: BondDatum = {
      authority: this.scripts.nodeHash,
      tree_id: n.datum.tree_id,
      node_id: n.datum.node_id,
      owner: params.challenger,
      owner_address: plutusAddressFromBech32(params.challengerAddress),
      role: "Challenger",
      release_after: n.datum.dispute_until,
    };
    const lovelace = params.bondLovelace ?? cfg.config.challenge_bond;
    if (lovelace < cfg.config.challenge_bond) throw new CascadeTxError(`bond below config.challenge_bond ${cfg.config.challenge_bond}`);
    return this.build("core", {
      spend: [n.utxo],
      read: parent === null ? [cfg.utxo] : [cfg.utxo, parent.utxo],
      outputs: [
        { address: n.utxo.address, assets: n.utxo.assets, datum: encodeNodeDatum({ ...n.datum, state: "Challenged" }) },
        { address: this.addresses.bond, assets: { lovelace }, datum: encodeBondDatum(bond) },
      ],
      mint: {},
      signers: [params.challenger],
      window: this.window(n.datum.challenge_until),
      actions: (ix) => [
        {
          type: "Challenge",
          node_in: ix.input(n.utxo),
          node_out: 0n,
          reason_hash: params.reasonHash,
          challenger: params.challenger,
          challenger_address: bond.owner_address,
          bond_out: 1n,
          config_ref: ix.reference(cfg.utxo),
          parent_ref: parent === null ? null : ix.reference(parent.utxo),
        },
      ],
    });
  }

  // -------------------------------------------------------------------------------------------
  // Exits: Resolve, Refund, SettleChild, CloseRoot, Cancel

  /** Everything in the root and config inputs, minus both tokens and `paid`, for `buyer_refund`. */
  private rootRemainder(root: NodeRef, cfg: ConfigRef, paid: Assets): Assets {
    const tokens = { [this.policyId + root.datum.node_id]: -1n, [this.policyId + configTokenName(root.datum.tree_id)]: -1n };
    return assertNonNegative(addAssets(root.utxo.assets, cfg.utxo.assets, tokens, negate(paid)), "root remainder");
  }

  private exitBurn(treeId: string): Assets {
    return { [this.policyId + treeId]: -1n, [this.policyId + configTokenName(treeId)]: -1n };
  }

  /**
   * Resolve a Challenged or Disputed node. `mode: "ruling"` needs the quorum or arbiter
   * `signers`; `mode: "deadline"` is the permissionless exit after `dispute_until`, all to the parent.
   */
  async resolve(params: {
    nodeId: string;
    mode: "ruling" | "deadline";
    split?: Split;
    payeeLovelace?: bigint;
    bonds?: BondRulingSpec[];
    signers?: string[];
  }): Promise<BuiltTx> {
    const n = await this.node(params.nodeId);
    const cfg = await this.config(n.datum.tree_id);
    const d = n.datum;
    const asset = cfg.config.asset;
    const deadline = params.mode === "deadline";
    const held = d.budget - d.spent;
    // ADR 1.5 (F5) deadline exit: an unescalated challenge goes to the parent; a dispute the
    // arbiters left silent pays the worker its fee.
    const deadlineWorker = d.state === "Disputed" ? d.fee : 0n;
    const split: Split = deadline ? { worker: deadlineWorker, parent: held - deadlineWorker } : (params.split ?? { worker: 0n, parent: held });
    if (split.worker + split.parent !== held) throw new CascadeTxError("split must add up to budget - spent");
    const payeeAddress = this.bech32(d.payee);
    // ADR 1.6 (E12): the deadline exit pays no lovelace beside the fee, except up to 2 ADA for a
    // Disputed node whose fee is a native asset (its output needs min-UTxO).
    const deadlineLovelace = deadline && (d.state === "Challenged" || isLovelace(asset));
    const payeeLovelace = deadlineLovelace
      ? 0n
      : (params.payeeLovelace ?? (split.worker > 0n ? this.cappedPayeeLovelace(asset, payeeAddress, split.worker, d.structural) : 0n));
    const bondSpecs = deadline ? [] : (params.bonds ?? []);
    const payeeValue = assetPlusLovelace(asset, split.worker, payeeLovelace);
    const hasPayee = Object.keys(payeeValue).length > 0;

    const outputs: OutputPlan[] = hasPayee ? [{ address: payeeAddress, assets: payeeValue }] : [];
    const spend: UTxO[] = [n.utxo];
    const read: UTxO[] = [];
    let parent: NodeRef | null = null;
    if (d.parent_id !== null) {
      parent = await this.node(d.parent_id);
      const next: NodeDatum = {
        ...parent.datum,
        committed: parent.datum.committed - d.budget,
        spent: parent.datum.spent + d.spent + split.worker,
        children_open: parent.datum.children_open - 1n,
        structural: parent.datum.structural + d.structural - payeeLovelace,
      };
      outputs.push(this.nodeOutput(asset, next));
      spend.push(parent.utxo);
      read.push(cfg.utxo);
    } else {
      outputs.push({ address: this.bech32(cfg.config.buyer_refund), assets: this.rootRemainder(n, cfg, payeeValue) });
      spend.push(cfg.utxo);
    }
    const parentOutIndex = BigInt(outputs.length - 1);

    const rulings: { spec: BondRulingSpec; outs: bigint[] }[] = [];
    for (const spec of bondSpecs) {
      const v = spec.bond.utxo.assets.lovelace ?? 0n;
      const payouts: [PlutusAddress, bigint][] =
        spec.ruling === "ReturnBond"
          ? [[spec.bond.datum.owner_address, v]]
          : (() => {
              const wronged = (v * cfg.config.slash_wronged_bps) / 10_000n;
              const wrongedAddress = split.worker > 0n ? d.payee : cfg.config.buyer_refund;
              return ([[wrongedAddress, wronged], [cfg.config.arbiter_fee_address, v - wronged]] as [PlutusAddress, bigint][]).filter(([, a]) => a > 0n);
            })();
      const outs: bigint[] = [];
      for (const [address, amount] of payouts) {
        outs.push(BigInt(outputs.length));
        outputs.push({ address: this.bech32(address), assets: { lovelace: amount } });
      }
      spend.push(spec.bond.utxo);
      rulings.push({ spec, outs });
    }

    return this.build("ext", {
      spend,
      read,
      outputs,
      mint: parent === null ? this.exitBurn(d.tree_id) : { [this.policyId + d.node_id]: -1n },
      signers: params.signers ?? [],
      window: deadline ? this.after(d.dispute_until) : this.window(d.dispute_until),
      actions: (ix) => {
        const bonds: BondRuling[] = rulings.map((r) => ({ bond_in: ix.input(r.spec.bond.utxo), ruling: r.spec.ruling, outs: r.outs }));
        const link =
          parent === null
            ? { type: "RootExit" as const, config_in: ix.input(cfg.utxo), refund_out: parentOutIndex }
            : { type: "ParentNode" as const, parent_in: ix.input(parent.utxo), parent_out: parentOutIndex };
        return [
          {
            type: "Resolve",
            node_in: ix.input(n.utxo),
            parent: link,
            config_ref: parent === null ? ix.input(cfg.utxo) : ix.reference(cfg.utxo),
            split,
            // Output 0 is the payee when one is paid; the validator ignores the index otherwise.
            payee_out: 0n,
            payee_lovelace: payeeLovelace,
            bonds,
          },
        ];
      },
    });
  }

  private cappedPayeeLovelace(asset: TreeConfig["asset"], payee: string, amount: bigint, structural: bigint): bigint {
    const needed = this.payeeLovelaceFor(asset, payee, amount);
    const cap = structural < MAX_PAYEE_LOVELACE ? structural : MAX_PAYEE_LOVELACE;
    if (needed > cap) throw new CascadeTxError(`payee output needs ${needed} lovelace, above the cap ${cap}`);
    return needed;
  }

  /** Refund a Funded native node after `refund_after`: into its parent, or out of the tree at the root. */
  async refund(nodeId: string): Promise<BuiltTx> {
    const n = await this.node(nodeId);
    const d = n.datum;
    const cfg = await this.config(d.tree_id);
    const window = this.after(d.refund_after);
    if (d.parent_id === null) {
      return this.build("core", {
        spend: [n.utxo, cfg.utxo],
        read: [],
        outputs: [{ address: this.bech32(cfg.config.buyer_refund), assets: this.rootRemainder(n, cfg, {}) }],
        mint: this.exitBurn(d.tree_id),
        signers: [],
        window,
        actions: (ix) => [{ type: "Refund", node_in: ix.input(n.utxo), parent: { type: "RootExit", config_in: ix.input(cfg.utxo), refund_out: 0n } }],
      });
    }
    const p = await this.node(d.parent_id);
    const next: NodeDatum = {
      ...p.datum,
      committed: p.datum.committed - d.budget,
      spent: p.datum.spent + d.spent,
      children_open: p.datum.children_open - 1n,
      structural: p.datum.structural + d.structural + d.external_lovelace,
    };
    const value = addAssets(p.utxo.assets, n.utxo.assets, { [this.policyId + d.node_id]: -1n });
    return this.build("core", {
      spend: [n.utxo, p.utxo],
      read: [],
      outputs: [{ address: p.utxo.address, assets: value, datum: encodeNodeDatum(next) }],
      mint: { [this.policyId + d.node_id]: -1n },
      signers: [],
      window,
      actions: (ix) => [{ type: "Refund", node_in: ix.input(n.utxo), parent: { type: "ParentNode", parent_in: ix.input(p.utxo), parent_out: 0n } }],
    });
  }

  /** Pay an Accepted (or window-lapsed Submitted) child its fee and fold it into the parent. */
  async settleChild(childId: string, payeeLovelace?: bigint): Promise<BuiltTx> {
    const c = await this.node(childId);
    const d = c.datum;
    if (d.parent_id === null) throw new CascadeTxError("the root settles with closeRoot");
    const [p, cfg] = await Promise.all([this.node(d.parent_id), this.config(d.tree_id)]);
    const asset = cfg.config.asset;
    const payeeAddress = this.bech32(d.payee);
    const lovelace = payeeLovelace ?? this.cappedPayeeLovelace(asset, payeeAddress, d.fee, d.structural);
    const payee = assetPlusLovelace(asset, d.fee, lovelace);
    const hasPayee = Object.keys(payee).length > 0;
    const next: NodeDatum = {
      ...p.datum,
      committed: p.datum.committed - d.budget,
      spent: p.datum.spent + d.spent + d.fee,
      children_open: p.datum.children_open - 1n,
      structural: p.datum.structural + d.structural - lovelace,
    };
    return this.build("core", {
      spend: [c.utxo, p.utxo],
      read: [cfg.utxo],
      outputs: [this.nodeOutput(asset, next), ...(hasPayee ? [{ address: payeeAddress, assets: payee }] : [])],
      mint: { [this.policyId + d.node_id]: -1n },
      signers: [],
      window: d.state === "Accepted" ? this.window(null) : this.after(d.challenge_until),
      actions: (ix) => [
        { type: "SettleChild", node_in: ix.input(c.utxo), parent_in: ix.input(p.utxo), parent_out: 0n, payee_out: 1n, payee_lovelace: lovelace },
      ],
    });
  }

  /** Close an Accepted root (buyer signs), or any Accepted or Submitted root after `challenge_until`. */
  async closeRoot(treeId: string, options: { byBuyer?: boolean; payeeLovelace?: bigint; protocolLovelace?: bigint } = {}): Promise<BuiltTx> {
    const [root, cfg] = await Promise.all([this.node(treeId), this.config(treeId)]);
    const d = root.datum;
    const asset = cfg.config.asset;
    const byBuyer = options.byBuyer ?? d.state === "Accepted";
    const payeeAddress = this.bech32(d.payee);
    const lovelace = options.payeeLovelace ?? this.cappedPayeeLovelace(asset, payeeAddress, d.fee, d.structural);
    const payee = assetPlusLovelace(asset, d.fee, lovelace);
    const protocolFee = ((d.budget - d.spent - d.fee) * cfg.config.protocol_fee_bps) / 10_000n;
    const protocolAddress = this.bech32(cfg.config.protocol_fee_address);
    const protocolLovelace =
      protocolFee === 0n ? 0n : (options.protocolLovelace ?? this.cappedPayeeLovelace(asset, protocolAddress, protocolFee, d.structural - lovelace));
    const protocol = assetPlusLovelace(asset, protocolFee, protocolLovelace);
    const outputs: OutputPlan[] = [];
    const payeeOut = BigInt(outputs.length);
    if (Object.keys(payee).length > 0) outputs.push({ address: payeeAddress, assets: payee });
    const protocolOut = protocolFee > 0n ? BigInt(outputs.length) : null;
    if (protocolFee > 0n) outputs.push({ address: protocolAddress, assets: protocol });
    const refundOut = BigInt(outputs.length);
    outputs.push({ address: this.bech32(cfg.config.buyer_refund), assets: this.rootRemainder(root, cfg, addAssets(payee, protocol)) });
    return this.build("core", {
      spend: [root.utxo, cfg.utxo],
      read: [],
      outputs,
      mint: this.exitBurn(treeId),
      signers: byBuyer ? [cfg.config.buyer] : [],
      window: byBuyer ? this.window(null) : this.after(d.challenge_until),
      actions: (ix) => [
        {
          type: "CloseRoot",
          node_in: ix.input(root.utxo),
          config_in: ix.input(cfg.utxo),
          payee_out: payeeOut,
          payee_lovelace: lovelace,
          protocol_lovelace: protocolLovelace,
          protocol_out: protocolOut,
          refund_out: refundOut,
        },
      ],
    });
  }

  async cancel(treeId: string): Promise<BuiltTx> {
    const [root, cfg] = await Promise.all([this.node(treeId), this.config(treeId)]);
    return this.build("core", {
      spend: [root.utxo, cfg.utxo],
      read: [],
      outputs: [{ address: this.bech32(cfg.config.buyer_refund), assets: this.rootRemainder(root, cfg, {}) }],
      mint: this.exitBurn(treeId),
      signers: [cfg.config.buyer],
      window: this.window(null),
      actions: (ix) => [{ type: "Cancel", node_in: ix.input(root.utxo), config_in: ix.input(cfg.utxo), refund_out: 0n }],
    });
  }

  /**
   * Owner reclaim of a bond after `release_after` (ADR 4.4 path b). No logic script runs: the bond
   * validator checks the owner signature and the validity lower bound only.
   */
  async reclaimBond(bond: BondRef): Promise<BuiltTx> {
    const window = this.after(bond.datum.release_after);
    const tx = this.lucid
      .newTx()
      .readFrom([this.refs.bond])
      .collectFrom([bond.utxo], Data.void())
      .pay.ToAddress(this.bech32(bond.datum.owner_address), bond.utxo.assets)
      .addSignerKey(bond.datum.owner)
      .validFrom(window.validFrom)
      .validTo(window.validTo);
    const signBuilder = await tx.complete({ localUPLCEval: false });
    const cbor = signBuilder.toCBOR();
    const provider = this.lucid.config().provider;
    if (provider === undefined) throw new Error("Lucid instance has no provider");
    const evaluation = await provider.evaluateTx(cbor);
    return { tx: signBuilder, txHash: signBuilder.toHash(), cbor, evaluation, logic: null, signers: [bond.datum.owner] };
  }
}
