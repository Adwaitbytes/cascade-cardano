/**
 * Real Yaci transactions for facilitator tests. Wallets are Yaci DevKit's public default accounts
 * (docs/research/yaci-devkit.md); accounts 18 and 19 are reserved for these tests.
 */
import { Constr, Data, getAddressDetails, mintingPolicyToId, scriptFromNative, type LucidEvolution } from "@lucid-evolution/lucid";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { OgmiosClient, chainTxFromCbor, createPool, loadNetworkConfig, makeLucid, resolveSlotConfig, type Pool } from "@cascade/service-kit";
import { pino } from "pino";
import { OgmiosChain } from "../src/chain.js";
import { PgClaimStore } from "../src/claims.js";
import { CascadeCardanoFacilitator, LOCAL_NETWORK } from "../src/scheme.js";

export const YACI_MNEMONIC = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
export const cfg = loadNetworkConfig("local");

export async function lucidFor(account: number): Promise<LucidEvolution> {
  const lucid = await makeLucid(cfg);
  lucid.selectWallet.fromSeed(YACI_MNEMONIC, { accountIndex: account });
  return lucid;
}

export function makeFacilitator(pool: Pool, submitCounter?: { n: number }, nodeScriptHash: string | null = null) {
  const inner = new OgmiosChain(new OgmiosClient(cfg.ogmiosHttp), { url: cfg.blockfrostUrl ?? "", projectId: null });
  const chain = submitCounter === undefined ? inner : Object.assign(Object.create(inner) as OgmiosChain, {
    submit: async (cbor: string) => {
      submitCounter.n++;
      return inner.submit(cbor);
    },
  });
  return async () =>
    new CascadeCardanoFacilitator({
      profile: { network: LOCAL_NETWORK, slotConfig: await resolveSlotConfig(cfg), masumi: false },
      chain,
      claims: new PgClaimStore(pool),
      log: pino({ level: "silent" }),
      nodeScriptHash,
      confirmationWaitMs: 1_500,
      confirmationPollMs: 500,
    });
}

export interface Built {
  cbor: string;
  txId: string;
  nonce: string;
}

/** Signs (never submits) a payment of `lovelace` to `payTo`, TTL `ttlMs` from now. */
export async function buildPayment(lucid: LucidEvolution, payTo: string, lovelace: bigint, opts: { ttlMs?: number; datum?: string; mintNative?: boolean } = {}): Promise<Built> {
  let b = lucid.newTx();
  b = opts.datum === undefined ? b.pay.ToAddress(payTo, { lovelace }) : b.pay.ToAddressWithData(payTo, { kind: "inline", value: opts.datum }, { lovelace });
  if (opts.mintNative === true) {
    const addr = await lucid.wallet().address();
    const { paymentCredential } = getAddressDetails(addr);
    const policy = scriptFromNative({ type: "sig", keyHash: paymentCredential?.hash ?? "" });
    const unit = `${mintingPolicyToId(policy)}74657374`;
    b = b.mintAssets({ [unit]: 1n }).attach.MintingPolicy(policy).pay.ToAddress(addr, { lovelace: 2_000_000n, [unit]: 1n });
  }
  const tx = await b.validTo(Date.now() + (opts.ttlMs ?? 120_000)).complete();
  const signed = await tx.sign.withWallet().complete();
  const cbor = signed.toCBOR();
  const utxos = await lucid.wallet().getUtxos();
  const txId = signed.toHash();
  const inputs = chainTxFromCbor(cbor).inputs;
  const nonce = inputs.find((i) => utxos.some((u) => `${u.txHash}#${u.outputIndex}` === i)) ?? (inputs[0] as string);
  return { cbor, txId, nonce };
}

export function requirements(payTo: string, amount: string, extra: Record<string, unknown> = {}): PaymentRequirements {
  return { scheme: "exact", network: LOCAL_NETWORK, asset: "lovelace", amount, payTo, maxTimeoutSeconds: 600, extra: { confirmationPolicy: { l1Confirmations: 0 }, ...extra } };
}

export function payload(b: Built, req: PaymentRequirements): PaymentPayload {
  return { x402Version: 2, resource: { url: "https://agent.test/jobs", description: "", mimeType: "application/json" }, accepted: req, payload: { transaction: Buffer.from(b.cbor, "hex").toString("base64"), nonce: b.nonce } };
}

export const inlineDatum = (n: bigint) => Data.to(new Constr(0, [n]));

export async function newPool(url: string): Promise<Pool> {
  return createPool(url, 4);
}
