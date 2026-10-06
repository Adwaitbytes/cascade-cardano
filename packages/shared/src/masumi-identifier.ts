/**
 * Masumi `blockchainIdentifier` (x402 spec 4.2.5; Masumi V2 purchase flow): the LZString-compressed
 * text `sellerNonce ++ agentIdentifier . buyerNonce . referenceSignature . referenceKey .
 * contractAddress`, hex encoded. Every segment is in the `vested_pay` lock datum, so an indexer can
 * rebuild the identifier of any lock from chain data alone.
 */
import lzString from "lz-string";
import { bytesToHex, hexToBytes } from "./bytes.js";
import type { MasumiDatum } from "./types.js";

export interface MasumiIdentifierParts {
  sellerNonce: string;
  /** Empty for an unregistered seller. */
  agentIdentifier: string;
  buyerNonce: string;
  referenceSignature: string;
  referenceKey: string;
  /** Bech32 escrow address. */
  contractAddress: string;
}

const HEX = /^(?:[0-9a-f]{2})*$/;

export function encodeMasumiIdentifier(p: MasumiIdentifierParts): string {
  if (!/^[0-9a-f]{64}$/.test(p.sellerNonce)) throw new TypeError("sellerNonce must be 32 bytes of lowercase hex");
  for (const v of [p.agentIdentifier, p.buyerNonce, p.referenceSignature, p.referenceKey]) if (!HEX.test(v)) throw new TypeError("identifier segments must be lowercase hex");
  const text = [`${p.sellerNonce}${p.agentIdentifier}`, p.buyerNonce, p.referenceSignature, p.referenceKey, p.contractAddress].join(".");
  return bytesToHex(lzString.compressToUint8Array(text));
}

/** The five segments, or null when the value is not a well-formed identifier. */
export function decodeMasumiIdentifier(identifier: string): MasumiIdentifierParts | null {
  if (identifier.length === 0 || !HEX.test(identifier)) return null;
  const text = lzString.decompressFromUint8Array(hexToBytes(identifier));
  if (typeof text !== "string") return null;
  const parts = text.split(".");
  if (parts.length !== 5) return null;
  const [seller, buyerNonce, referenceSignature, referenceKey, contractAddress] = parts as [string, string, string, string, string];
  if (seller.length < 64 || !HEX.test(seller) || !HEX.test(buyerNonce) || !HEX.test(referenceSignature) || !HEX.test(referenceKey)) return null;
  return { sellerNonce: seller.slice(0, 64), agentIdentifier: seller.slice(64), buyerNonce, referenceSignature, referenceKey, contractAddress };
}

/** The identifier of a `vested_pay` lock, rebuilt from its datum and escrow address. */
export const masumiIdentifierFromDatum = (d: MasumiDatum, contractAddress: string): string =>
  encodeMasumiIdentifier({
    sellerNonce: d.seller_nonce,
    agentIdentifier: d.agent_identifier,
    buyerNonce: d.buyer_nonce,
    referenceSignature: d.reference_signature,
    referenceKey: d.reference_key,
    contractAddress,
  });
