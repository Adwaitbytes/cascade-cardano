/**
 * Minimal chain access for the agent-key path: read the agent wallet's UTxOs (to build its
 * wallet context) and submit a transaction the signer service has signed. Uses a
 * Blockfrost-compatible API: Yaci Store locally, Blockfrost on preprod.
 */
import { Blockfrost, utxoToCore } from "@lucid-evolution/lucid";
import { ConfigError, type CascadeNetwork, type WalletContext } from "./client.js";

export interface ChainAccess {
  walletContext(address: string): Promise<WalletContext>;
  submit(signedTxCbor: string): Promise<string>;
}

const LOCAL_BLOCKFROST = "http://localhost:28080/api/v1";
const PREPROD_BLOCKFROST = "https://cardano-preprod.blockfrost.io/api/v0";

/** Reads CASCADE_BLOCKFROST_URL (optional) and, on preprod, BLOCKFROST_PROJECT_ID_PREPROD. */
export function chainFromEnv(network: CascadeNetwork, env: NodeJS.ProcessEnv = process.env): ChainAccess {
  const url = env.CASCADE_BLOCKFROST_URL?.trim() || (network === "local" ? LOCAL_BLOCKFROST : PREPROD_BLOCKFROST);
  let projectId = "yaci";
  if (network === "preprod") {
    const id = env.BLOCKFROST_PROJECT_ID_PREPROD?.trim();
    if (id === undefined || id === "") throw new ConfigError("BLOCKFROST_PROJECT_ID_PREPROD is required to sign with an agent key on preprod");
    if (!id.startsWith("preprod")) throw new ConfigError("BLOCKFROST_PROJECT_ID_PREPROD must be a preprod project id");
    projectId = id;
  }
  const provider = new Blockfrost(url, projectId);
  return {
    async walletContext(address) {
      const utxos = await provider.getUtxos(address);
      if (utxos.length === 0) throw new Error(`agent wallet ${address} holds no UTxOs`);
      return { change_address: address, utxos: utxos.map((u) => utxoToCore(u).to_cbor_hex()) };
    },
    submit: (signedTxCbor) => provider.submitTx(signedTxCbor),
  };
}
