/**
 * A6 on preprod (opt-in: CASCADE_PREPROD_A6=1). A plain x402 client with its own wallet (the buyer
 * role, account 1) and no Cascade tree buys a job from a Cascade agent's `/jobs` through the
 * `masumi` method. The agent offers both `script` and `masumi`; the Cascade facilitator
 * (CASCADE_FACILITATOR_URL, default http://localhost:26200) verifies and settles; the agent starts
 * the job and returns job_id and PAYMENT-RESPONSE. The lock is asserted on chain via Blockfrost.
 *
 * The agent is CASCADE_A6_AGENT_URL when set (a deployed Cascade agent); otherwise this suite starts
 * a minimal `@cascade/agent` in process with a fresh seller key.
 */
import { readFileSync } from "node:fs";
import type { ServerType } from "@hono/node-server";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Blockfrost, Lucid, walletFromSeed, type LucidEvolution } from "@lucid-evolution/lucid";
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cascadeAgent, HttpFacilitatorVerifier, inputHash, localKeySigner, type CascadeAgent } from "@cascade/agent";
import { decodeMasumiDatum, paymentKeyHash, plutusAddressToBech32 } from "@cascade/shared";
import { sellerFromAgentSigner, withMasumiOffers } from "../../src/agent.js";
import { buyJobWithMasumi } from "../../src/demo/plain-client.js";

const repo = new URL("../../../../", import.meta.url);
loadEnv({ path: new URL(".env", repo).pathname, quiet: true });
const enabled = process.env["CASCADE_PREPROD_A6"] === "1";
const BLOCKFROST = "https://cardano-preprod.blockfrost.io/api/v0";
const FACILITATOR = process.env["CASCADE_FACILITATOR_URL"] ?? "http://localhost:26200";
const PRICE = 3_000_000n;

async function blockfrost<T>(path: string): Promise<T> {
  const res = await fetch(`${BLOCKFROST}${path}`, { headers: { project_id: process.env["BLOCKFROST_PROJECT_ID_PREPROD"] ?? "" } });
  if (!res.ok) throw new Error(`blockfrost ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

let lucid: LucidEvolution;
let agent: CascadeAgent | null = null;
let server: ServerType | null = null;
let agentUrl: string;

describe.runIf(enabled)("A6: a plain x402 client pays a Cascade agent through masumi on preprod", () => {
  beforeAll(async () => {
    const mnemonic = process.env["CASCADE_TREASURY_MNEMONIC"];
    const projectId = process.env["BLOCKFROST_PROJECT_ID_PREPROD"];
    if (mnemonic === undefined || projectId === undefined) throw new Error("CASCADE_TREASURY_MNEMONIC and BLOCKFROST_PROJECT_ID_PREPROD are required");
    lucid = await Lucid(new Blockfrost(BLOCKFROST, projectId), "Preprod");
    lucid.selectWallet.fromSeed(mnemonic, { addressType: "Base", accountIndex: 1 });
    const external = process.env["CASCADE_A6_AGENT_URL"];
    if (external !== undefined) {
      agentUrl = external.replace(/\/$/, "");
      return;
    }
    const signer = localKeySigner(ed25519.utils.randomSecretKey());
    agent = cascadeAgent({
      name: "A6 Echo Agent",
      description: "Echoes a topic; used to prove a plain x402 masumi purchase.",
      baseUrl: "http://127.0.0.1:0",
      registryAsset: "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b00",
      network: "cardano:preprod",
      inputSchema: { input_data: [{ id: "topic", type: "string", name: "Topic" }] },
      outputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
      handler: async (input) => ({ result: { summary: `About ${String(input["topic"])}` } }),
      pricing: { asset: "lovelace", amount: PRICE.toString(), etaMs: 60_000 },
      rails: ["masumi"],
      capabilities: { roles: ["specialist"], categories: ["research"], maxDepth: 0, bondLovelace: "0" },
      signer,
      payments: {
        requirements: withMasumiOffers(null, { network: "cardano:preprod", seller: sellerFromAgentSigner(signer), confirmations: 1 }),
        verifier: new HttpFacilitatorVerifier(FACILITATOR),
      },
      notice: "test agent for A6",
      onError: (where, error) => process.stderr.write(`agent error in ${where}: ${error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error)}\n`),
    });
    const port = 4800 + Math.floor(Math.random() * 400);
    server = agent.listen(port, "127.0.0.1");
    agentUrl = `http://127.0.0.1:${port}`;
  }, 120_000);

  afterAll(() => {
    server?.close();
    agent?.close();
  });

  it("locks into vested_pay, settles through the facilitator and starts the job", async () => {
    const identifier = `a6-${Date.now()}`;
    // The in-process echo agent takes `topic`; deployed Cascade agents (Scribe) take `goal`.
    const input = agent === null ? { goal: "Summarise in two sentences how Cascade escrow trees pay sub-agents on Cardano." } : { topic: "cardano escrow trees" };
    const purchase = await buyJobWithMasumi({
      lucid,
      jobsUrl: `${agentUrl}/jobs`,
      network: "cardano:preprod",
      identifierFromPurchaser: identifier,
      inputData: input,
      inputHash: inputHash(identifier, input),
    });
    expect(purchase.settlement?.success).toBe(true);
    expect(purchase.settlement?.transaction).toBe(purchase.lockTx);

    // The lock on chain: Masumi's preprod escrow, FundsLocked, the buyer's key, exact lovelace.
    const utxos = await blockfrost<{ outputs: { address: string; output_index: number; inline_datum: string | null; amount: { unit: string; quantity: string }[] }[] }>(`/txs/${purchase.lockTx}/utxos`);
    const escrow = utxos.outputs.find((o) => o.address === purchase.accepted.payTo);
    expect(escrow?.output_index).toBe(purchase.lockOutputIndex);
    const datum = decodeMasumiDatum(escrow?.inline_datum ?? "");
    expect(datum.state).toBe("FundsLocked");
    expect(datum.result_hash).toBe("");
    expect(datum.buyer.payment_credential).toEqual({ type: "VerificationKey", hash: paymentKeyHash(await lucid.wallet().address()) });
    const lovelace = BigInt(escrow?.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0");
    expect(lovelace).toBe(BigInt(purchase.accepted.amount) + datum.collateral_return_lovelace);

    // The job runs (and, for the in-process echo agent, completes).
    let status = "";
    for (let i = 0; i < 60 && status !== "completed"; i++) {
      const res = await fetch(`${agentUrl}/status?job_id=${purchase.jobId}`);
      status = ((await res.json()) as { status: string }).status;
      if (status === "failed") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(["running", "completed"]).toContain(status);
    process.stdout.write(
      `A6 job ${purchase.jobId} ${status}\nlock https://preprod.cardanoscan.io/transaction/${purchase.lockTx}\nseller ${plutusAddressToBech32(datum.seller, 0)}\n`,
    );
  }, 900_000);
});
