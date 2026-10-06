// Creates a fresh preprod-only treasury mnemonic when none exists.
// The mnemonic is written to the git-ignored .env file and never printed.
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateSeedPhrase, walletFromSeed } from "@lucid-evolution/lucid";

const root = resolve(import.meta.dirname, "..");
const envPath = resolve(root, ".env");

const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const hasMnemonic = /^CASCADE_TREASURY_MNEMONIC=\S+/m.test(envText) || Boolean(process.env.CASCADE_TREASURY_MNEMONIC);

let mnemonic: string;
if (hasMnemonic) {
  mnemonic = process.env.CASCADE_TREASURY_MNEMONIC ?? /^CASCADE_TREASURY_MNEMONIC=(.+)$/m.exec(envText)![1]!.trim();
  console.log("Treasury mnemonic already present; not generating a new one.");
} else {
  mnemonic = generateSeedPhrase();
  const line = `CASCADE_TREASURY_MNEMONIC=${mnemonic}\n`;
  if (envText === "") writeFileSync(envPath, `CARDANO_NETWORK=preprod\n${line}`, { mode: 0o600 });
  else appendFileSync(envPath, (envText.endsWith("\n") ? "" : "\n") + line);
  console.log("Generated a new preprod treasury mnemonic and stored it in .env.");
}

const wallet = walletFromSeed(mnemonic, { network: "Preprod", addressType: "Base", accountIndex: 0 });
console.log(`Treasury address (preprod): ${wallet.address}`);
