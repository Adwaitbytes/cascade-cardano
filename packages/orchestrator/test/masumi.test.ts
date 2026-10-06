import { describe, expect, it } from "vitest";
import { BlockchainIdentifierError, decodeBlockchainIdentifier } from "../src/masumi.js";

// Vectors from the x402 Cardano spec 4.2.5 (docs/research/x402-cardano-spec.md).
const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";

describe("blockchainIdentifier", () => {
  it("decodes vector 1 (unregistered seller, empty buyer nonce)", () => {
    expect(
      decodeBlockchainIdentifier(
        "230d7c6574f41d1c0acc96ade8eae04360019f607004d8809c07d005c053019cae007700bce8058680d89818c04e44002c035931a2c00daf5e00ac9bf00b6c401b80473c6535d00e6003cb8b110199db615001ca8eecc6019b58076c603b13763a80",
      ),
    ).toEqual({ sellerNonce: "11".repeat(32), agentIdentifier: "", buyerNonce: "", referenceSignature: "55".repeat(16), referenceKey: "a10101", contractAddress: ESCROW });
  });

  it("decodes vector 2 (registered seller)", () => {
    expect(
      decodeBlockchainIdentifier(
        "130d7c6574f4218314e4b56f46e00602300e972d82c0662c0162c0562c0362c0763d6975b7d8f3b6f3874381e004d0402700fa005c0298067093803b802f19e4a6d05018c02715001601ac154a5006d36680560bb405b4100dc0239611ae64073001eb494192e4700e000e121e70240066610076240c0ae41e400000",
      ),
    ).toEqual({ sellerNonce: "22".repeat(32), agentIdentifier: `${"aa".repeat(28)}01`, buyerNonce: "01020304050607", referenceSignature: "66".repeat(16), referenceKey: "a10102", contractAddress: ESCROW });
  });

  it("rejects garbage", () => {
    expect(() => decodeBlockchainIdentifier("zz")).toThrow(BlockchainIdentifierError);
    expect(() => decodeBlockchainIdentifier("00ff")).toThrow(BlockchainIdentifierError);
  });
});
