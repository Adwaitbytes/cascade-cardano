/**
 * Masumi leaves through the purchase wallet P (ADR 0001 8.1) against a throwaway Postgres: a Draw
 * pays P with an AddressPayment, P locks it at the vested_pay script with a plain transaction, the
 * lock moves to RefundRequested, then the refund reaches buyer_return_address. The receipt carries
 * one `masumi` line linking all of it, node detail lists the leaf, and rollback undoes the outcome.
 */
import { encodeMasumiDatum, encodeTreeConfig, type MasumiDatum, type PlutusAddress } from "@cascade/shared";
import { deriveRoleKey, outRef, withTransaction, type ChainTx, type TxOutput } from "@cascade/service-kit";
import { BUYER, CONFIG_HASH, LOGIC_CORE, LOGIC_DRAW, NODE_HASH, TREE_ID, createTestDatabase, rootDatum, scriptAddress, treeConfig, type TestDatabase } from "@cascade/service-kit/testing";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { applyBlockTxs } from "../src/follower.js";
import { masumiLeaves } from "../src/leaves.js";
import { recordPoint, rollbackTo } from "../src/store.js";
import { SCRIPTS, keyOut, nodeOut, tx, walletIn } from "./scenario.js";

const ADA = 1_000_000n;
const P = "52".repeat(28);
const SELLER = "5e".repeat(28);
const MASUMI = "a1".repeat(28);
const key = (k: string): PlutusAddress => ({ payment_credential: { type: "VerificationKey", hash: k }, stake_credential: null });
const oracle = deriveRoleKey("test test test test test test test test test test test test test test test test test test test test test test test sauce", 15, "local");

const lockDatum = (state: MasumiDatum["state"]): string =>
  encodeMasumiDatum({
    buyer: key(P),
    buyer_return_address: key(BUYER),
    seller: key(SELLER),
    seller_return_address: null,
    reference_key: "a10101",
    reference_signature: "55".repeat(16),
    seller_nonce: "33".repeat(32),
    buyer_nonce: "",
    agent_identifier: `${"67".repeat(28)}aa`,
    collateral_return_lovelace: 0n,
    input_hash: "44".repeat(32),
    result_hash: "",
    pay_by_time: 1n,
    submit_result_time: 2n,
    unlock_time: 3n,
    external_dispute_unlock_time: 4n,
    seller_cooldown_time: 0n,
    buyer_cooldown_time: 0n,
    state,
  });
const lockOut = (state: MasumiDatum["state"]): TxOutput => ({ address: scriptAddress(MASUMI), lovelace: 12n * ADA, assets: {}, datum: lockDatum(state), datumHash: null, hasScriptRef: false, size: null });
/** A key-signed transaction from P: no scripts of ours, no redeemers. */
const plain = (n: number, inputs: string[], outputs: TxOutput[]): ChainTx => ({ ...tx(n, inputs, outputs, [], LOGIC_CORE), withdrawals: [], redeemers: [] });

const cfg = treeConfig({ masumi_script_hash: MASUMI });
const root0 = rootDatum({ budget: 100n * ADA, fee: 10n * ADA, structural: 10n * ADA });
const configOut: TxOutput = { address: scriptAddress(CONFIG_HASH), lovelace: 2n * ADA, assets: { [`${NODE_HASH}.63${TREE_ID}`]: 1n }, datum: encodeTreeConfig(cfg), datumHash: null, hasScriptRef: false, size: null };
const fund = tx(1, [walletIn(1)], [nodeOut(root0), configOut], [{ type: "FundRoot", seed: { transaction_id: "f".repeat(64), output_index: 0n }, root_out: 0n, config_out: 1n }], LOGIC_CORE, {
  [`${NODE_HASH}.${TREE_ID}`]: 1n,
  [`${NODE_HASH}.63${TREE_ID}`]: 1n,
});
const drawIn = [outRef(fund.id, 0), walletIn(2)].sort();
const draw = tx(
  2,
  drawIn,
  [nodeOut({ ...root0, spent: 12n * ADA }), keyOut(P, 12n * ADA)],
  [
    {
      type: "Draw",
      node_in: BigInt(drawIn.indexOf(outRef(fund.id, 0))),
      node_out: 0n,
      config_ref: 0n,
      root_ref: null,
      children: [
        {
          out: 1n,
          external_out: null,
          leaf: { spec_hash: "ab".repeat(32), parent_spec_hash: root0.spec_hash, kind: "AddressPayment", max_budget: 12n * ADA, max_fee: 0n, payee_hash: P, acceptance_hash: "00".repeat(32) },
          proof: [],
        },
      ],
    },
  ],
  LOGIC_DRAW,
);
const PAYMENT = outRef(draw.id, 1);
const lock = plain(3, [PAYMENT, walletIn(3)].sort(), [lockOut("FundsLocked"), keyOut(P, 4n * ADA)]);
const requested = plain(4, [outRef(lock.id, 0), walletIn(4)].sort(), [lockOut("RefundRequested")]);
const refund = plain(5, [outRef(requested.id, 0), walletIn(5)].sort(), [keyOut(BUYER, 12n * ADA)]);
const withdraw = plain(6, [outRef(requested.id, 0), walletIn(6)].sort(), [keyOut(SELLER, 12n * ADA)]);

let db: TestDatabase;
const block = (slot: number) => ({ slot, hash: slot.toString(16).padStart(64, "0"), height: slot });
async function apply(t: ChainTx, slot: number): Promise<void> {
  await withTransaction(db.pool, async (c) => {
    await applyBlockTxs(c, [t], block(slot), SCRIPTS, 1_700_000_000_000, P);
    await recordPoint(c, block(slot), 100);
  });
}
const app = () =>
  createApi({
    pool: db.pool,
    scripts: SCRIPTS,
    oracle,
    log: pino({ level: "silent" }),
    tipHeight: async () => 200,
    tipSlot: async () => 200,
    horizonSlots: 300,
    adminToken: "t0ken",
    decimalsOf: () => 6,
    health: () => ({}),
    views: { slotConfig: { zeroTime: 1_700_000_000_000, zeroSlot: 0, slotLength: 1000 }, indexedSlot: async () => 170, maxExUnits: async () => ({ memory: 1n, steps: 1n }) },
  });

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

describe("Masumi leaf through the purchase wallet (ADR 0001 8.1)", () => {
  it("records the AddressPayment to P as a masumi payout awaiting P's lock", async () => {
    await apply(fund, 100);
    await apply(draw, 110);
    const [leaf] = await masumiLeaves(db.pool, TREE_ID);
    expect(leaf).toMatchObject({ node_id: TREE_ID, payment_out_ref: PAYMENT, draw_tx: draw.id, lock_tx: null, outcome: "awaiting_lock" });
    expect(leaf?.value.lovelace).toBe((12n * ADA).toString());
  });

  it("links P's plain lock tx, its blockchainIdentifier and the continuation", async () => {
    await apply(lock, 120);
    await apply(requested, 130);
    const [leaf] = await masumiLeaves(db.pool, TREE_ID);
    expect(leaf).toMatchObject({ lock_tx: lock.id, lock_out_ref: outRef(requested.id, 0), lock_state: "RefundRequested", outcome: "locked", outcome_tx: null });
    expect(leaf?.blockchain_identifier).toMatch(/^[0-9a-f]+$/);
  });

  it("serves one receipt line and the node detail leaf with the refund outcome", async () => {
    await apply(refund, 140);
    const receipt = (await (await app().request(`/v1/trees/${TREE_ID}/receipt`)).json()) as { payouts: { amount: string }; lines: Record<string, unknown>[] };
    const lines = receipt.lines.filter((l) => l.kind === "masumi");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ node_id: TREE_ID, tx_id: draw.id, payment_out_ref: PAYMENT, lock_tx: lock.id, outcome: "refunded", outcome_tx: refund.id });
    expect(lines[0]?.blockchain_identifier).toMatch(/^[0-9a-f]+$/);
    expect(receipt.payouts.amount).toBe((12n * ADA).toString());
    const detail = (await (await app().request(`/v1/trees/${TREE_ID}/nodes/${TREE_ID}`)).json()) as { masumi_leaves: { outcome: string; lock_tx: string }[] };
    expect(detail.masumi_leaves).toEqual([expect.objectContaining({ outcome: "refunded", lock_tx: lock.id, outcome_tx: refund.id })]);
  });

  it("undoes the outcome on rollback, and a seller withdrawal reads as withdrawn", async () => {
    await withTransaction(db.pool, (c) => rollbackTo(c, 130, block(130), 0));
    expect((await masumiLeaves(db.pool, TREE_ID))[0]).toMatchObject({ outcome: "locked", outcome_tx: null, lock_state: "RefundRequested" });
    await apply(withdraw, 150);
    expect((await masumiLeaves(db.pool, TREE_ID))[0]).toMatchObject({ outcome: "withdrawn", outcome_tx: withdraw.id });
  });
});
