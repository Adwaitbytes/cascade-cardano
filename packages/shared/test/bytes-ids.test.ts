import { describe, expect, it } from "vitest";
import { be16, be32, be64, be8, blake2b_224, blake2b_256, bytesToHex, concatBytes, hexToBytes, sha256, utf8 } from "../src/bytes.js";
import { childTokenName, configTokenName, drawChildTokenNames, rootTokenName } from "../src/ids.js";

describe("bytes", () => {
  it("fixed-width big-endian", () => {
    expect(bytesToHex(be8(7))).toBe("07");
    expect(bytesToHex(be16(0x0102))).toBe("0102");
    expect(bytesToHex(be32(1n))).toBe("00000001");
    expect(bytesToHex(be64((1n << 64n) - 1n))).toBe("ffffffffffffffff");
    expect(() => be8(256)).toThrow(RangeError);
    expect(() => be16(-1)).toThrow(RangeError);
    expect(() => be64(1n << 64n)).toThrow(RangeError);
  });

  it("hash functions match known empty-input digests", () => {
    const empty = new Uint8Array(0);
    expect(bytesToHex(blake2b_224(empty))).toBe("836cc68931c2e4e3e838602eca1902591d216837bafddfe6f0c8cb07");
    expect(bytesToHex(blake2b_256(empty))).toBe("0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8");
    expect(bytesToHex(sha256(empty))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(bytesToHex(sha256(utf8("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hex helpers reject malformed input", () => {
    expect(() => hexToBytes("abc")).toThrow();
    expect(() => hexToBytes("zz")).toThrow();
  });
});

describe("token names (ADR 2)", () => {
  const txId = "ab".repeat(32);

  it("root name is blake2b_224(tx_id ++ be16(index))", () => {
    const expected = bytesToHex(blake2b_224(concatBytes(hexToBytes(txId), be16(3))));
    expect(rootTokenName({ transaction_id: txId, output_index: 3n })).toBe(expected);
    expect(rootTokenName({ transaction_id: txId, output_index: 3n })).toHaveLength(56);
    expect(() => rootTokenName({ transaction_id: txId, output_index: 65536n })).toThrow(RangeError);
  });

  it("child name is blake2b_224(parent ++ be32(index)) and unique per index", () => {
    const parent = rootTokenName({ transaction_id: txId, output_index: 0n });
    const expected = bytesToHex(blake2b_224(concatBytes(hexToBytes(parent), be32(256))));
    expect(childTokenName(parent, 256n)).toBe(expected);
    const names = drawChildTokenNames(parent, 2n, 3);
    expect(names).toEqual([childTokenName(parent, 2n), childTokenName(parent, 3n), childTokenName(parent, 4n)]);
    expect(new Set(names).size).toBe(3);
  });

  it("config name is 0x63 ++ tree_id, 29 bytes", () => {
    const treeId = rootTokenName({ transaction_id: txId, output_index: 0n });
    expect(configTokenName(treeId)).toBe(`63${treeId}`);
    expect(configTokenName(treeId)).toHaveLength(58);
    expect(() => configTokenName("63")).toThrow();
  });
});
