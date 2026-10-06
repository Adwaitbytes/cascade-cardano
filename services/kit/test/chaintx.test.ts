import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Constr, Data } from "@lucid-evolution/lucid";
import { actionsToData, encodeNodeDatum, encodeTreeConfig, toCbor, type Action } from "@cascade/shared";
import { describe, expect, it } from "vitest";
import { CML } from "@lucid-evolution/lucid";
import { cascadeActions, chainTxFromCbor, chainTxFromOgmios, configOutputs, decodeLogicRedeemer, nodeOutputs, parseOutRef } from "../src/index.js";
import {
  CHILD_ID,
  CONFIG_HASH,
  LOGIC_CORE,
  LOGIC_DRAW,
  NODE_HASH,
  TREE_ID,
  buildTxCbor,
  childDatum,
  keyAddress,
  rootDatum,
  scriptAddress,
  treeConfig,
} from "../src/testing/index.js";

const SCRIPTS = { node: NODE_HASH, config: CONFIG_HASH, logicCore: LOGIC_CORE, logicDraw: LOGIC_DRAW };
const TXA = "a".repeat(64);

function logicRedeemer(actions: Action[], nodeHash = NODE_HASH): string {
  return toCbor(new Constr(0, [nodeHash, actionsToData(actions)]));
}

describe("chainTxFromCbor", () => {
  it("decodes a real signed payment from Yaci with an inline datum", () => {
    const hex = readFileSync(resolve(import.meta.dirname, "fixtures/payment-with-inline-datum.tx.hex"), "utf8").trim();
    const tx = chainTxFromCbor(hex);
    expect(tx.id).toBe("27a2513a2f806e028301042c4087f78493652917fee72029be1ca722a11565a8");
    expect(tx.outputs[0]?.datum).toBe(Data.to(new Constr(0, [42n, "abcd"])));
    expect(tx.outputs[0]?.lovelace).toBe(3_000_000n);
    expect(tx.requiredSigners).toEqual(["07d781fe8e33883e371f9550c2f1087321fc32e06e80b65e349ccb02"]);
    expect(tx.vkeyWitnessHashes).toEqual(["07d781fe8e33883e371f9550c2f1087321fc32e06e80b65e349ccb02"]);
    expect(tx.validTo).toBe(2269);
    expect(tx.fee).toBe(170_957n);
  });

  it("decodes mint, burn, script withdrawals and Conway map redeemers", () => {
    const actions: Action[] = [{ type: "Submit", node_in: 0n, node_out: 0n, result_hash: "cd".repeat(32) }];
    const hex = buildTxCbor({
      inputs: [`${TXA}#1`, `${TXA}#0`],
      outputs: [{ address: scriptAddress(NODE_HASH), lovelace: 5_000_000n, assets: { [`${NODE_HASH}.${CHILD_ID}`]: 1n }, datum: encodeNodeDatum(childDatum()) }],
      fee: 300_000n,
      mint: { [`${NODE_HASH}.${CHILD_ID}`]: 1n, [`${NODE_HASH}.${"99".repeat(28)}`]: -1n },
      withdrawals: [{ scriptHash: LOGIC_CORE, amount: 0n }],
      redeemers: [{ tag: 3, index: 0, data: logicRedeemer(actions) }],
      ttl: 500n,
      validFrom: 100n,
    });
    const tx = chainTxFromCbor(hex);
    expect(tx.inputs).toEqual([`${TXA}#0`, `${TXA}#1`]);
    expect(tx.mint).toEqual({ [`${NODE_HASH}.${CHILD_ID}`]: 1n, [`${NODE_HASH}.${"99".repeat(28)}`]: -1n });
    expect(tx.withdrawals).toEqual([{ rewardAddress: expect.stringMatching(/^stake_test1/), credential: { type: "Script", hash: LOGIC_CORE }, amount: 0n }]);
    expect(tx.redeemers[0]?.purpose).toBe("withdraw");
    expect(tx.validFrom).toBe(100);
    expect(tx.validTo).toBe(500);
    expect(cascadeActions(tx, SCRIPTS)).toEqual(actions);
    expect(nodeOutputs(tx, NODE_HASH).map((n) => n.datum.node_id)).toEqual([CHILD_ID]);
  });
});

describe("cascade decoding", () => {
  it("accepts only node outputs with exactly one matching token (T1)", () => {
    const hex = buildTxCbor({
      inputs: [`${TXA}#0`],
      outputs: [
        { address: scriptAddress(NODE_HASH), lovelace: 5_000_000n, datum: encodeNodeDatum(rootDatum()) },
        { address: scriptAddress(NODE_HASH), lovelace: 5_000_000n, assets: { [`${NODE_HASH}.${CHILD_ID}`]: 1n }, datum: encodeNodeDatum(rootDatum()) },
        { address: scriptAddress(NODE_HASH), lovelace: 5_000_000n, assets: { [`${NODE_HASH}.${TREE_ID}`]: 1n }, datum: encodeNodeDatum(rootDatum()) },
        {
          address: scriptAddress(CONFIG_HASH),
          lovelace: 2_000_000n,
          assets: { [`${NODE_HASH}.63${TREE_ID}`]: 1n },
          datum: encodeTreeConfig(treeConfig()),
        },
        { address: keyAddress("12".repeat(28)), lovelace: 2_000_000n, assets: { [`${NODE_HASH}.${TREE_ID}`]: 1n }, datum: encodeNodeDatum(rootDatum()) },
      ],
      fee: 200_000n,
    });
    const tx = chainTxFromCbor(hex);
    expect(nodeOutputs(tx, NODE_HASH).map((n) => n.index)).toEqual([2]);
    expect(configOutputs(tx, SCRIPTS).map((c) => [c.index, c.config.tree_id])).toEqual([[3, TREE_ID]]);
  });

  it("ignores a logic redeemer that names another node hash", () => {
    const hex = buildTxCbor({
      inputs: [`${TXA}#0`],
      outputs: [],
      fee: 200_000n,
      withdrawals: [{ scriptHash: LOGIC_DRAW, amount: 0n }],
      redeemers: [{ tag: 3, index: 0, data: logicRedeemer([{ type: "Freeze", node_in: 0n, node_out: 0n }], "ee".repeat(28)) }],
    });
    expect(cascadeActions(chainTxFromCbor(hex), SCRIPTS)).toBeNull();
  });

  it("decodes a bare List<Action> redeemer for older blueprints", () => {
    const bare = toCbor(actionsToData([{ type: "Unfreeze", node_in: 1n, node_out: 2n }]));
    expect(decodeLogicRedeemer(bare)?.actions).toEqual([{ type: "Unfreeze", node_in: 1n, node_out: 2n }]);
    expect(decodeLogicRedeemer("ff")).toBeNull();
  });
});

describe("chainTxFromOgmios", () => {
  it("normalises an Ogmios block transaction", () => {
    const tx = chainTxFromOgmios({
      id: "b".repeat(64),
      spends: "inputs",
      inputs: [{ transaction: { id: TXA }, index: 3 }],
      outputs: [{ address: scriptAddress(NODE_HASH), value: { ada: { lovelace: 9_007_199_254_740_993n }, [NODE_HASH]: { [CHILD_ID]: 1 } }, datum: "d87980" }],
      mint: { [NODE_HASH]: { [CHILD_ID]: 1 } },
      withdrawals: { [CML.RewardAddress.new(0, CML.Credential.new_script(CML.ScriptHash.from_hex(LOGIC_CORE))).to_address().to_bech32()]: { ada: { lovelace: 0 } } },
      redeemers: [{ validator: { purpose: "withdraw", index: 0 }, redeemer: "80" }],
      validityInterval: { invalidAfter: 900 },
      fee: { ada: { lovelace: 1 } },
    });
    expect(tx.outputs[0]?.lovelace).toBe(9_007_199_254_740_993n);
    expect(tx.outputs[0]?.assets).toEqual({ [`${NODE_HASH}.${CHILD_ID}`]: 1n });
    expect(tx.inputs).toEqual([`${TXA}#3`]);
    expect(tx.validTo).toBe(900);
    expect(tx.valid).toBe(true);
    expect(tx.withdrawals[0]?.credential).toEqual({ type: "Script", hash: LOGIC_CORE });
    expect(parseOutRef(`${TXA}#3`)).toEqual({ txId: TXA, index: 3 });
  });
});

describe("ADR 0001 section 1.4", () => {
  it("decodes actions from a cascade_logic_ext withdrawal and ignores channel tokens", () => {
    const EXT = "5e".repeat(28);
    const actions: Action[] = [{ type: "Freeze", node_in: 0n, node_out: 0n }];
    const hex = buildTxCbor({
      inputs: [`${TXA}#0`],
      outputs: [
        { address: scriptAddress(CONFIG_HASH), lovelace: 2_000_000n, assets: { [`${NODE_HASH}.6b${CHILD_ID}`]: 1n }, datum: encodeTreeConfig(treeConfig()) },
        { address: scriptAddress(NODE_HASH), lovelace: 2_000_000n, assets: { [`${NODE_HASH}.6b${CHILD_ID}`]: 1n }, datum: encodeNodeDatum(childDatum()) },
      ],
      fee: 200_000n,
      withdrawals: [{ scriptHash: EXT, amount: 0n }],
      redeemers: [{ tag: 3, index: 0, data: logicRedeemer(actions) }],
    });
    const tx = chainTxFromCbor(hex);
    expect(cascadeActions(tx, { ...SCRIPTS, logicExt: EXT })).toEqual(actions);
    expect(cascadeActions(tx, SCRIPTS)).toBeNull();
    expect(configOutputs(tx, SCRIPTS)).toEqual([]);
    expect(nodeOutputs(tx, NODE_HASH)).toEqual([]);
  });
});
