/**
 * Masumi leaves through the tree's purchase wallet P (ADR 0001 section 8.1). The Masumi Payment
 * Service skips any lock created in a transaction with redeemers, so:
 * 1. the parent Draws an AddressPayment child paying exactly the lock value to P (plan-bound by
 *    the leaf's `payee_hash`);
 * 2. P creates the `vested_pay` lock in a plain key-signed transaction (no scripts, no redeemers):
 *    buyer = P, buyer_return_address = the tree's `buyer_refund`, seller fields and identifiers
 *    from the seller's `/start_job` and signed terms;
 * 3. on failure P signs SetRefundRequested and WithdrawRefund; the refund goes to `buyer_refund`.
 * P's key never enters these drivers: every P transaction is signed through a `KeySigner`
 * (the signer service in production; a local key only in Yaci tests).
 */
import { CML, Lucid, valueToAssets, type Assets, type LucidEvolution, type Script, type TxSignBuilder, type UTxO } from "@lucid-evolution/lucid";
import {
  coseSignedAddress,
  decodeMasumiDatum,
  decodeNodeDatum,
  decodeMasumiIdentifier,
  encodeMasumiDatum,
  masumiCollateralLovelace,
  masumiDeadlineErrors,
  masumiIdentifierFromDatum,
  masumiMinUtxoLovelace,
  paymentKeyHash,
  plutusAddressFromBech32,
  plutusAddressToBech32,
  type MasumiDatum,
  type PlutusAddress,
  type PlanLeaf,
  type ProofStep,
} from "@cascade/shared";
import type { CascadeClient } from "../client.js";
import { awaitConfirmed } from "../confirm.js";
import type { ChainTxReader } from "../chain-reader.js";
import { buildMasumiRequestRefund, buildMasumiWithdrawRefund, findMasumiLock, vendoredMasumiScript } from "../masumi.js";
import type { MasumiTerms } from "./masumi-leaf.js";
import { attachWitness, SignerDeniedError, signerServiceSigner, type KeySigner } from "../witness.js";

/** A purchase wallet: its key address and how it signs. */
export interface Purchaser {
  address: string;
  sign: KeySigner;
}

/** P's signer through the signer service (role `masumi-purchaser`). */
export const purchaserServiceSigner = (baseUrl: string, token: string): KeySigner => signerServiceSigner(baseUrl, token, "masumi-purchaser");

/** A Lucid instance whose wallet is P (by address: it can build and balance, never sign). */
async function purchaserLucid(client: CascadeClient, address: string): Promise<LucidEvolution> {
  const cfg = client.lucid.config();
  if (cfg.provider === undefined || cfg.network === undefined) throw new Error("client Lucid has no provider");
  const lucid = await Lucid(cfg.provider, cfg.network, cfg.slotConfig === undefined ? {} : { slotConfig: cfg.slotConfig });
  lucid.selectWallet.fromAddress(address, await cfg.provider.getUtxos(address));
  return lucid;
}

/** How long a lock waits for the indexer to project the Draw that paid P (the signer reads it there). */
const DRAW_INDEX_WAIT_MS = 300_000;

/**
 * Asks P's signer for a witness. For a lock, the signer's `received-funds` gate fails until the
 * indexer has projected the Draw, so that one refusal is retried for a bounded time.
 */
async function purchaserWitness(purchaser: Purchaser, cbor: string, awaitDrawIndexed: boolean): Promise<string> {
  const deadline = Date.now() + DRAW_INDEX_WAIT_MS;
  for (;;) {
    try {
      return await purchaser.sign(cbor);
    } catch (e) {
      const unindexed = e instanceof SignerDeniedError && e.reasons.includes("received-funds");
      if (!awaitDrawIndexed || !unindexed || Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/** Sign an unsigned P transaction through `signer`, submit it and wait until P's wallet sees it. */
async function submitAsPurchaser(lucid: LucidEvolution, tx: TxSignBuilder, purchaser: Purchaser, awaitDrawIndexed = false): Promise<string> {
  const cbor = tx.toCBOR();
  const signed = attachWitness(cbor, await purchaserWitness(purchaser, cbor, awaitDrawIndexed));
  const provider = lucid.config().provider;
  if (provider === undefined) throw new Error("Lucid instance has no provider");
  const txHash = await provider.submitTx(signed);
  await awaitConfirmed(lucid, txHash, {}, "Masumi purchaser transaction");
  // An address-only wallet keeps the UTxO list it was given; wait on the provider's view of P instead.
  const address = await lucid.wallet().address();
  const deadline = Date.now() + 180_000;
  while (!(await provider.getUtxos(address)).some((u) => u.txHash === txHash)) {
    if (Date.now() > deadline) throw new Error(`P's UTxOs do not show ${txHash} yet`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  return txHash;
}

export interface MasumiPurchase {
  drawTx: string;
  lockTx: string;
  lockOutRef: { txHash: string; outputIndex: number };
  escrowAddress: string;
  sellerAddress: string;
  referenceSignature: string;
  blockchainIdentifier: string;
  datum: MasumiDatum;
  lockedLovelace: bigint;
}

/** Everything the lock will hold, computed before any Draw (pure: no chain access). */
export interface MasumiLockPlan {
  datum: MasumiDatum;
  /** Exact lovelace of the lock: price plus collateral. The AddressPayment to P pays this. */
  lockedLovelace: bigint;
  collateral: bigint;
  escrowAddress: string;
  sellerAddress: string;
  referenceSignature: string;
  blockchainIdentifier: string;
}

/**
 * Checks the seller's `/start_job` terms and returns the exact `vested_pay` lock P will write (ADR
 * 8.1 step 2): identifier, escrow, agent id, purchaser identifier, seller key (from the seller's
 * signed COSE header), registered price, and that the datum reproduces the seller's
 * `blockchainIdentifier`. Lovelace prices only (preprod trees are lovelace).
 */
export function masumiLockPlan(input: {
  terms: MasumiTerms;
  price: { unit: string; amount: bigint };
  purchaserAddress: string;
  buyerRefund: PlutusAddress;
  /** Bech32 `vested_pay` address the tree allows (config `masumi_script_hash`). */
  escrowAddress: string;
  coinsPerUtxoByte: bigint;
}): MasumiLockPlan {
  const { terms } = input;
  const id = decodeMasumiIdentifier(terms.blockchainIdentifier);
  if (id === null) throw new Error("blockchainIdentifier does not decode");
  if (id.contractAddress !== input.escrowAddress) throw new Error(`the seller signed for escrow ${id.contractAddress}; the tree allows ${input.escrowAddress}`);
  if (id.agentIdentifier !== terms.agentIdentifier) throw new Error("identifier and agentIdentifier differ");
  if (id.buyerNonce !== terms.identifierFromPurchaser) throw new Error("identifier does not carry our purchaser identifier");
  const sellerAddress = coseSignedAddress({ signature: id.referenceSignature, key: id.referenceKey });
  if (paymentKeyHash(sellerAddress) !== terms.sellerVKey) throw new Error("sellerVKey is not the key that signed the identifier");
  if (input.price.unit !== "lovelace") throw new Error("Masumi purchases through P are implemented for lovelace prices");
  if (terms.amounts.length > 0 && !terms.amounts.some((a) => a.unit === input.price.unit && a.amount === input.price.amount)) {
    throw new Error("/start_job amounts disagree with the registered price; refusing to pay");
  }
  const datumFor = (collateral: bigint): MasumiDatum => ({
    buyer: plutusAddressFromBech32(input.purchaserAddress),
    buyer_return_address: input.buyerRefund,
    seller: plutusAddressFromBech32(sellerAddress),
    seller_return_address: null,
    reference_key: id.referenceKey,
    reference_signature: id.referenceSignature,
    seller_nonce: id.sellerNonce,
    buyer_nonce: id.buyerNonce,
    agent_identifier: id.agentIdentifier,
    collateral_return_lovelace: collateral,
    input_hash: terms.input_hash,
    result_hash: "",
    pay_by_time: terms.payByTime,
    submit_result_time: terms.submitResultTime,
    unlock_time: terms.unlockTime,
    external_dispute_unlock_time: terms.externalDisputeUnlockTime,
    seller_cooldown_time: 0n,
    buyer_cooldown_time: 0n,
    state: "FundsLocked",
  });
  let collateral = 0n;
  for (let round = 0; round < 2; round++) {
    collateral = masumiCollateralLovelace(input.price.amount, masumiMinUtxoLovelace(encodeMasumiDatum(datumFor(collateral)).length / 2, 0, input.coinsPerUtxoByte));
  }
  const datum = datumFor(collateral);
  if (masumiIdentifierFromDatum(datum, input.escrowAddress) !== terms.blockchainIdentifier) throw new Error("the lock datum would not reproduce the seller's blockchainIdentifier");
  return {
    datum,
    lockedLovelace: input.price.amount + collateral,
    collateral,
    escrowAddress: input.escrowAddress,
    sellerAddress,
    referenceSignature: id.referenceSignature,
    blockchainIdentifier: terms.blockchainIdentifier,
  };
}

/**
 * Deadline checks before P locks (amended ADR 8.1, same as the signer's purchaser gate): pay_by_time
 * in the future and Masumi's own minimum gaps. The escrow's deadlines are not nested in the tree's
 * window; the seller fixes them and the refund goes to `buyer_refund` whenever it happens.
 */
export function purchaseDeadlineErrors(
  t: Pick<MasumiTerms, "payByTime" | "submitResultTime" | "unlockTime" | "externalDisputeUnlockTime">,
  now: bigint,
): string[] {
  const errors = t.payByTime <= now ? ["payByTime must be in the future"] : [];
  return [...errors, ...masumiDeadlineErrors(t)];
}

/** The lock plan for a tree: reads the config (escrow, buyer_refund) and live coinsPerUtxoByte. */
async function planForTree(client: CascadeClient, parentId: string, terms: MasumiTerms, price: { unit: string; amount: bigint }, purchaserAddress: string) {
  const parent = await client.node(parentId);
  const cfg = await client.config(parent.datum.tree_id);
  if (cfg.config.asset.policy !== "") throw new Error("Masumi purchases through P are implemented for lovelace trees");
  const deadlines = purchaseDeadlineErrors(terms, BigInt(Date.now()));
  if (deadlines.length > 0) throw new Error(`the seller's Masumi deadlines are not usable: ${deadlines.join("; ")}`);
  const cpb = client.lucid.config().protocolParameters?.coinsPerUtxoByte;
  if (cpb === undefined) throw new Error("protocol parameters are not loaded");
  const escrowAddress = client.bech32({ payment_credential: { type: "Script", hash: cfg.config.masumi_script_hash }, stake_credential: null });
  return masumiLockPlan({ terms, price, purchaserAddress, buyerRefund: cfg.config.buyer_refund, escrowAddress, coinsPerUtxoByte: cpb });
}

/**
 * ADR 8.1 step 2 on its own: after the AddressPayment Draw `drawTx` paid P, P locks exactly the
 * planned value into `vested_pay` in a plain key transaction (checked redeemer-free) and signs it
 * through `purchaser.sign`.
 */
export async function lockViaPurchaser(
  client: CascadeClient,
  p: { drawTx: string; parentId: string; leaf: PlanLeaf; terms: MasumiTerms; price: { unit: string; amount: bigint }; purchaser: Purchaser },
): Promise<MasumiPurchase> {
  const plan = await planForTree(client, p.parentId, p.terms, p.price, p.purchaser.address);
  if (p.leaf.kind !== "AddressPayment" || p.leaf.payee_hash !== paymentKeyHash(p.purchaser.address)) throw new Error("the leaf must be an AddressPayment to the purchase wallet P");
  const lucid = await purchaserLucid(client, p.purchaser.address);
  const funding = (await lucid.wallet().getUtxos()).find((u) => u.txHash === p.drawTx);
  if (funding === undefined) throw new Error("P has not received the Draw payment");
  if ((funding.assets.lovelace ?? 0n) !== plan.lockedLovelace) throw new Error(`P received ${funding.assets.lovelace ?? 0n}, the lock needs ${plan.lockedLovelace}`);
  const tx = await lucid
    .newTx()
    .collectFrom([funding])
    .pay.ToContract(plan.escrowAddress, { kind: "inline", value: encodeMasumiDatum(plan.datum) }, { lovelace: plan.lockedLovelace })
    .validTo(Math.min(Number(p.terms.payByTime), lucid.slotToUnixTime(lucid.currentSlot()) + 240_000))
    .complete();
  // ADR 8.1: Masumi's service only accepts locks created without redeemers.
  if (CML.Transaction.from_cbor_hex(tx.toCBOR()).witness_set().redeemers() !== undefined) throw new Error("the lock transaction carries redeemers");
  const lockTx = await submitAsPurchaser(lucid, tx, p.purchaser, true);
  return {
    drawTx: p.drawTx,
    lockTx,
    lockOutRef: { txHash: lockTx, outputIndex: 0 },
    escrowAddress: plan.escrowAddress,
    sellerAddress: plan.sellerAddress,
    referenceSignature: plan.referenceSignature,
    blockchainIdentifier: plan.blockchainIdentifier,
    datum: plan.datum,
    lockedLovelace: plan.lockedLovelace,
  };
}

/**
 * ADR 8.1 steps 1 and 2: plan the lock, Draw an AddressPayment of exactly its value to P (signed by
 * `signDraw`, the parent operator through the signer service; `operatorKeys` only in Yaci tests;
 * retried on stale indexer inputs), then `lockViaPurchaser`.
 */
export async function drawMasumiViaPurchaser(
  client: CascadeClient,
  p: {
    parentId: string;
    /** AddressPayment leaf whose `payee_hash` is P's payment key hash. */
    leaf: PlanLeaf;
    proof: ProofStep[];
    terms: MasumiTerms;
    /** The seller's registered price, which its payment service requests. */
    price: { unit: string; amount: bigint };
    purchaser: Purchaser;
    /** Parent operator witness through the signer service. */
    signDraw?: KeySigner;
    /** Parent operator private keys. Yaci tests only. */
    operatorKeys?: string[];
  },
): Promise<MasumiPurchase> {
  if (p.signDraw === undefined && (p.operatorKeys === undefined || p.operatorKeys.length === 0)) throw new Error("give signDraw (or operatorKeys in tests)");
  if (p.leaf.kind !== "AddressPayment" || p.leaf.payee_hash !== paymentKeyHash(p.purchaser.address)) throw new Error("the leaf must be an AddressPayment to the purchase wallet P");
  const plan = await planForTree(client, p.parentId, p.terms, p.price, p.purchaser.address);
  if (plan.lockedLovelace > p.leaf.max_budget) throw new Error(`the lock needs ${plan.lockedLovelace}, above the leaf ceiling ${p.leaf.max_budget}`);
  const { txHash: drawTx } = await client.buildAndSubmit(
    () => client.draw(p.parentId, [{ kind: "address", leaf: p.leaf, proof: p.proof, amount: plan.lockedLovelace, payeeAddress: p.purchaser.address }]),
    p.operatorKeys ?? [],
    4,
    p.signDraw === undefined ? [] : [p.signDraw],
  );
  return lockViaPurchaser(client, { drawTx, parentId: p.parentId, leaf: p.leaf, terms: p.terms, price: p.price, purchaser: p.purchaser });
}

async function liveLock(lucid: LucidEvolution, escrowAddress: string, referenceSignature: string): Promise<UTxO> {
  const lock = await findMasumiLock(lucid, escrowAddress, referenceSignature);
  if (lock === null) throw new Error("Masumi lock not found");
  return lock;
}

/** Step 3a: P requests the refund (SetRefundRequested) of a lock with no result. */
export async function requestMasumiRefundViaPurchaser(
  client: CascadeClient,
  p: { purchaser: Purchaser; escrowAddress: string; referenceSignature: string; script?: Script | UTxO },
): Promise<string> {
  const lucid = await purchaserLucid(client, p.purchaser.address);
  const lock = await liveLock(lucid, p.escrowAddress, p.referenceSignature);
  if (decodeMasumiDatum(lock.datum ?? "").result_hash !== "") throw new Error("the seller submitted a result: not a failed leaf");
  const { tx } = await buildMasumiRequestRefund(lucid, { lock, script: p.script ?? vendoredMasumiScript().script });
  return submitAsPurchaser(lucid, tx, p.purchaser);
}

/**
 * Step 3b: P withdraws the refund after `submit_result_time`. Throws unless the whole lock value
 * landed at `buyerRefund` in the Masumi-tagged output and nothing went to P or `orchestrator`.
 * Without `buyerRefund` the lock's own `buyer_return_address` is used (chain data alone, for the
 * watchtower); P-path locks always carry the tree's `buyer_refund` there (the signer enforces it).
 */
export async function withdrawMasumiRefundViaPurchaser(
  client: CascadeClient,
  p: { purchaser: Purchaser; escrowAddress: string; referenceSignature: string; script?: Script | UTxO; buyerRefund?: string; orchestrator?: string },
): Promise<string> {
  const lucid = await purchaserLucid(client, p.purchaser.address);
  const lock = await liveLock(lucid, p.escrowAddress, p.referenceSignature);
  const built = await buildMasumiWithdrawRefund(lucid, { lock, script: p.script ?? vendoredMasumiScript().script, networkId: client.networkId });
  if (built.refundAddress === p.purchaser.address) throw new Error("the lock refunds to P itself");
  if (p.buyerRefund !== undefined && built.refundAddress !== p.buyerRefund) throw new Error(`the lock refunds to ${built.refundAddress}, not buyer_refund`);
  const buyerRefund = p.buyerRefund ?? built.refundAddress;
  const txHash = await submitAsPurchaser(lucid, built.tx, p.purchaser);
  const outputs = await client.lucid.utxosByOutRef(Array.from({ length: 4 }, (_, i) => ({ txHash, outputIndex: i })));
  const lockValue = lock.assets.lovelace ?? 0n;
  const toRefund = outputs.filter((o) => o.address === buyerRefund).reduce((s, o) => s + (o.assets.lovelace ?? 0n), 0n);
  if (toRefund < lockValue) throw new Error(`buyer_refund received ${toRefund}, the lock held ${lockValue}`);
  if (p.orchestrator !== undefined && outputs.some((o) => o.address === p.orchestrator)) throw new Error("the refund paid the orchestrator");
  // Value is conserved and buyer_refund holds the whole lock, so neither P nor anyone else kept it.
  return txHash;
}

export const purchaserBech32 = (vkh: string, networkId: 0 | 1): string =>
  plutusAddressToBech32({ payment_credential: { type: "VerificationKey", hash: vkh }, stake_credential: null }, networkId);

// ---------------------------------------------------------------------------------------------
// ADR 0001 section 8.1 items 4a and 4b: P's return path and the watchtower's view of P.

const sameAssets = (a: Assets, b: Assets): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => (a[k] ?? 0n) === (b[k] ?? 0n));
};

/** A Draw payment P received and still holds (never locked). */
export interface UnlockedPurchaserReceipt {
  utxo: UTxO;
  drawTx: string;
  treeId: string;
  /** The node that drew the AddressPayment to P. */
  drawingNodeId: string;
  /** The tree's `buyer_refund` (bech32), where a return must go. */
  buyerRefund: string;
}

/**
 * P's UTxOs that are AddressPayments from a Cascade Draw, i.e. created by a transaction that spent
 * a `cascade_node` output, and so still unlocked (8.1 item 4a). P's change and float top-ups are
 * not listed. `reader` resolves the creating transactions' inputs.
 */
export async function unlockedPurchaserReceipts(client: CascadeClient, reader: ChainTxReader, purchaserAddress: string): Promise<UnlockedPurchaserReceipt[]> {
  const provider = client.lucid.config().provider;
  if (provider === undefined) throw new Error("client Lucid has no provider");
  const held = await provider.getUtxos(purchaserAddress);
  const out: UnlockedPurchaserReceipt[] = [];
  for (const txHash of new Set(held.map((u) => u.txHash))) {
    const { inputs } = await reader.tx(txHash);
    const node = inputs.find((i) => i.address === client.addresses.node && i.inlineDatum !== null);
    if (node === undefined || node.inlineDatum === null) continue;
    const drawing = decodeNodeDatum(node.inlineDatum);
    const cfg = await client.config(drawing.tree_id);
    const buyerRefund = client.bech32(cfg.config.buyer_refund);
    for (const utxo of held.filter((u) => u.txHash === txHash)) out.push({ utxo, drawTx: txHash, treeId: drawing.tree_id, drawingNodeId: drawing.node_id, buyerRefund });
  }
  return out;
}

/**
 * 8.1 item 4a: P returns exactly what one Draw paid it to the tree's `buyer_refund`, in a plain
 * key transaction signed through `purchaser.sign` (the signer's P role). Fees come from P's own
 * other inputs; their change returns to P. Throws unless the output to `buyer_refund` carries
 * exactly the received value.
 */
export async function returnUnlockedToBuyer(client: CascadeClient, p: { drawTx: string; treeId: string; purchaser: Purchaser }): Promise<{ txHash: string; returned: Assets; buyerRefund: string }> {
  const lucid = await purchaserLucid(client, p.purchaser.address);
  const received = (await lucid.wallet().getUtxos()).filter((u) => u.txHash === p.drawTx);
  if (received.length !== 1) throw new Error(`P holds ${received.length} outputs of ${p.drawTx}; expected exactly the one Draw payment`);
  const funding = received[0] as UTxO;
  const buyerRefund = client.bech32((await client.config(p.treeId)).config.buyer_refund);
  if (buyerRefund === p.purchaser.address) throw new Error("buyer_refund is P itself");
  const tx = await lucid.newTx().collectFrom([funding]).pay.ToAddress(buyerRefund, funding.assets).complete();
  const body = CML.Transaction.from_cbor_hex(tx.toCBOR());
  if (body.witness_set().redeemers() !== undefined) throw new Error("the return transaction carries redeemers");
  const outs = body.body().outputs();
  const toBuyer: Assets[] = [];
  for (let i = 0; i < outs.len(); i++) {
    const o = outs.get(i);
    if (o.address().to_bech32() !== buyerRefund) continue;
    const assets = valueToAssets(o.amount());
    toBuyer.push(assets);
  }
  if (toBuyer.length !== 1 || !sameAssets(toBuyer[0] as Assets, funding.assets)) throw new Error("the return output does not carry exactly the received value");
  const txHash = await submitAsPurchaser(lucid, tx, p.purchaser);
  return { txHash, returned: funding.assets, buyerRefund };
}

/** What the watchtower crank does next for one of P's locks (8.1 item 4b). */
export type PurchaserLockAction = "request_refund" | "withdraw_refund";

export interface PurchaserLockDue {
  lock: UTxO;
  datum: MasumiDatum;
  action: PurchaserLockAction;
  referenceSignature: string;
  escrowAddress: string;
  /** `buyer_return_address` (bech32): where the refund goes. */
  buyerRefund: string;
}

/**
 * P's `vested_pay` locks with no result after `submit_result_time`: `request_refund` while still
 * FundsLocked, `withdraw_refund` once RefundRequested. Locks with a result, in dispute, or not yet
 * past `submit_result_time` are not listed. Chain data alone.
 */
export async function purchaserLocksDue(client: CascadeClient, p: { purchaserAddress: string; escrowAddress: string; now: bigint }): Promise<PurchaserLockDue[]> {
  const pVkh = paymentKeyHash(p.purchaserAddress);
  const out: PurchaserLockDue[] = [];
  for (const lock of await client.lucid.utxosAt(p.escrowAddress)) {
    if (lock.datum === undefined || lock.datum === null) continue;
    let datum: MasumiDatum;
    try {
      datum = decodeMasumiDatum(lock.datum);
    } catch {
      // Foreign or malformed outputs at the escrow address are not P's locks.
      continue;
    }
    const buyer = datum.buyer.payment_credential;
    if (buyer.type !== "VerificationKey" || buyer.hash !== pVkh) continue;
    if (datum.result_hash !== "" || p.now <= datum.submit_result_time || datum.buyer_return_address === null) continue;
    const action = datum.state === "FundsLocked" ? "request_refund" : datum.state === "RefundRequested" ? "withdraw_refund" : null;
    if (action === null) continue;
    out.push({ lock, datum, action, referenceSignature: datum.reference_signature, escrowAddress: p.escrowAddress, buyerRefund: client.bech32(datum.buyer_return_address) });
  }
  return out;
}
