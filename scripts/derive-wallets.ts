// Derives every role wallet from CASCADE_TREASURY_MNEMONIC and writes the public
// half (address and key hashes) to deployments/wallets.{preprod,local}.json.
import { writeJson } from "./lib/deployments.js";
import { treasuryMnemonic } from "./lib/env.js";
import { CASCADE_NETWORKS } from "./lib/network.js";
import { deriveAllWallets, walletsFileName } from "./lib/wallets.js";

const mnemonic = treasuryMnemonic();

for (const network of CASCADE_NETWORKS) {
  const wallets = deriveAllWallets(mnemonic, network);
  const file = walletsFileName(network);
  writeJson(file, {
    network,
    derivation: "CIP-1852 m/1852'/1815'/{accountIndex}'/0/0 (payment) and /2/0 (stake), base addresses",
    source: "CASCADE_TREASURY_MNEMONIC",
    wallets,
  });
  console.log(`Wrote deployments/${file} (${wallets.length} wallets)`);
}
