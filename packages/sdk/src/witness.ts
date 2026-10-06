/** Signing a transaction with keys held outside the process (the signer service). */
import { CML } from "@lucid-evolution/lucid";

/** Returns the CBOR hex of a vkey witness for the given unsigned transaction (CBOR hex). */
export type KeySigner = (txCbor: string) => Promise<string>;

/** Adds vkey witnesses without touching the body bytes, so the tx id is unchanged. */
export function attachWitness(txCbor: string, ...witnessCbors: string[]): string {
  const tx = CML.Transaction.from_cbor_hex(txCbor);
  const ws = tx.witness_set();
  const list = ws.vkeywitnesses() ?? CML.VkeywitnessList.new();
  for (const w of witnessCbors) list.add(CML.Vkeywitness.from_cbor_hex(w));
  ws.set_vkeywitnesses(list);
  return CML.Transaction.new(tx.body(), ws, tx.is_valid(), tx.auxiliary_data()).to_cbor_hex();
}

/** Signs through the Cascade signer service (`POST /v1/sign`), which enforces the role's gate rules. */
/** The signer service refused to sign; `reasons` are the failed gate names. */
export class SignerDeniedError extends Error {
  constructor(
    readonly role: string,
    readonly reasons: readonly string[],
    detail: string,
  ) {
    super(`signer denied ${role}: ${detail}`);
    this.name = "SignerDeniedError";
  }
}

export function signerServiceSigner(baseUrl: string, token: string, role: string): KeySigner {
  return async (txCbor) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/sign`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ role, tx_cbor: txCbor }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json()) as { decision?: string; witness?: string; reasons?: unknown; error?: unknown };
    if (!res.ok || body.decision !== "allow" || typeof body.witness !== "string") {
      const reasons = Array.isArray(body.reasons) ? body.reasons.filter((r): r is string => typeof r === "string") : [];
      throw new SignerDeniedError(role, reasons, JSON.stringify(body.reasons ?? body.error ?? res.status));
    }
    return body.witness;
  };
}

/** Local key signer. For Yaci tests only; production signs through `signerServiceSigner`. */
export function privateKeySigner(privateKey: string): KeySigner {
  return async (txCbor) => {
    const tx = CML.Transaction.from_cbor_hex(txCbor);
    return CML.make_vkey_witness(CML.hash_transaction(tx.body()), CML.PrivateKey.from_bech32(privateKey)).to_cbor_hex();
  };
}
