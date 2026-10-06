/**
 * Min-UTxO maths (PRD 7.8, CIP-55): `minUTxO = (160 + |serialized_output|) * coinsPerUtxoByte`.
 * `coinsPerUtxoByte` must be read live from protocol parameters; nothing here hardcodes it.
 */
import { utxoToTransactionOutput, type Assets } from "@lucid-evolution/lucid";

export const MIN_UTXO_OVERHEAD_BYTES = 160n;

export function minUtxoFromSize(serializedOutputBytes: number | bigint, coinsPerUtxoByte: bigint): bigint {
  const size = typeof serializedOutputBytes === "number" ? BigInt(serializedOutputBytes) : serializedOutputBytes;
  if (size <= 0n) throw new RangeError("serialized output size must be positive");
  if (coinsPerUtxoByte <= 0n) throw new RangeError("coinsPerUtxoByte must be positive");
  return (MIN_UTXO_OVERHEAD_BYTES + size) * coinsPerUtxoByte;
}

export interface OutputShape {
  /** Bech32 address. */
  address: string;
  /** Lucid units: `lovelace` and `policyId ++ assetNameHex`. */
  assets: Assets;
  /** Inline datum as CBOR hex. */
  datum?: string;
}

const DUMMY_TX = "00".repeat(32);

/** Exact CBOR size of the output as the ledger serializes it, built through CML. */
export function serializedOutputSize(output: OutputShape): number {
  const cml = utxoToTransactionOutput({
    txHash: DUMMY_TX,
    outputIndex: 0,
    address: output.address,
    assets: output.assets,
    datum: output.datum ?? null,
    datumHash: null,
    scriptRef: null,
  });
  try {
    return cml.to_cbor_bytes().length;
  } finally {
    cml.free();
  }
}

/**
 * Smallest lovelace amount this output can carry. The coin's own CBOR width depends on its value,
 * so iterate to the fixed point (at most a few rounds).
 */
export function minUtxoForOutput(output: OutputShape, coinsPerUtxoByte: bigint): bigint {
  let lovelace = 0n;
  for (let round = 0; round < 8; round++) {
    const required = minUtxoFromSize(serializedOutputSize({ ...output, assets: { ...output.assets, lovelace } }), coinsPerUtxoByte);
    if (required <= lovelace) return lovelace;
    lovelace = required;
  }
  throw new Error("min-UTxO did not converge");
}

// Masumi leaf collateral (docs/research/x402-cardano-spec.md 4.2.8), mirroring `@x402/cardano`.

export const MASUMI_MIN_COLLATERAL_LOVELACE = 1_435_230n;
const MASUMI_RESULT_HASH_DELTA = 33n;
const MASUMI_RESULT_HASH_BUFFER = 50n;
const MASUMI_COOLDOWN_BUFFER = 15n;
const MASUMI_SAFETY_MARGIN = 100n;
const MASUMI_PER_TOKEN = 50n;

/** Post-`SubmitResult` min-UTxO of a Masumi lock whose initial datum is `lockDatumBytes` long. */
export function masumiMinUtxoLovelace(lockDatumBytes: number, nativeTokenCount: number, coinsPerUtxoByte: bigint): bigint {
  return (
    coinsPerUtxoByte *
    (BigInt(lockDatumBytes) +
      MASUMI_RESULT_HASH_DELTA +
      MIN_UTXO_OVERHEAD_BYTES +
      MASUMI_RESULT_HASH_BUFFER +
      MASUMI_COOLDOWN_BUFFER +
      MASUMI_SAFETY_MARGIN +
      MASUMI_PER_TOKEN * BigInt(nativeTokenCount))
  );
}

/** `collateral_return_lovelace`: 0, or at least 1,435,230 and enough to clear the post-submit minimum. */
export function masumiCollateralLovelace(requestedLovelace: bigint, minUtxo: bigint): bigint {
  if (requestedLovelace >= minUtxo) return 0n;
  const shortfall = minUtxo - requestedLovelace;
  return shortfall > MASUMI_MIN_COLLATERAL_LOVELACE ? shortfall : MASUMI_MIN_COLLATERAL_LOVELACE;
}
