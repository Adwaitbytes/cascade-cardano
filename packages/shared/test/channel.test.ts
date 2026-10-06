import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { be64, blake2b_256, bytesToHex, concatBytes, hexToBytes } from "../src/bytes.js";
import { channelTag, signVoucher, verifyVoucher, voucherMessage } from "../src/channel.js";
import { decodeChannelDatum, decodeChannelRedeemer, encodeChannelDatum, encodeChannelRedeemer } from "../src/codec.js";
import { channelTokenName } from "../src/ids.js";
import { ChannelDatumSchema, ChannelRedeemerSchema } from "../src/schemas.js";
import { h, keyAddr, NODE_HASH, TREE_ID, CHILD_ID, TUSDM } from "./fixtures.js";

describe("channel (ADR 9, 1.4)", () => {
  const sk = ed25519.utils.randomSecretKey();
  const pub = bytesToHex(ed25519.getPublicKey(sk));

  it("token name is 0x6b ++ receipt node id", () => {
    expect(channelTokenName(CHILD_ID)).toBe(`6b${CHILD_ID}`);
    expect(() => channelTokenName("6b")).toThrow();
  });

  it("voucher message is blake2b_256(tree_id ++ node_id) ++ be64(amount)", () => {
    const expected = concatBytes(blake2b_256(concatBytes(hexToBytes(TREE_ID), hexToBytes(CHILD_ID))), be64(1234n));
    expect(bytesToHex(voucherMessage(TREE_ID, CHILD_ID, 1234n))).toBe(bytesToHex(expected));
    expect(channelTag(TREE_ID, CHILD_ID)).toHaveLength(32);
  });

  it("vouchers verify only for the same channel and amount", () => {
    const sig = signVoucher(sk, TREE_ID, CHILD_ID, 500n);
    expect(verifyVoucher(pub, TREE_ID, CHILD_ID, 500n, sig)).toBe(true);
    expect(verifyVoucher(pub, TREE_ID, CHILD_ID, 501n, sig)).toBe(false);
    expect(verifyVoucher(pub, TREE_ID, h("99", 28), 500n, sig)).toBe(false);
    expect(verifyVoucher(pub, TREE_ID, CHILD_ID, 500n, "00")).toBe(false);
  });

  it("datum and redeemer round trip through Plutus Data", () => {
    const datum = {
      authority: NODE_HASH,
      tree_id: TREE_ID,
      node_id: CHILD_ID,
      payer_vkey: pub,
      provider: h("12", 28),
      provider_address: keyAddr(h("12", 28)),
      asset: TUSDM,
      deposit: 5_000_000n,
      redeemed: 1_000_000n,
      timeout: 1_785_763_200_000n,
    };
    expect(ChannelDatumSchema.parse(datum)).toEqual(datum);
    expect(decodeChannelDatum(encodeChannelDatum(datum))).toEqual(datum);
    const redeem = { type: "Redeem" as const, amount: 2_000_000n, signature: signVoucher(sk, TREE_ID, CHILD_ID, 2_000_000n), out: 0n };
    expect(ChannelRedeemerSchema.parse(redeem)).toEqual(redeem);
    expect(decodeChannelRedeemer(encodeChannelRedeemer(redeem))).toEqual(redeem);
    expect(encodeChannelRedeemer({ type: "Close" })).toBe("d87a80");
  });
});
