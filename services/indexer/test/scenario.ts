/**
 * A full native lifecycle as ChainTx values, shaped exactly as the validators require (ADR 0001):
 * FundRoot, Draw one child, Submit, Accept, SettleChild, Submit root, Accept root, CloseRoot.
 * Lovelace tree: budget 100 ADA, orchestrator fee 10 ADA, child budget 30 ADA with fee 5 ADA.
 */
import { Constr } from "@lucid-evolution/lucid";
import { actionsToData, encodeNodeDatum, encodeTreeConfig, toCbor, type Action, type NodeDatum } from "@cascade/shared";
import { outRef, type ChainTx, type TxOutput } from "@cascade/service-kit";
import { BUYER, CHILD_ID, CONFIG_HASH, LOGIC_CORE, LOGIC_DRAW, NODE_HASH, TREE_ID, childDatum, keyAddress, rootDatum, scriptAddress, treeConfig } from "@cascade/service-kit/testing";
import { addressText } from "../src/store.js";

export const SCRIPTS = { node: NODE_HASH, config: CONFIG_HASH, logicCore: LOGIC_CORE, logicDraw: LOGIC_DRAW };
const ADA = 1_000_000n;

export const txId = (n: number) => n.toString(16).padStart(64, "0");
export const walletIn = (n: number) => `${"f".repeat(63)}${n.toString(16)}#0`;

export function nodeOut(d: NodeDatum): TxOutput {
  return {
    address: scriptAddress(NODE_HASH),
    lovelace: d.budget - d.committed - d.spent + d.structural,
    assets: { [`${NODE_HASH}.${d.node_id}`]: 1n },
    datum: encodeNodeDatum(d),
    datumHash: null,
    hasScriptRef: false,
    size: null,
  };
}

export function keyOut(pkh: string, lovelace: bigint): TxOutput {
  return { address: keyAddress(pkh), lovelace, assets: {}, datum: null, datumHash: null, hasScriptRef: false, size: null };
}

export function tx(n: number, inputs: string[], outputs: TxOutput[], actions: Action[], logic: string, mint: Record<string, bigint> = {}): ChainTx {
  const sorted = [...inputs].sort();
  return {
    id: txId(n),
    valid: true,
    inputs: sorted,
    referenceInputs: [],
    collateralInputs: [],
    collateralReturn: null,
    totalCollateral: null,
    outputs,
    mint,
    withdrawals: [{ rewardAddress: "stake_test1", credential: { type: "Script", hash: logic }, amount: 0n }],
    redeemers: [{ purpose: "withdraw", index: 0, data: toCbor(new Constr(0, [NODE_HASH, actionsToData(actions)])), exUnits: null }],
    requiredSigners: [],
    validFrom: null,
    validTo: null,
    fee: 300_000n,
    networkId: null,
    certificateCount: 0,
    hasGovernance: false,
    donation: 0n,
    vkeyWitnessHashes: [],
    sizeBytes: null,
  };
}

export interface Step {
  tx: ChainTx;
  slot: number;
}

export function lifecycle(): Step[] {
  const cfg = treeConfig();
  const configOut: TxOutput = {
    address: scriptAddress(CONFIG_HASH),
    lovelace: 2n * ADA,
    assets: { [`${NODE_HASH}.63${TREE_ID}`]: 1n },
    datum: encodeTreeConfig(cfg),
    datumHash: null,
    hasScriptRef: false,
    size: null,
  };
  const root0 = rootDatum({ budget: 100n * ADA, fee: 10n * ADA, structural: 10n * ADA });
  const t1 = tx(1, [walletIn(1)], [nodeOut(root0), configOut], [{ type: "FundRoot", seed: { transaction_id: "f".repeat(64), output_index: 0n }, root_out: 0n, config_out: 1n }], LOGIC_CORE, {
    [`${NODE_HASH}.${TREE_ID}`]: 1n,
    [`${NODE_HASH}.63${TREE_ID}`]: 1n,
  });
  const rootRef1 = outRef(t1.id, 0);

  const child0 = childDatum({ budget: 30n * ADA, fee: 5n * ADA, structural: 2n * ADA });
  const root1 = { ...root0, committed: 30n * ADA, children_open: 1n, next_child: 1n, structural: 8n * ADA };
  const drawInputs = [rootRef1, walletIn(2)].sort();
  const t2 = tx(
    2,
    drawInputs,
    [nodeOut(root1), nodeOut(child0)],
    [{ type: "Draw", node_in: BigInt(drawInputs.indexOf(rootRef1)), node_out: 0n, config_ref: 0n, root_ref: null, children: drawChildren(child0, root0) }],
    LOGIC_DRAW,
    { [`${NODE_HASH}.${CHILD_ID}`]: 1n },
  );
  const rootRef2 = outRef(t2.id, 0);
  const childRef2 = outRef(t2.id, 1);

  const result = "cd".repeat(32);
  const child1 = { ...child0, result_hash: result, state: "Submitted" as const };
  const t3 = single(3, childRef2, walletIn(3), child1, (i) => ({ type: "Submit", node_in: i, node_out: 0n, result_hash: result }));
  const childRef3 = outRef(t3.id, 0);
  const child2 = { ...child1, state: "Accepted" as const };
  const t4 = single(4, childRef3, walletIn(4), child2, (i) => ({ type: "Accept", node_in: i, node_out: 0n }));
  const childRef4 = outRef(t4.id, 0);

  // ADR 1.5: the budget never shrinks; the child's 5 ADA fee is recorded in the parent's `spent`.
  const root2 = { ...root1, committed: 0n, children_open: 0n, structural: 10n * ADA, spent: 5n * ADA };
  const settleInputs = [childRef4, rootRef2, walletIn(5)].sort();
  const t5 = tx(
    5,
    settleInputs,
    [nodeOut(root2), keyOut(child0.operator, 5n * ADA)],
    [
      {
        type: "SettleChild",
        node_in: BigInt(settleInputs.indexOf(childRef4)),
        parent_in: BigInt(settleInputs.indexOf(rootRef2)),
        parent_out: 0n,
        payee_out: 1n,
        payee_lovelace: 0n,
      },
    ],
    LOGIC_CORE,
    { [`${NODE_HASH}.${CHILD_ID}`]: -1n },
  );
  const rootRef5 = outRef(t5.id, 0);

  const root3 = { ...root2, result_hash: result, state: "Submitted" as const };
  const t6 = single(6, rootRef5, walletIn(6), root3, (i) => ({ type: "Submit", node_in: i, node_out: 0n, result_hash: result }));
  const rootRef6 = outRef(t6.id, 0);
  const root4 = { ...root3, state: "Accepted" as const };
  const t7 = single(7, rootRef6, walletIn(7), root4, (i) => ({ type: "Accept", node_in: i, node_out: 0n }));
  const rootRef7 = outRef(t7.id, 0);

  const configRef = outRef(t1.id, 1);
  const closeInputs = [rootRef7, configRef, walletIn(8)].sort();
  const t8 = tx(
    8,
    closeInputs,
    [keyOut(root0.operator, 10n * ADA), keyOut(BUYER, 85n * ADA + 12n * ADA)],
    [
      {
        type: "CloseRoot",
        node_in: BigInt(closeInputs.indexOf(rootRef7)),
        config_in: BigInt(closeInputs.indexOf(configRef)),
        payee_out: 0n,
        payee_lovelace: 0n,
        protocol_lovelace: 0n,
        protocol_out: null,
        refund_out: 1n,
      },
    ],
    LOGIC_CORE,
    { [`${NODE_HASH}.${TREE_ID}`]: -1n, [`${NODE_HASH}.63${TREE_ID}`]: -1n },
  );

  return [t1, t2, t3, t4, t5, t6, t7, t8].map((t, i) => ({ tx: t, slot: 100 + i * 10 }));
}

function drawChildren(child0: NodeDatum, root0: NodeDatum) {
  return [
    {
      out: 1n,
      external_out: null,
      leaf: { spec_hash: child0.spec_hash, parent_spec_hash: root0.spec_hash, kind: "Native" as const, max_budget: 30n * ADA, max_fee: 5n * ADA, payee_hash: "00".repeat(28), acceptance_hash: "00".repeat(32) },
      proof: [],
    },
  ];
}

function single(n: number, nodeRef: string, wallet: string, next: NodeDatum, action: (nodeIn: bigint) => Action): ChainTx {
  const inputs = [nodeRef, wallet].sort();
  return tx(n, inputs, [nodeOut(next)], [action(BigInt(inputs.indexOf(nodeRef)))], LOGIC_CORE);
}

export { addressText };
