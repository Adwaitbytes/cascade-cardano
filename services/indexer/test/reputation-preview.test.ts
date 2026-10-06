import { Constr } from "@lucid-evolution/lucid";
import { actionsToData, encodeNodeDatum, toCbor } from "@cascade/shared";
import { CHILD_ID, LOGIC_CORE, NODE_HASH, TREE_ID, buildTxCbor, childDatum, keyAddress, scriptAddress } from "@cascade/service-kit/testing";
import { describe, expect, it } from "vitest";
import { previewTx, formatAmount } from "../src/preview.js";
import type { TrackedUtxo } from "../src/projector.js";
import { computeReputation, DEFAULT_REPUTATION_PARAMS, isSelfDealing, snapshotProof, snapshotRoot, snapshotLeaf, type SettledNode } from "../src/reputation.js";
import { SCRIPTS, addressText } from "./scenario.js";
import { bytesToHex, concatBytes, hexToBytes, sha256 } from "@cascade/shared";

const NOW = 1_800_000_000_000;
function node(over: Partial<SettledNode>): SettledNode {
  return {
    nodeId: "n",
    treeId: "t",
    agent: "agentA",
    category: "research",
    buyerVkh: "b1",
    buyerStake: null,
    operatorVkh: "op",
    payeeVkh: "op",
    payeeStake: "s-op",
    fee: 5_000_000n,
    submitted: true,
    delivered: true,
    disputeLost: false,
    feePaid: 5_000_000n,
    endedAt: NOW,
    ...over,
  };
}

describe("reputation (PRD 12.2, 12.3)", () => {
  const params = { ...DEFAULT_REPUTATION_PARAMS, now: NOW };

  it("scores a diverse, reliable agent above one with lost disputes", () => {
    const good = [1, 2, 3, 4, 5, 6].map((i) => node({ nodeId: `g${i}`, buyerVkh: `b${i % 3}` }));
    const bad = [1, 2, 3, 4, 5, 6].map((i) => node({ nodeId: `x${i}`, agent: "agentB", buyerVkh: `b${i % 3}`, delivered: i % 2 === 0, disputeLost: i % 2 === 1, feePaid: 0n }));
    const rows = computeReputation([...good, ...bad], [], params);
    const a = rows.find((r) => r.agent_asset_id === "agentA")!;
    const b = rows.find((r) => r.agent_asset_id === "agentB")!;
    expect(a.delivery_rate).toBe(1);
    expect(b.dispute_loss_rate).toBe(0.5);
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.buyer_diversity).toBe(3);
  });

  it("caps agents served by fewer than 3 buyers and starts new agents near the neutral prior", () => {
    const one = computeReputation([node({})], [], params)[0]!;
    expect(one.confidence).toBeCloseTo(1 / 6, 5);
    expect(Math.abs(one.score - 0.5)).toBeLessThan(0.1);
    const many = computeReputation(Array.from({ length: 50 }, (_, i) => node({ nodeId: `m${i}` })), [], params)[0]!;
    expect(many.score).toBeLessThanOrEqual(0.6 + 1e-9);
  });

  it("drops self-dealing nodes (operator is the buyer or the payee shares the buyer's stake key)", () => {
    expect(isSelfDealing(node({ operatorVkh: "b1" }))).toBe(true);
    expect(isSelfDealing(node({ buyerStake: "s-op" }))).toBe(true);
    expect(computeReputation([node({ operatorVkh: "b1" })], [], params)).toEqual([]);
  });

  it("decays old history", () => {
    const old = computeReputation([node({ endedAt: NOW - 365 * 24 * 3600 * 1000 })], [], params)[0]!;
    const fresh = computeReputation([node({})], [], params)[0]!;
    expect(old.confidence).toBeLessThan(fresh.confidence);
  });

  it("builds a Merkle snapshot with verifiable proofs", () => {
    const rows = computeReputation(["a", "b", "c"].map((agent) => node({ agent, nodeId: agent })), [], params);
    const root = snapshotRoot(rows);
    rows.forEach((r, i) => {
      let h = snapshotLeaf(r);
      for (const step of snapshotProof(rows, i)) {
        const sib = hexToBytes(step.sibling);
        h = sha256(concatBytes(new Uint8Array([1]), step.sibling_on_left ? sib : h, step.sibling_on_left ? h : sib));
      }
      expect(bytesToHex(h)).toBe(root);
    });
  });
});

describe("tx preview", () => {
  it("describes a Submit on a known node in plain language", () => {
    const d = childDatum();
    const ref = `${"a".repeat(64)}#0`;
    const tracked = new Map<string, TrackedUtxo>([[ref, { kind: "node", outRef: ref, nodeId: CHILD_ID, treeId: TREE_ID, datum: d, lovelace: 32_000_000n }]]);
    const cbor = buildTxCbor({
      inputs: [ref, `${"b".repeat(64)}#1`],
      outputs: [
        { address: scriptAddress(NODE_HASH), lovelace: 32_000_000n, assets: { [`${NODE_HASH}.${CHILD_ID}`]: 1n }, datum: encodeNodeDatum({ ...d, state: "Submitted", result_hash: "cd".repeat(32) }) },
        { address: keyAddress("12".repeat(28)), lovelace: 1_500_000n },
      ],
      fee: 250_000n,
      withdrawals: [{ scriptHash: LOGIC_CORE, amount: 0n }],
      redeemers: [{ tag: 3, index: 0, data: toCbor(new Constr(0, [NODE_HASH, actionsToData([{ type: "Submit", node_in: 0n, node_out: 0n, result_hash: "cd".repeat(32) }])])) }],
      ttl: 1_000n,
    });
    const p = previewTx(cbor, { scripts: SCRIPTS, tracked, configs: new Map(), addressText, decimalsOf: () => 6, tipSlot: 100, horizonSlots: 300 });
    expect(p.actions).toEqual([{ type: "Submit", node_id: CHILD_ID, text: expect.stringContaining("Submit the result of node") }]);
    expect(p.summary).toContain("Network fee 0.25 ADA");
    expect(p.moves).toContainEqual({ to: keyAddress("12".repeat(28)), value: { asset: "lovelace", amount: "1500000" } });
    expect(p.warnings.some((w) => w.includes("horizon"))).toBe(true);
    expect(p.summary).not.toMatch(/—/);
  });

  it("formats USDM and ADA with decimals", () => {
    expect(formatAmount("lovelace", 1_234_500n, 6)).toBe("1.2345 ADA");
    expect(formatAmount("e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d", 5_000_000n, 6)).toBe("5 USDM");
  });
});
