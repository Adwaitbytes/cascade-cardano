import { describe, expect, it } from "vitest";
import { getTx, getTxFrom, paidTo, tipHeight, waitForTx } from "./chain.js";
import { optionalEnv } from "./repo.js";

// Real preprod reads, no mocks: the faucet transaction that funded the treasury (BLOCKERS.md B1).
const FAUCET_TX = "99b6e524e77c7a6b45bc827cf63fa1b9b8cdd8ab3c48cc2423cf19f8437ff2b3";
const TREASURY = "addr_test1qqcqa99kakye65dlf46fuuqe9klfjx49356ll3ptq93psddm96ck0jea0e5wleqm8afe6j9eu89yp7xr26gxg4pdurhsnamdsz";
const hasBlockfrost = optionalEnv("BLOCKFROST_PROJECT_ID_PREPROD") !== undefined;

describe("preprod chain reads", () => {
  it("finds the faucet transaction and its 10,000 tADA output", async () => {
    const tx = await waitForTx(FAUCET_TX, { timeoutMs: 60_000 });
    expect(tx.hash).toBe(FAUCET_TX);
    expect(paidTo(tx, TREASURY)).toBe(10_000_000_000n);
  });

  it("returns null for a transaction that does not exist", async () => {
    expect(await getTx("0".repeat(64))).toBeNull();
  });

  it("rejects a malformed hash before any network call", async () => {
    await expect(getTx("not-a-hash")).rejects.toThrow(/not a transaction hash/);
  });

  it("reports a tip above the faucet block", async () => {
    const tx = await waitForTx(FAUCET_TX, { timeoutMs: 60_000 });
    expect(await tipHeight()).toBeGreaterThan(tx.blockHeight);
  });

  it("gets the same block, fee and outputs from Blockfrost and Koios", async () => {
    expect(hasBlockfrost, "BLOCKFROST_PROJECT_ID_PREPROD must be set for the cross-check").toBe(true);
    const [bf, koios] = await Promise.all([getTxFrom("blockfrost", FAUCET_TX), getTxFrom("koios", FAUCET_TX)]);
    expect(bf?.validContract).toBe(true);
    const comparable = (t: typeof bf) => t && { ...t, provider: undefined, validContract: undefined };
    expect(comparable(bf)).toEqual(comparable(koios));
  });
});
