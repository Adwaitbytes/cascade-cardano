/**
 * Failed cranks on the preprod ops page (2026-10-01..05): a SettleChild failed with "Cannot read
 * properties of undefined (reading 'address')", later ones with "node <id> not found", and others
 * stored kilobytes of ledger JSON as their error.
 *
 * Root cause of the TypeError: the SDK looked nodes up with Lucid's `utxoByUnit`, which on
 * Blockfrost asks `/assets/{unit}/addresses` and reads `addresses[0].address`. Once the node token
 * is burned (the child was already settled by another transaction while the indexer lagged), that
 * list is empty and the provider throws a TypeError. The SDK now queries the node address by unit
 * and raises "node <id> not found"; the watchtower records it as a short, retryable cause.
 */
import { readFileSync } from "node:fs";
import { CascadeClient, CascadeTxError, loadCascadeScripts, type ReferenceScripts } from "@cascade/sdk";
import { MAX_CAUSE_LENGTH, crankCause } from "@cascade/service-kit";
import { createTestDatabase, type TestDatabase } from "@cascade/service-kit/testing";
import type { LucidEvolution, UTxO } from "@lucid-evolution/lucid";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SdkCrankExecutor } from "../src/executor.js";
import { tick } from "../src/loop.js";
import type { Crank } from "../src/selection.js";

const BLUEPRINT = new URL("../../../contracts/plutus.json", import.meta.url);
const id = (b: string) => b.repeat(28);

/** Lucid's Blockfrost `getUtxoByUnit`, verbatim in effect: an empty holder list has no `[0]`. */
async function blockfrostUtxoByUnit(): Promise<UTxO> {
  const addresses: { address: string }[] = [];
  const address = addresses[0]!.address;
  throw new Error(`unreachable: ${address}`);
}

/** A Lucid stand-in on preprod where the node token has been burned: no UTxO holds it. */
function burnedTokenLucid(calls: string[]): LucidEvolution {
  const lucid = {
    config: () => ({ network: "Preprod" }),
    utxosAtWithUnit: async (_address: string, unit: string) => (calls.push(`utxosAtWithUnit:${unit.slice(-4)}`), [] as UTxO[]),
    utxoByUnit: async () => (calls.push("utxoByUnit"), blockfrostUtxoByUnit()),
  };
  return lucid as unknown as LucidEvolution;
}

describe("crank on a node whose token was already burned", () => {
  it("documents the provider failure the SDK used to hit", async () => {
    await expect(blockfrostUtxoByUnit()).rejects.toThrow("Cannot read properties of undefined (reading 'address')");
  });

  it("fails SettleChild with a plain 'not found', never the provider's TypeError", async () => {
    const calls: string[] = [];
    const client = new CascadeClient(burnedTokenLucid(calls), loadCascadeScripts(JSON.parse(readFileSync(BLUEPRINT, "utf8"))), {} as ReferenceScripts);
    const ex = new SdkCrankExecutor(client, null, null);
    const crank: Crank = { kind: "SettleChild", nodeId: id("a8"), treeId: id("fc"), utxoRef: `${"6e".repeat(32)}#0`, dueAt: 0n };
    const err = await ex.execute(crank).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CascadeTxError);
    expect((err as Error).message).toBe(`node ${id("a8")} not found`);
    expect(calls).toEqual([`utxosAtWithUnit:${id("a8").slice(-4)}`]);
    expect(crankCause(err)).toEqual({ cause: "node UTxO not at the chain provider: already spent by another transaction, or not indexed yet", transient: true });
  });
});

describe("crank causes for the ops page", () => {
  const ledger =
    'Error: {"contents":{"contents":{"contents":{"era":"ShelleyBasedEraConway","error":["ConwayUtxowFailure (UtxoFailure (ValueNotConservedUTxO (Mismatch {mismatchSupplied = MaryValue (Coin 1)})))","ConwayUtxowFailure (UtxoFailure (OutputTooSmallUTxO [(Addr Testnet)]))"]}}}}';
  const seen: [string, Error, string, boolean][] = [
    ["the historical TypeError", new TypeError("Cannot read properties of undefined (reading 'address')"), "node UTxO not at the chain provider: already spent by another transaction, or not indexed yet", true],
    ["a spent node", new CascadeTxError(`node ${id("7e")} not found`), "node UTxO not at the chain provider: already spent by another transaction, or not indexed yet", true],
    [
      "a stale fee wallet",
      new Error('Error: {"contents":{"contents":{"contents":{"era":"ShelleyBasedEraConway","error":["ConwayUtxowFailure (UtxoFailure (InsufficientCollateral (DeltaCoin (-123022141)) (Coin 799110)))"]}}}}'),
      "fee wallet view was stale: an input was already spent; retrying",
      true,
    ],
    ["an early crank", new Error("too early: allowed after 1790818629000 plus 60000 ms of tip lag, clock is 1790818678000"), "deadline not yet passed at the chain tip; retrying", true],
    ["a missing signature", new Error(`crank CloseReceipt unexpectedly needs signatures from ${"d8954b57".repeat(7)}`), "needs a signature the watchtower does not hold (d8954b57...)", false],
    ["a ledger rejection", new Error(ledger), "ledger rejected the transaction: ValueNotConservedUTxO, OutputTooSmallUTxO", false],
    ["other JSON", new Error('{"error":"Bad Request","status_code":400}'), "chain provider rejected the transaction", false],
    ["another TypeError", new TypeError("Cannot read properties of null (reading 'datum')"), "internal error in the transaction builder", false],
    ["a plain message", new Error("provider down"), "provider down", false],
  ];

  it.each(seen)("states %s in one short line", (_what, err, cause, transient) => {
    expect(crankCause(err)).toEqual({ cause, transient });
    expect(cause.length).toBeLessThanOrEqual(MAX_CAUSE_LENGTH);
    expect(cause).not.toMatch(/[{}\n]/);
  });

  it("is stable on a cause it already produced, so the ops view can apply it to stored rows", () => {
    for (const [, err] of seen) {
      const once = crankCause(err).cause;
      expect(crankCause(once).cause).toBe(once);
    }
  });

  it("cuts a long message to the limit", () => {
    expect(crankCause(new Error("x".repeat(1_000))).cause).toHaveLength(MAX_CAUSE_LENGTH);
  });
});

describe("watchtower coverage beyond the indexer's 100-tree page", () => {
  let db: TestDatabase;
  const T = 2_000_000_000_000n;
  const TREES = 150;
  const hex = (i: number, bytes: number) => i.toString(16).padStart(bytes * 2, "0");

  beforeAll(async () => {
    db = await createTestDatabase();
    for (let i = 0; i < TREES; i++) {
      const tree = hex(i + 1, 28);
      const utxo = `${hex(i + 1, 32)}#0`;
      await db.pool.query(
        `INSERT INTO trees (tree_id, buyer_vkh, asset, root_budget, plan_root, config_utxo, state, created_slot, config, created_tx, updated_slot)
         VALUES ($1, $2, 'lovelace', 0, $3, $4, 'open', 1, '{}', $3, 1)`,
        [tree, id("99"), "ab".repeat(32), utxo.replace("#0", "#1")],
      );
      await db.pool.query(
        `INSERT INTO nodes (node_id, tree_id, parent_id, depth, kind, operator_vkh, payee, budget, fee, committed, children_open, spec_hash, input_hash, acceptance,
           submit_by, challenge_until, refund_after, dispute_until, state, current_utxo, next_child, structural, external_lovelace, created_tx, created_slot, last_tx, updated_slot)
         VALUES ($1, $1, NULL, 0, 'Native', $2, 'addr_test1x', 1, 0, 0, 0, $3, $3, '{"type":"AutoAfterWindow"}', $4, $5, $4, $5, 'Funded', $6, 0, 0, 0, $3, 1, $3, 1)`,
        [tree, id("22"), "ab".repeat(32), T.toString(), (T + 600_000n).toString(), utxo],
      );
    }
  });
  afterAll(async () => {
    await db.drop();
  });

  it("selects a crank for every live tree, reading Postgres rather than the paged read API", async () => {
    const { selected } = await tick({ pool: db.pool, executor: null, log: pino({ level: "silent" }), chainTime: async () => T + 60_000n });
    expect(selected.filter((c) => c.kind === "Refund")).toHaveLength(TREES);
  });
});
