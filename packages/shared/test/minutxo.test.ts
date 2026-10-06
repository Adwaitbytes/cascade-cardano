import { calculateMinLovelaceFromUTxO } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";
import { plutusAddressToBech32 } from "../src/address.js";
import { encodeNodeDatum } from "../src/codec.js";
import { masumiCollateralLovelace, masumiMinUtxoLovelace, minUtxoForOutput, minUtxoFromSize, serializedOutputSize } from "../src/minutxo.js";
import { NODE_HASH, rootNode, TUSDM } from "./fixtures.js";

const COINS_PER_BYTE = 4310n;

describe("min-UTxO (PRD 7.8)", () => {
  it("applies (160 + size) * coinsPerUtxoByte", () => {
    expect(minUtxoFromSize(67, COINS_PER_BYTE)).toBe(978_370n);
  });

  it("sizes a real node output through CML and matches Lucid's own minimum", () => {
    const address = plutusAddressToBech32({ payment_credential: { type: "Script", hash: NODE_HASH }, stake_credential: { type: "Inline", credential: { type: "Script", hash: NODE_HASH } } }, 0);
    const output = {
      address,
      assets: { [TUSDM.policy + TUSDM.name]: 25_000_000n, [NODE_HASH + rootNode.node_id]: 1n },
      datum: encodeNodeDatum(rootNode),
    };
    const size = serializedOutputSize({ ...output, assets: { ...output.assets, lovelace: 5_000_000n } });
    expect(size).toBeGreaterThan(300);
    const ours = minUtxoForOutput(output, COINS_PER_BYTE);
    const lucid = calculateMinLovelaceFromUTxO(COINS_PER_BYTE, { txHash: "00".repeat(32), outputIndex: 0, ...output, assets: { ...output.assets, lovelace: 0n } });
    expect(ours).toBe(lucid);
    expect(ours).toBe(minUtxoFromSize(serializedOutputSize({ ...output, assets: { ...output.assets, lovelace: ours } }), COINS_PER_BYTE));
  });

  it("Masumi collateral is 0 or at least 1,435,230", () => {
    const min = masumiMinUtxoLovelace(450, 1, COINS_PER_BYTE);
    expect(min).toBe(COINS_PER_BYTE * (450n + 33n + 160n + 50n + 15n + 100n + 50n));
    expect(masumiCollateralLovelace(0n, min)).toBe(min);
    expect(masumiCollateralLovelace(min - 1n, min)).toBe(1_435_230n);
    expect(masumiCollateralLovelace(min, min)).toBe(0n);
  });
});
