/**
 * CIP-68 snapshot anchor on the real Yaci chain: the first snapshot mints the reference NFT under
 * the oracle's native-script policy, the second spends and re-creates it with the new root.
 */
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { deriveRoleKey, loadNetworkConfig, resolveSlotConfig } from "@cascade/service-kit";
import { describe, expect, it } from "vitest";
import { anchorWithLucid, anchoredRoot, oracleAnchor } from "../src/anchor.js";

const YACI = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const ACCOUNT = 15;

describe("CIP-68 reputation anchor", () => {
  it("mints once, then updates the single reference NFT with each new root", async () => {
    const cfg = loadNetworkConfig("local");
    const lucid = await Lucid(new Blockfrost(cfg.blockfrostUrl ?? "", "yaci"), "Custom", { slotConfig: await resolveSlotConfig(cfg) });
    lucid.selectWallet.fromSeed(YACI, { addressType: "Base", accountIndex: ACCOUNT });
    const oracle = deriveRoleKey(YACI, ACCOUNT, "local");
    const { unit, policyId } = oracleAnchor(oracle.paymentKeyHash);
    expect(unit.slice(56, 64)).toBe("000643b0");
    const address = await lucid.wallet().address();
    const before = await lucid.utxosAtWithUnit(address, unit);

    const rootA = "a1".repeat(32);
    const first = await anchorWithLucid(lucid, oracle.paymentKeyHash, { snapshot_root: rootA, created_at: 1, entries: [1, 2] });
    expect(first.minted).toBe(before.length === 0);
    expect(await lucid.awaitTx(first.txId, 1_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 2_500));

    const rootB = "b2".repeat(32);
    const second = await anchorWithLucid(lucid, oracle.paymentKeyHash, { snapshot_root: rootB, created_at: 2, entries: [1, 2, 3] });
    expect(second.minted).toBe(false);
    expect(await lucid.awaitTx(second.txId, 1_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 2_500));

    const now = await lucid.utxosAtWithUnit(address, unit);
    expect(now).toHaveLength(1);
    expect(now[0]?.txHash).toBe(second.txId);
    expect(anchoredRoot(now[0]?.datum ?? "")).toEqual({ root: rootB, createdAt: 2n, entries: 3n });
    expect(policyId).toMatch(/^[0-9a-f]{56}$/);
  });
});
