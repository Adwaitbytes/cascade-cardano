import { describe, expect, it } from "vitest";
import { HttpTxSigner } from "@cascade/orchestrator";
import { generateSeedPhrase, walletFromSeed } from "@lucid-evolution/lucid";
import { jcsSha256, verifyCose1 } from "@cascade/shared/browser";
import { AGENT_NOT_INDEXED_RETRY, cascadeNetworkFromEnv, masumiOffersSupported, derivedRoleSigner, loadEnv, runtimeFor, subtreeTaskQueue, UnregisteredAgentError, x402NetworkFromEnv, AGENT_ROLES } from "../src/index.js";

describe("agent kit", () => {
  it("offers Masumi vested_pay quotes only where @x402/cardano and Masumi run (never on the Yaci devnet)", () => {
    expect(masumiOffersSupported("cardano:local")).toBe(false);
    expect(masumiOffersSupported("cardano:preprod")).toBe(true);
  });

  it("signs with the CIP-1852 key of the role's account and verifies against its base address", async () => {
    const mnemonic = generateSeedPhrase();
    const signer = derivedRoleSigner(mnemonic, AGENT_ROLES.scout.accountIndex);
    expect(signer.address).toBe(walletFromSeed(mnemonic, { addressType: "Base", accountIndex: 3, network: "Preprod" }).address);
    const payload = jcsSha256({ quote: 1 });
    const check = verifyCose1({ signature: await signer.signHash(payload), key: signer.coseKey }, { payload, address: signer.address });
    expect(check.ok).toBe(true);
  });

  it("refuses to start an unregistered agent unless explicitly allowed, and labels the placeholder", () => {
    loadEnv(); // load the repo .env first, so the deletes below are not undone by a later load
    delete process.env["CASCADE_AGENT_ID_SCOUT"];
    delete process.env["CASCADE_ALLOW_UNREGISTERED"];
    expect(() => runtimeFor("scout")).toThrow(UnregisteredAgentError);
    process.env["CASCADE_ALLOW_UNREGISTERED"] = "1";
    const rt = runtimeFor("scout");
    expect(rt.registered).toBe(false);
    expect(Buffer.from(rt.registryAsset.slice(56), "hex").toString()).toBe("unregistered-scout");
    expect(rt.port).toBe(24002);
  });

  // Regression: runtimeFor read CARDANO_NETWORK (preprod in the repo .env), so a local agent without
  // chain wiring offered `cardano:preprod` requirements to the `cardano:local` facilitator.
  it("derives the x402 network from CASCADE_NETWORK alone, never from CARDANO_NETWORK", () => {
    loadEnv();
    const saved = { cascade: process.env["CASCADE_NETWORK"], cardano: process.env["CARDANO_NETWORK"], allow: process.env["CASCADE_ALLOW_UNREGISTERED"] };
    const restore = (name: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    try {
      process.env["CASCADE_ALLOW_UNREGISTERED"] = "1";
      for (const cardano of ["preprod", "preview", undefined]) {
        restore("CARDANO_NETWORK", cardano);
        process.env["CASCADE_NETWORK"] = "local";
        expect(x402NetworkFromEnv()).toBe("cardano:local");
        for (const role of Object.keys(AGENT_ROLES) as (keyof typeof AGENT_ROLES)[]) expect(runtimeFor(role).network).toBe("cardano:local");
        delete process.env["CASCADE_NETWORK"];
        expect(runtimeFor("scout").network).toBe("cardano:local");
        process.env["CASCADE_NETWORK"] = "preprod";
        expect(runtimeFor("scout").network).toBe("cardano:preprod");
      }
      process.env["CASCADE_NETWORK"] = "mainnet";
      expect(() => cascadeNetworkFromEnv()).toThrow(/local or preprod/);
    } finally {
      restore("CASCADE_NETWORK", saved.cascade);
      restore("CARDANO_NETWORK", saved.cardano);
      restore("CASCADE_ALLOW_UNREGISTERED", saved.allow);
    }
  });

  // Regression: the local stack and the preprod agents share one Temporal namespace; the devnet Scout
  // polled `cascade-scout` too and failed a preprod tree's hire ("no plan is loaded for tree ...").
  it("puts each network's sub-hiring worker on its own Temporal task queue", () => {
    expect(subtreeTaskQueue("scout", "local")).not.toBe(subtreeTaskQueue("scout", "preprod"));
    expect(subtreeTaskQueue("scout", "preprod")).not.toBe(subtreeTaskQueue("pricer", "preprod"));
  });
});

describe("agent signer retry budget", () => {
  it("keeps asking through the 3 min 40 s indexer lag that refunded Pricer on preprod tree 1a9584a2", async () => {
    let clock = 0;
    const indexedAt = 220_000;
    const fetchImpl = (async () =>
      clock < indexedAt
        ? new Response(JSON.stringify({ decision: "deny", code: "input_not_indexed", tx_body_hash: "5fe8", error: "input_not_indexed: input bbc4#1 is not indexed yet" }), { status: 409 })
        : new Response(JSON.stringify({ decision: "allow", signed_tx: "signed" }), { status: 200 })) as typeof fetch;
    const retry = { ...AGENT_NOT_INDEXED_RETRY, now: () => clock, sleep: async (ms: number) => void (clock += ms) };
    await expect(new HttpTxSigner("http://signer.test", null, fetchImpl, retry).sign("pricer", "00")).resolves.toBe("signed");
    expect(clock).toBeGreaterThanOrEqual(indexedAt);
  });
});
