import { describe, expect, it } from "vitest";
import { agentIdFor, loadEnv, referenceDirectory, walletAddressOf } from "../src/index.js";

describe("reference directory", () => {
  it("resolves Lisan on the Yaci devnet, which runs no Masumi payment service, to the lisan role wallet", async () => {
    loadEnv();
    process.env["CASCADE_ALLOW_UNREGISTERED"] = "1";
    const lisan = await referenceDirectory("local").resolve(agentIdFor("lisan").id);
    expect(lisan.payment_address).toBe(walletAddressOf("local")("lisan"));
    expect(lisan.masumi_price_lovelace).toMatch(/^[1-9]\d*$/);
  });

  it("resolves Lisan on preprod to the Masumi payment service's V2 selling wallet", async () => {
    loadEnv();
    process.env["CASCADE_ALLOW_UNREGISTERED"] = "1";
    const lisan = await referenceDirectory("preprod").resolve(agentIdFor("lisan").id);
    expect(lisan.payment_address).not.toBe(walletAddressOf("preprod")("lisan"));
    expect(lisan.payment_address).toMatch(/^addr_test1/);
  });
});
