/**
 * Buy side (PRD 8.3): pay an x402 `default` (address) requirement out of a Cascade tree with an
 * AddressPayment Draw (ADR 5.2), so the payment is plan-bound and capped by the leaf.
 */
import { decodeCardanoTransaction } from "@x402/cardano";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { paymentKeyHash, type PlanLeaf, type ProofStep } from "@cascade/shared";
import type { CascadeClient } from "@cascade/sdk";

export interface TreePayer {
  client: CascadeClient;
  /** Node that pays (its operator signs the Draw). */
  parentId: string;
  /** Bech32 private key of the parent operator. */
  operatorKey: string;
  /** x402 network id the tree lives on, e.g. `cardano:preprod`. */
  network: string;
  /** The buyer-approved AddressPayment leaf for this seller, or null to refuse. */
  leafFor(requirements: PaymentRequirements): { leaf: PlanLeaf; proof: ProofStep[] } | null;
}

export class PaymentRefused extends Error {
  override readonly name = "PaymentRefused";
}

const unitOf = (asset: { policy: string; name: string }): string => (asset.policy === "" ? "lovelace" : `${asset.policy}.${asset.name}`);

/** Pick a payable `default` requirement and pay it from the tree. Returns the x402 payload. */
export async function payFromTree(accepts: PaymentRequirements[], payer: TreePayer, resource?: PaymentPayload["resource"]): Promise<PaymentPayload> {
  const { client } = payer;
  const parent = await client.node(payer.parentId);
  const cfg = await client.config(parent.datum.tree_id);
  const treeAsset = unitOf(cfg.config.asset);
  const candidates = accepts.filter((a) => a.scheme === "exact" && a.network === payer.network && (a.extra["assetTransferMethod"] ?? "default") === "default" && a.asset === treeAsset);
  for (const req of candidates) {
    const choice = payer.leafFor(req);
    if (choice === null) continue;
    if (choice.leaf.kind !== "AddressPayment") throw new PaymentRefused("leaf is not an AddressPayment leaf");
    if (paymentKeyHash(req.payTo) !== choice.leaf.payee_hash) throw new PaymentRefused("payTo is not the plan-bound payee");
    const amount = BigInt(req.amount);
    if (amount <= 0n || amount > choice.leaf.max_budget) throw new PaymentRefused(`amount ${amount} exceeds the leaf ceiling ${choice.leaf.max_budget}`);

    const walletUtxos = await client.lucid.wallet().getUtxos();
    const built = await client.draw(payer.parentId, [{ kind: "address", leaf: choice.leaf, proof: choice.proof, amount, payeeAddress: req.payTo }], {
      maxValidityMs: req.maxTimeoutSeconds * 1000,
    });
    const signed = await built.tx.sign.withWallet().sign.withPrivateKey(payer.operatorKey).complete();
    const transaction = Buffer.from(signed.toCBOR(), "hex").toString("base64");
    const inputs = new Set(decodeCardanoTransaction(transaction).inputs);
    const nonce = walletUtxos.map((u) => `${u.txHash}#${u.outputIndex}`).find((ref) => inputs.has(ref));
    if (nonce === undefined) throw new PaymentRefused("the Draw spends no wallet input to use as the nonce");
    return { x402Version: 2, ...(resource === undefined ? {} : { resource }), accepted: req, payload: { transaction, nonce } };
  }
  throw new PaymentRefused("no payable default requirement for this tree");
}

/** `fetch` that answers a 402 by paying from the tree and retrying once. */
export async function fetchWithTreePayment(
  input: string | URL,
  init: RequestInit,
  payer: TreePayer,
): Promise<{ response: Response; settlement: SettleResponse | null }> {
  const first = await fetch(input, init);
  if (first.status !== 402) return { response: first, settlement: null };
  const header = first.headers.get("PAYMENT-REQUIRED");
  if (header === null) throw new PaymentRefused("402 without PAYMENT-REQUIRED");
  const required = decodePaymentRequiredHeader(header);
  const payload = await payFromTree(required.accepts, payer, required.resource);
  const headers = new Headers(init.headers);
  headers.set("PAYMENT-SIGNATURE", encodePaymentSignatureHeader(payload));
  const response = await fetch(input, { ...init, headers });
  const settled = response.headers.get("PAYMENT-RESPONSE");
  return { response, settlement: settled === null ? null : decodePaymentResponseHeader(settled) };
}
