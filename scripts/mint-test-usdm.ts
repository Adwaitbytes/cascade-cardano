// Mints a tUSDM-equivalent test token (6 decimals) on the local Yaci devnet under a
// native-script policy owned by the treasury key, and sends 100,000.000000 tUSDM to
// the buyer. Idempotent: mints only the shortfall. Records the token in the git-ignored
// deployments/local.runtime.json.
// Preprod has no real tUSDM for Cascade (PREPROD_TUSDM_AVAILABLE=false), so this is local only.
import { fromText, mintingPolicyToId, scriptFromNative, toUnit, type LucidEvolution } from "@lucid-evolution/lucid";
import type { TestToken } from "./lib/deployments.js";
import { updateLocalRuntime } from "./lib/local-runtime.js";
import { treasuryMnemonic } from "./lib/env.js";
import { explorerTxUrl, makeLucid, networkFromArgv } from "./lib/network.js";
import { deriveWallet, selectRoleWallet } from "./lib/wallets.js";

const TICKER = "tUSDM";
const DECIMALS = 6;
const BUYER_TARGET_UNITS = 100_000n * 10n ** BigInt(DECIMALS);
/** Carries the token output above min-UTxO. */
const TOKEN_OUTPUT_LOVELACE = 2_000_000n;

async function unitsAt(lucid: LucidEvolution, address: string, unit: string): Promise<bigint> {
  const utxos = await lucid.utxosAt(address);
  return utxos.reduce((sum, u) => sum + (u.assets[unit] ?? 0n), 0n);
}

async function main(): Promise<void> {
  const network = networkFromArgv();
  if (network !== "local") {
    throw new Error("mint-test-usdm runs on --network local only; preprod trees use lovelace (PREPROD_TUSDM_AVAILABLE=false)");
  }
  const mnemonic = treasuryMnemonic();
  const treasury = deriveWallet(mnemonic, "treasury", "local");
  const buyer = deriveWallet(mnemonic, "buyer", "local");

  const policy = scriptFromNative({ type: "sig", keyHash: treasury.paymentKeyHash });
  const policyId = mintingPolicyToId(policy);
  const assetNameHex = fromText(TICKER);
  const unit = toUnit(policyId, assetNameHex);

  const { lucid } = await makeLucid("local");
  const held = await unitsAt(lucid, buyer.address, unit);

  if (held >= BUYER_TARGET_UNITS) {
    console.log(`Buyer already holds ${held} base units of ${TICKER}. Nothing to mint.`);
  } else {
    const amount = BUYER_TARGET_UNITS - held;
    selectRoleWallet(lucid, mnemonic, "treasury");
    const tx = await lucid
      .newTx()
      .mintAssets({ [unit]: amount })
      .attach.MintingPolicy(policy)
      .pay.ToAddress(buyer.address, { lovelace: TOKEN_OUTPUT_LOVELACE, [unit]: amount })
      .complete();
    const signed = await tx.sign.withWallet().complete();
    const mintTxHash = await signed.submit();
    console.log(`Submitted mint tx ${mintTxHash}; waiting for confirmation...`);
    await lucid.awaitTx(mintTxHash, 1000);
    const after = await unitsAt(lucid, buyer.address, unit);
    if (after < BUYER_TARGET_UNITS) throw new Error(`Buyer holds ${after} base units after mint, expected ${BUYER_TARGET_UNITS}`);
    console.log(`Minted ${amount} base units to the buyer. ${explorerTxUrl("local", mintTxHash)}`);
  }

  const testToken: TestToken = {
    ticker: TICKER,
    decimals: DECIMALS,
    policyId,
    assetName: TICKER,
    assetNameHex,
    unit,
    policyScript: policy.script,
    mintedTo: buyer.address,
  };
  await updateLocalRuntime({ testToken });
  console.log(`Recorded ${TICKER} policy ${policyId} in deployments/local.runtime.json`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
