/**
 * Buy side on the local Yaci devnet: a seller serves 402 with an x402 `default` requirement; the
 * buyer pays it from a Cascade tree with an AddressPayment Draw (real validators) and retries. The
 * seller verifies and settles through the real Cascade facilitator service (services/facilitator,
 * network `cardano:local`), started as its own process for this suite.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { CML, Kupmios, Lucid, generatePrivateKey, type LucidEvolution } from "@lucid-evolution/lucid";
import { HTTPFacilitatorClient } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptanceHash,
  blake2b_224,
  bytesToHex,
  merkleProof,
  merkleRoot,
  plutusAddressToBech32,
  sha256,
  utf8,
  ZERO_HASH,
  ZERO_PAYEE_HASH,
  type PlanLeaf,
  type PlutusAddress,
} from "@cascade/shared";
import { CascadeClient, confirm, deployReferenceScripts, loadCascadeScripts, loadReferenceScripts, refsFromLocalRuntime, registerLogicCredentials } from "@cascade/sdk";
import { fetchWithTreePayment } from "../../src/buy.js";
import { PaymentGate } from "../../src/sell.js";

const repo = new URL("../../../../", import.meta.url);
const local = JSON.parse(readFileSync(new URL("deployments/local.json", repo), "utf8")) as {
  endpoints: { ogmiosHttp: string; kupo: string; adminDevnetInfo: string; adminTopup: string };
};
const ADA = 1_000_000n;
const h32 = (s: string) => bytesToHex(sha256(utf8(s)));

function party() {
  const privateKey = generatePrivateKey();
  const vkh = bytesToHex(blake2b_224(CML.PrivateKey.from_bech32(privateKey).to_public().to_raw_bytes()));
  const plutus: PlutusAddress = { payment_credential: { type: "VerificationKey", hash: vkh }, stake_credential: null };
  return { privateKey, vkh, plutus, address: plutusAddressToBech32(plutus, 0) };
}

async function lucidFor(privateKey: string): Promise<LucidEvolution> {
  const info = (await (await fetch(local.endpoints.adminDevnetInfo)).json()) as { startTime: number };
  const lucid = await Lucid(new Kupmios(local.endpoints.kupo, local.endpoints.ogmiosHttp), "Custom", {
    slotConfig: { zeroTime: info.startTime * 1000, zeroSlot: 0, slotLength: 1000 },
  });
  lucid.selectWallet.fromPrivateKey(privateKey);
  return lucid;
}

const facilitatorPort = 4300 + Math.floor(Math.random() * 500);
let facilitatorProcess: ChildProcess;

/** Start the real facilitator (built dist) and wait until it answers /supported. */
async function startFacilitator(): Promise<string> {
  const entry = fileURLToPath(new URL("services/facilitator/dist/main.js", repo));
  facilitatorProcess = spawn(process.execPath, [entry], {
    cwd: fileURLToPath(repo),
    env: { ...process.env, CASCADE_NETWORK: "local", FACILITATOR_PORT: String(facilitatorPort), FACILITATOR_CONFIRMATION_WAIT_MS: "20000" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  facilitatorProcess.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const url = `http://127.0.0.1:${facilitatorPort}`;
  for (let i = 0; i < 60; i++) {
    if (facilitatorProcess.exitCode !== null) throw new Error(`facilitator exited: ${stderr}`);
    try {
      const res = await fetch(`${url}/supported`);
      if (res.ok) return url;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`facilitator did not start: ${stderr}`);
}

let server: Server;
let url: string;
let client: CascadeClient;
const buyer = party();
const operator = party();
const seller = party();

beforeAll(async () => {
  await fetch(local.endpoints.adminTopup, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: buyer.address, adaAmount: 2000 }) });
  await new Promise((r) => setTimeout(r, 3000));
  const lucid = await lucidFor(buyer.privateKey);
  const scripts = loadCascadeScripts(JSON.parse(readFileSync(new URL("contracts/plutus.json", repo), "utf8")));
  const info = (await (await fetch(local.endpoints.adminDevnetInfo)).json()) as { startTime: number };
  const runtimeUrl = new URL("deployments/local.runtime.json", repo);
  const recorded = existsSync(runtimeUrl) ? refsFromLocalRuntime(JSON.parse(readFileSync(runtimeUrl, "utf8")), scripts, info.startTime) : null;
  const refs = await loadReferenceScripts(lucid, recorded ?? (await deployReferenceScripts(lucid, scripts)));
  await registerLogicCredentials(lucid, scripts, refs);
  client = new CascadeClient(lucid, scripts, refs);

  const offer: PaymentRequirements = {
    scheme: "exact",
    network: "cardano:local",
    asset: "lovelace",
    amount: (2n * ADA).toString(),
    payTo: seller.address,
    maxTimeoutSeconds: 120,
    extra: { confirmationPolicy: { l1Confirmations: 0 } },
  };
  const facilitator = new HTTPFacilitatorClient({ url: await startFacilitator() });
  const gate = new PaymentGate({ resource: { url: "http://local/jobs", description: "a paid job", mimeType: "application/json" }, facilitator });
  server = createServer((req, res) => {
    void (async () => {
      const header = req.headers["payment-signature"];
      if (typeof header !== "string") {
        const r = await gate.paymentRequired([offer]);
        res.writeHead(402, r.headers).end(JSON.stringify(r.body));
        return;
      }
      const verified = await gate.verifyPayment(header);
      if (!verified.ok) {
        res.writeHead(verified.status).end(JSON.stringify({ error: verified.reason }));
        return;
      }
      const { headers } = await verified.settle();
      res.writeHead(200, { ...headers, "content-type": "application/json" }).end(JSON.stringify({ job_id: "job-1" }));
    })().catch((e: unknown) => res.writeHead(500).end(String(e)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  url = `http://127.0.0.1:${address.port}/jobs`;
}, 600_000);

afterAll(() => {
  server?.close();
  facilitatorProcess?.kill("SIGTERM");
});

describe("x402 default method paid from a tree", () => {
  it("pays the seller through an AddressPayment Draw and gets the resource", async () => {
    const rootSpec = h32("x402-root");
    const leaves: PlanLeaf[] = [
      { spec_hash: rootSpec, parent_spec_hash: ZERO_HASH, kind: "Native", max_budget: 50n * ADA, max_fee: 5n * ADA, payee_hash: ZERO_PAYEE_HASH, acceptance_hash: acceptanceHash({ type: "BuyerAccept", key: buyer.vkh }) },
      { spec_hash: h32("x402-api"), parent_spec_hash: rootSpec, kind: "AddressPayment", max_budget: 3n * ADA, max_fee: 0n, payee_hash: seller.vkh, acceptance_hash: acceptanceHash({ type: "AutoAfterWindow" }) },
    ];
    const now = BigInt(client.lucid.slotToUnixTime(client.lucid.currentSlot()));
    const funded = await client.fundRoot({
      config: {
        buyer: buyer.vkh,
        buyer_refund: buyer.plutus,
        asset: { policy: "", name: "" },
        arbiters: [buyer.vkh],
        arbiter_threshold: 1n,
        arbiter_fee_address: buyer.plutus,
        max_depth: 2n,
        max_fanout: 4n,
        max_child_share_bps: 5000n,
        min_challenge_window: 20_000n,
        min_safety_margin: 5_000n,
        allowed_leaf_kinds: ["Native", "AddressPayment"],
        masumi_script_hash: "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad",
        channel_script_hash: client.scripts.channelHash,
        plan_root: merkleRoot(leaves),
        protocol_fee_bps: 0n,
        protocol_fee_address: buyer.plutus,
        challenge_bond: 5n * ADA,
        slash_wronged_bps: 7000n,
        min_dispute_window: 10_000n,
      },
      root: {
        operator: operator.vkh,
        payee: operator.plutus,
        budget: 20n * ADA,
        fee: 2n * ADA,
        spec_hash: rootSpec,
        input_hash: h32("in"),
        submit_by: now + 600_000n,
        challenge_until: now + 630_000n,
        refund_after: now + 600_000n,
        dispute_until: now + 660_000n,
      },
    });
    const signed = await funded.tx.sign.withWallet().complete();
    await confirm(client.lucid, await signed.submit());

    const { response, settlement } = await fetchWithTreePayment(url, { method: "POST", body: "{}" }, {
      client,
      parentId: funded.treeId,
      operatorKey: operator.privateKey,
      network: "cardano:local",
      leafFor: (req) => (req.payTo === seller.address ? { leaf: leaves[1] as PlanLeaf, proof: merkleProof(leaves, 1) } : null),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ job_id: "job-1" });
    expect(settlement?.success).toBe(true);
    expect(settlement?.transaction).toMatch(/^[0-9a-f]{64}$/);
    await confirm(client.lucid, settlement?.transaction ?? "");
    const sellerUtxos = await client.lucid.utxosAt(seller.address);
    expect(sellerUtxos.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n)).toBe(2n * ADA);
    const root = await client.node(funded.treeId);
    expect(root.datum.spent).toBe(2n * ADA);
  }, 600_000);
});
