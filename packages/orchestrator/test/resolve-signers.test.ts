/**
 * A9 run 2: arbiter-1 builds a Resolve through the console with its own wallet and arbiter-2
 * co-signs. resolve-tx listed only the paying wallet in required_signers, so a 2-of-3 tree's Resolve
 * carried one arbiter signature and failed the threshold.
 */
import { describe, expect, it } from "vitest";
import { resolveSigners } from "../src/chain/buyer-tx.js";

const A1 = "a1".repeat(28);
const A2 = "a2".repeat(28);
const A3 = "a3".repeat(28);
const STRANGER = "ff".repeat(28);

describe("resolveSigners", () => {
  it("puts the paying arbiter first and fills the threshold from the other arbiters", () => {
    expect(resolveSigners([A1, A2, A3], 2, A2)).toEqual([A2, A1]);
    expect(resolveSigners([A1, A2, A3], 2, A1)).toEqual([A1, A2]);
    expect(resolveSigners([A1, A2, A3], 3, A3)).toEqual([A3, A1, A2]);
  });

  it("still names threshold arbiters when the payer is not one of them", () => {
    expect(resolveSigners([A1, A2, A3], 2, STRANGER)).toEqual([A1, A2]);
  });

  it("with signer-held keys, takes only arbiters the signer holds", () => {
    const held = new Set([A2, A3]);
    expect(resolveSigners([A1, A2, A3], 2, STRANGER, held)).toEqual([A2, A3]);
  });

  it("refuses a threshold the available arbiters cannot meet", () => {
    expect(() => resolveSigners([A1, A2, A3], 2, STRANGER, new Set([A3]))).toThrow(/1 of the 2 arbiter keys/);
    expect(() => resolveSigners([A1], 2, A1)).toThrow(/1 of the 2 arbiter keys/);
  });
});
