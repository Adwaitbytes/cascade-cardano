/**
 * Tops up the coworker-buyer wallet from the preprod treasury (account 0) to its target, in one
 * transaction. Idempotent: a wallet at or above 90% of the target is left alone. Prints the tx hash.
 *
 * Usage: npx tsx agents/cascade-coworker/scripts/fund-buyer.ts [targetAda=300]
 * Env (from .env, read in code): CASCADE_TREASURY_MNEMONIC.
 */
import { openLucid } from "@cascade/orchestrator";
import { buyerWallet, requiredEnv, selectAccount } from "../src/wallet.js";

const LOVELACE_PER_ADA = 1_000_000n;
const target = BigInt(process.argv[2] ?? "300") * LOVELACE_PER_ADA;
const mnemonic = requiredEnv("CASCADE_TREASURY_MNEMONIC");
const buyer = buyerWallet(mnemonic);
const lucid = await openLucid("preprod");
selectAccount(lucid, mnemonic, 0);

const balance = (await lucid.utxosAt(buyer.address)).reduce((sum, u) => sum + (u.assets["lovelace"] ?? 0n), 0n);
if (balance * 10n >= target * 9n) {
  process.stdout.write(`coworker-buyer ${buyer.address} holds ${balance} lovelace; nothing to do\n`);
} else {
  const tx = await lucid.newTx().pay.ToAddress(buyer.address, { lovelace: target - balance }).complete();
  const hash = await (await tx.sign.withWallet().complete()).submit();
  await lucid.awaitTx(hash, 5_000);
  process.stdout.write(`funded coworker-buyer ${buyer.address} with ${target - balance} lovelace: https://preprod.cardanoscan.io/transaction/${hash}\n`);
}
