/**
 * Masumi leaves bought through the seller's native MIP-003 `/start_job` purchase flow (ADR 8,
 * docs/research/x402-cardano-spec.md 4.2.5). The seller's payment service returns a
 * `blockchainIdentifier`; decoding it gives the lock fields the Draw must write so the seller's
 * own tooling recognises the lock.
 */
import lzString from "lz-string";

export interface DecodedBlockchainIdentifier {
  sellerNonce: string;
  agentIdentifier: string;
  buyerNonce: string;
  referenceSignature: string;
  referenceKey: string;
  contractAddress: string;
}

const HEX = /^(?:[0-9a-f]{2})*$/;

export class BlockchainIdentifierError extends Error {
  override readonly name = "BlockchainIdentifierError";
}

/** `hex(LZString.compressToUint8Array(identifierText))` back to its five segments. */
export function decodeBlockchainIdentifier(identifier: string): DecodedBlockchainIdentifier {
  const hex = identifier.toLowerCase();
  if (hex.length === 0 || !HEX.test(hex)) throw new BlockchainIdentifierError("blockchainIdentifier must be hex");
  const text = lzString.decompressFromUint8Array(Uint8Array.from(Buffer.from(hex, "hex")));
  if (typeof text !== "string" || text.length === 0) throw new BlockchainIdentifierError("blockchainIdentifier does not decompress");
  const parts = text.split(".");
  if (parts.length !== 5) throw new BlockchainIdentifierError(`expected 5 segments, found ${parts.length}`);
  const [sellerIdentifier, buyerNonce, referenceSignature, referenceKey, contractAddress] = parts as [string, string, string, string, string];
  if (sellerIdentifier.length < 64 || !HEX.test(sellerIdentifier)) throw new BlockchainIdentifierError("seller identifier must start with a 32-byte nonce");
  for (const [name, v] of [["buyer nonce", buyerNonce], ["reference signature", referenceSignature], ["reference key", referenceKey]] as const) {
    if (!HEX.test(v)) throw new BlockchainIdentifierError(`${name} is not hex`);
  }
  if (!/^addr(_test)?1[0-9a-z]+$/.test(contractAddress)) throw new BlockchainIdentifierError("contract address is not bech32");
  return { sellerNonce: sellerIdentifier.slice(0, 64), agentIdentifier: sellerIdentifier.slice(64), buyerNonce, referenceSignature, referenceKey, contractAddress };
}
