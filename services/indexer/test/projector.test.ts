import { Constr } from "@lucid-evolution/lucid";
import { actionsToData, decodeNodeDatum, decodeTreeConfig, encodeBondDatum, encodeMasumiDatum, encodeNodeDatum, toCbor } from "@cascade/shared";
import { chainTxFromCbor } from "@cascade/service-kit";
import { CHILD_ID, LOGIC_CORE, NODE_HASH, TREE_ID, buildTxCbor, childDatum, keyAddr, scriptAddress } from "@cascade/service-kit/testing";
import { describe, expect, it } from "vitest";
import { masumiIdentifier, project, type Flow, type TrackedUtxo } from "../src/projector.js";
import { reconcile } from "../src/receipt.js";
import { SCRIPTS, addressText, lifecycle, nodeOut, tx, walletIn } from "./scenario.js";

/** Runs the projector over the scenario with an in-memory UTxO set, as the store would. */
function runAll() {
  const tracked = new Map<string, TrackedUtxo>();
  const configs = new Map<string, ReturnType<typeof decodeTreeConfig>>();
  const results = [];
  for (const { tx } of lifecycle()) {
    const p = project(tx, { scripts: SCRIPTS, tracked, configs, addressText });
    for (const ref of p.spent) tracked.delete(ref);
    for (const c of p.createdConfigs) {
      tracked.set(c.outRef, { kind: "config", outRef: c.outRef, nodeId: c.config.tree_id, treeId: c.config.tree_id, config: c.config, lovelace: c.output.lovelace });
      configs.set(c.config.tree_id, c.config);
    }
    for (const n of p.createdNodes) {
      tracked.set(n.outRef, { kind: "node", outRef: n.outRef, nodeId: n.datum.node_id, treeId: n.datum.tree_id, datum: decodeNodeDatum(n.output.datum ?? ""), lovelace: n.output.lovelace });
    }
    results.push(p);
  }
  return results;
}

describe("projector", () => {
  it("emits the PRD 17.3 events for a full native lifecycle, in order", () => {
    const types = runAll().map((p) => p.events.map((e) => `${e.type}:${e.nodeId === TREE_ID ? "root" : e.nodeId === CHILD_ID ? "child" : e.nodeId}`));
    expect(types).toEqual([
      ["tree.funded:root"],
      ["node.drawn:child"],
      ["node.submitted:child"],
      ["node.accepted:child"],
      ["node.settled:child"],
      ["node.submitted:root"],
      ["node.accepted:root"],
      ["node.settled:root", "tree.closed:root"],
    ]);
  });

  it("tracks terminal states and tree closure", () => {
    const r = runAll();
    expect(r[4]?.terminal).toEqual([{ nodeId: CHILD_ID, treeId: TREE_ID, state: "Settled" }]);
    expect(r[7]?.terminal).toEqual([{ nodeId: TREE_ID, treeId: TREE_ID, state: "Settled" }]);
    expect(r[7]?.closedTrees).toEqual([{ treeId: TREE_ID, state: "closed" }]);
    expect(r[1]?.createdNodes.map((n) => [n.datum.node_id, n.isNew])).toEqual([
      [TREE_ID, false],
      [CHILD_ID, true],
    ]);
  });

  it("values each event with the amount it moves", () => {
    const r = runAll();
    expect(r[0]?.events[0]?.amount).toBe(100_000_000n);
    expect(r[1]?.events[0]?.amount).toBe(30_000_000n);
    expect(r[4]?.events[0]?.payload).toEqual({ fee_paid: "5000000", returned_to_parent: "25000000" });
    expect(r[7]?.events[1]?.payload).toEqual({ paid: "10000000", refunded: "85000000", structural_returned_lovelace: "12000000" });
  });

  it("reconciles to the lovelace (invariant 1)", () => {
    const flows = runAll().flatMap((p) => p.events.flatMap((e) => e.flows.map((flow: Flow) => ({ txId: p.txId, flow }))));
    const { receipt, totals } = reconcile({ treeId: TREE_ID, asset: "lovelace", closed: true, flows });
    expect(totals).toEqual({
      deposits: 100_000_000n,
      payouts: 15_000_000n,
      refunds: 85_000_000n,
      protocolFees: 0n,
      structuralIn: 12_000_000n,
      structuralOut: 0n,
      structuralReturned: 12_000_000n,
    });
    expect(receipt.balanced).toBe(true);
    // The explorer's equation: deposits - payouts - refunds - fees - structural returned = 0.
    const n = (x: { amount: string } | string) => BigInt(typeof x === "string" ? x : x.amount);
    expect(n(receipt.deposits)).toBe(112_000_000n);
    expect(n(receipt.deposits) - n(receipt.payouts) - n(receipt.refunds) - n(receipt.fees) - n(receipt.structural_returned_lovelace)).toBe(0n);
    expect(reconcile({ treeId: TREE_ID, asset: "lovelace", closed: false, flows }).receipt.balanced).toBe(false);
  });

  it("balances a token tree on the token and on structural lovelace separately", () => {
    const USDM = "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d";
    const f = (kind: Flow["kind"], asset: string, amount: bigint) => ({ txId: "00".repeat(32), flow: { kind, node_id: TREE_ID, to: "x", asset, amount } });
    const flows = [
      f("deposit", USDM, 150_000_000n),
      f("structural_in", "lovelace", 14_000_000n),
      f("fee", USDM, 105_420_000n),
      f("structural_out", "lovelace", 2_000_000n),
      f("refund", USDM, 44_580_000n),
      f("structural_returned", "lovelace", 12_000_000n),
    ];
    const { receipt } = reconcile({ treeId: TREE_ID, asset: USDM, closed: true, flows });
    const n = (x: { amount: string } | string) => BigInt(typeof x === "string" ? x : x.amount);
    expect(n(receipt.deposits) - n(receipt.payouts) - n(receipt.refunds) - n(receipt.fees)).toBe(0n);
    expect(n(receipt.structural_deposited_lovelace) - n(receipt.structural_paid_lovelace) - n(receipt.structural_returned_lovelace)).toBe(0n);
    expect(receipt.balanced).toBe(true);
  });

  it("ignores phase-2-failed transactions and unrelated ones", () => {
    const [first] = lifecycle();
    const invalid = { ...first!.tx, valid: false };
    expect(project(invalid, { scripts: SCRIPTS, tracked: new Map(), configs: new Map(), addressText }).events).toEqual([]);
    const unrelated = { ...first!.tx, outputs: [], mint: {} };
    expect(project(unrelated, { scripts: SCRIPTS, tracked: new Map(), configs: new Map(), addressText }).events).toEqual([]);
  });

  it("classifies a burn without a decodable redeemer from the datum", () => {
    const steps = lifecycle();
    const tracked = new Map<string, TrackedUtxo>();
    // Replay up to the draw, then refund the funded child with no redeemer attached.
    for (const { tx } of steps.slice(0, 2)) {
      const p = project(tx, { scripts: SCRIPTS, tracked, configs: new Map(), addressText });
      for (const ref of p.spent) tracked.delete(ref);
      for (const n of p.createdNodes) tracked.set(n.outRef, { kind: "node", outRef: n.outRef, nodeId: n.datum.node_id, treeId: n.datum.tree_id, datum: n.datum, lovelace: n.output.lovelace });
    }
    const childRef = [...tracked.values()].find((t) => t.nodeId === CHILD_ID)!.outRef;
    const refund = { ...steps[2]!.tx, id: "e".repeat(64), inputs: [childRef], outputs: [], redeemers: [], withdrawals: [] };
    const p = project(refund, { scripts: SCRIPTS, tracked, configs: new Map(), addressText });
    expect(p.events.map((e) => e.type)).toEqual(["node.refunded"]);
    expect(p.terminal[0]?.state).toBe("Refunded");
  });

  it("tracks only bonds whose datum names the cascade_node authority (ADR 1.3)", () => {
    const BOND = "b0".repeat(28);
    const bond = (authority: string) =>
      encodeBondDatum({ authority, tree_id: TREE_ID, node_id: CHILD_ID, owner: "31".repeat(28), owner_address: keyAddr("31".repeat(28)), role: "Challenger", release_after: 5n });
    const tx = chainTxFromCbor(
      buildTxCbor({
        inputs: [`${"a".repeat(64)}#0`],
        outputs: [
          { address: scriptAddress(BOND), lovelace: 5_000_000n, datum: bond(NODE_HASH) },
          { address: scriptAddress(BOND), lovelace: 7_000_000n, datum: bond("ee".repeat(28)) },
        ],
        fee: 200_000n,
      }),
    );
    const p = project(tx, { scripts: { ...SCRIPTS, bond: BOND }, tracked: new Map(), configs: new Map(), addressText });
    expect(p.createdBonds.map((b) => [b.datum.node_id, b.output.lovelace])).toEqual([[CHILD_ID, 5_000_000n]]);
    expect(project(tx, { scripts: SCRIPTS, tracked: new Map(), configs: new Map(), addressText }).createdBonds).toEqual([]);
  });

  it("links a Masumi receipt to its lock as (draw tx id, external_out) and reports it on close", () => {
    const MASUMI = "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad";
    const RECEIPT = "6d".repeat(28);
    const receipt = { ...decodeNodeDatum(lifecycle()[1]!.tx.outputs[1]!.datum ?? ""), node_id: RECEIPT, kind: "MasumiReceipt" as const, fee: 0n };
    const leaf = { spec_hash: receipt.spec_hash, parent_spec_hash: "01".repeat(32), kind: "MasumiReceipt" as const, max_budget: 30_000_000n, max_fee: 0n, payee_hash: "00".repeat(28), acceptance_hash: "00".repeat(32) };
    const draw = {
      ...lifecycle()[1]!.tx,
      id: "d1".repeat(32),
      outputs: [
        { address: scriptAddress(NODE_HASH), lovelace: 2_000_000n, assets: { [`${NODE_HASH}.${RECEIPT}`]: 1n }, datum: encodeNodeDatum(receipt), datumHash: null, hasScriptRef: false, size: null },
        { address: scriptAddress(MASUMI), lovelace: 32_000_000n, assets: {}, datum: "d87980", datumHash: null, hasScriptRef: false, size: null },
      ],
      redeemers: [{ purpose: "withdraw" as const, index: 0, data: toCbor(new Constr(0, [NODE_HASH, actionsToData([{ type: "Draw", node_in: 0n, node_out: 5n, config_ref: 0n, root_ref: null, children: [{ out: 0n, external_out: 1n, leaf, proof: [] }] }])])), exUnits: null }],
    };
    const p = project(draw, { scripts: SCRIPTS, tracked: new Map(), configs: new Map(), addressText });
    expect(p.externalLinks).toEqual([{ nodeId: RECEIPT, outRef: `${"d1".repeat(32)}#1`, blockchainIdentifier: null }]);
  });

  it("rebuilds a Masumi lock's blockchainIdentifier from its datum (x402 spec vector 1) and carries it to the close", () => {
    const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
    const key = (h: string) => ({ payment_credential: { type: "VerificationKey" as const, hash: h }, stake_credential: null });
    const datum = encodeMasumiDatum({
      buyer: key("11".repeat(28)),
      buyer_return_address: null,
      seller: key("22".repeat(28)),
      seller_return_address: null,
      reference_key: "a10101",
      reference_signature: "55".repeat(16),
      seller_nonce: "11".repeat(32),
      buyer_nonce: "",
      agent_identifier: "",
      collateral_return_lovelace: 1_435_230n,
      input_hash: "44".repeat(32),
      result_hash: "",
      pay_by_time: 1785756000000n,
      submit_result_time: 1785759600000n,
      unlock_time: 1785763200000n,
      external_dispute_unlock_time: 1785766800000n,
      seller_cooldown_time: 0n,
      buyer_cooldown_time: 0n,
      state: "FundsLocked",
    });
    const id = masumiIdentifier({ address: ESCROW, lovelace: 5_000_000n, assets: {}, datum, datumHash: null, hasScriptRef: false, size: null });
    expect(id).toBe(
      "230d7c6574f41d1c0acc96ade8eae04360019f607004d8809c07d005c053019cae007700bce8058680d89818c04e44002c035931a2c00daf5e00ac9bf00b6c401b80473c6535d00e6003cb8b110199db615001ca8eecc6019b58076c603b13763a80",
    );
  });
});

describe("receipt close structural accounting", () => {
  // W4's PRD 21.2 demo tree on Yaci: a metered CloseReceipt returns the channel's min-ADA to the
  // parent, so no structural lovelace leaves the tree there; only the 4.2 ADA the provider redeemed
  // is paid out.
  const PARENT = "14".repeat(28);
  const METER = "78".repeat(28);
  const ref = (b: string, i = 0) => `${b.repeat(32)}#${i}`;
  const parentBefore = childDatum({ node_id: PARENT, structural: 3_120_440n, budget: 60_000_000n, spent: 0n, children_open: 1n, committed: 20_000_000n });
  const close = (kind: "MeteredReceipt" | "MasumiReceipt", parentStructuralAfter: bigint) => {
    const receipt = childDatum({ node_id: METER, parent_id: PARENT, kind, budget: 20_000_000n, fee: 0n, structural: 3_004_070n, external_lovelace: 2_305_850n });
    const parentAfter = { ...parentBefore, structural: parentStructuralAfter, committed: 0n, children_open: 0n, spent: 4_200_000n };
    const tracked = new Map<string, TrackedUtxo>([
      [ref("a1"), { kind: "node", outRef: ref("a1"), nodeId: PARENT, treeId: TREE_ID, datum: parentBefore, lovelace: 15_246_756n }],
      [ref("a2"), { kind: "node", outRef: ref("a2"), nodeId: METER, treeId: TREE_ID, datum: receipt, lovelace: 3_004_070n }],
    ]);
    const t = tx(9, [ref("a1"), ref("a2"), walletIn(9)], [nodeOut(parentAfter)], [], LOGIC_CORE, { [`${NODE_HASH}.${METER}`]: -1n });
    const p = project(t, { scripts: SCRIPTS, tracked, configs: new Map(), addressText });
    return p.events.flatMap((e) => e.flows).map((f) => [f.kind, f.amount]);
  };

  it("books no structural outflow when a metered close returns the channel's min-ADA to the parent", () => {
    // 3,120,440 + 3,004,070 + 2,305,850 = 8,430,360: everything came back.
    expect(close("MeteredReceipt", 8_430_360n)).toEqual([["fee", 4_200_000n]]);
  });

  it("books the min-ADA a Masumi lock keeps as leaving the tree", () => {
    // The parent regains only the receipt's own structural; the lock holds the rest.
    expect(close("MasumiReceipt", 3_120_440n + 3_004_070n)).toEqual([
      ["fee", 4_200_000n],
      ["structural_out", 2_305_850n],
    ]);
  });
});
