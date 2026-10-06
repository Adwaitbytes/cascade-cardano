import { describe, expect, it } from "vitest";
import { decodeMasumiDatum, encodeMasumiDatum } from "../src/codec.js";
import { h, keyAddr } from "./fixtures.js";

// docs/research/x402-cardano-spec.md 4.2.6, verbatim test vector.
const SPEC_VECTOR =
  "d8799fd8799fd8799f581c11111111111111111111111111111111111111111111111111111111ffd87a80ffd87a80d8799fd8799f581c22222222222222222222222222222222222222222222222222222222ffd87a80ffd87a8043a1010150555555555555555555555555555555555820333333333333333333333333333333333333333333333333333333333333333340401a0015e65e58204444444444444444444444444444444444444444444444444444444444444444401b0000019fc75a1f001b0000019fc7910d801b0000019fc7c7fc001b0000019fc7feea800000d87980ff";

const datum = {
    buyer: keyAddr(h("11", 28)),
    buyer_return_address: null,
    seller: keyAddr(h("22", 28)),
    seller_return_address: null,
    reference_key: "a10101",
    reference_signature: h("55", 16),
    seller_nonce: h("33", 32),
    buyer_nonce: "",
    agent_identifier: "",
    collateral_return_lovelace: 1_435_230n,
    input_hash: h("44", 32),
    result_hash: "",
    pay_by_time: 1_785_756_000_000n,
    submit_result_time: 1_785_759_600_000n,
    unlock_time: 1_785_763_200_000n,
    external_dispute_unlock_time: 1_785_766_800_000n,
    seller_cooldown_time: 0n,
    buyer_cooldown_time: 0n,
    state: "FundsLocked" as const,
  };

describe("Masumi vested_pay V2 datum", () => {

  it("encodes the x402 spec CBOR vector byte for byte", () => {
    expect(encodeMasumiDatum(datum)).toBe(SPEC_VECTOR);
  });

  it("decodes the spec vector and round trips return addresses", () => {
    expect(decodeMasumiDatum(SPEC_VECTOR)).toEqual(datum);
    const withReturn = { ...datum, buyer_return_address: keyAddr(h("aa", 28), h("bb", 28)), state: "Disputed" as const };
    expect(decodeMasumiDatum(encodeMasumiDatum(withReturn))).toEqual(withReturn);
  });
});

describe("Masumi blockchainIdentifier", () => {
  const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
  it("matches both x402 spec vectors and decodes them back", async () => {
    const { decodeMasumiIdentifier, encodeMasumiIdentifier } = await import("../src/masumi-identifier.js");
    const v1 = { sellerNonce: "11".repeat(32), agentIdentifier: "", buyerNonce: "", referenceSignature: "55".repeat(16), referenceKey: "a10101", contractAddress: ESCROW };
    const id1 =
      "230d7c6574f41d1c0acc96ade8eae04360019f607004d8809c07d005c053019cae007700bce8058680d89818c04e44002c035931a2c00daf5e00ac9bf00b6c401b80473c6535d00e6003cb8b110199db615001ca8eecc6019b58076c603b13763a80";
    expect(encodeMasumiIdentifier(v1)).toBe(id1);
    expect(decodeMasumiIdentifier(id1)).toEqual(v1);
    const v2 = { sellerNonce: "22".repeat(32), agentIdentifier: `${"aa".repeat(28)}01`, buyerNonce: "01020304050607", referenceSignature: "66".repeat(16), referenceKey: "a10102", contractAddress: ESCROW };
    const id2 =
      "130d7c6574f4218314e4b56f46e00602300e972d82c0662c0162c0562c0362c0763d6975b7d8f3b6f3874381e004d0402700fa005c0298067093803b802f19e4a6d05018c02715001601ac154a5006d36680560bb405b4100dc0239611ae64073001eb494192e4700e000e121e70240066610076240c0ae41e400000";
    expect(encodeMasumiIdentifier(v2)).toBe(id2);
    expect(decodeMasumiIdentifier(id2)).toEqual(v2);
    expect(decodeMasumiIdentifier("zz")).toBeNull();
  });

  it("rebuilds a lock's identifier from its datum", async () => {
    const { masumiIdentifierFromDatum, decodeMasumiIdentifier } = await import("../src/masumi-identifier.js");
    const id = masumiIdentifierFromDatum({ ...datum, buyer_nonce: "aabbccddeeff", agent_identifier: `${"ab".repeat(28)}01` }, ESCROW);
    expect(decodeMasumiIdentifier(id)).toEqual({ sellerNonce: datum.seller_nonce, agentIdentifier: `${"ab".repeat(28)}01`, buyerNonce: "aabbccddeeff", referenceSignature: datum.reference_signature, referenceKey: datum.reference_key, contractAddress: ESCROW });
  });
});
