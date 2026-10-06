/** Cross-language test vectors (TypeScript, Aiken, Python). Regenerate with `pnpm vectors`. */
import { be16, be32, bytesToHex, concatBytes, hexToBytes } from "../src/bytes.js";
import { encodeLogicRedeemer, encodeBondDatum, encodeNodeDatum, encodePlanLeaf, encodeTreeConfig, encodeWithdrawRedeemer } from "../src/codec.js";
import { childTokenName, configTokenName, rootTokenName } from "../src/ids.js";
import { acceptanceBytes, acceptanceHash, merkleProof, merkleRoot, planLeafBytes, planLeafHash } from "../src/merkle.js";
import { logicScriptOf, type PlanLeaf } from "../src/types.js";
import { NODE_HASH, allActions, bondDatum, receiptNode, rootNode, treeConfig } from "./fixtures.js";
import { ACCEPTANCES, vectorLeaves } from "./leaves.js";

const leafJson = (l: PlanLeaf) => ({ ...l, max_budget: l.max_budget.toString(), max_fee: l.max_fee.toString() });

export function computeVectors() {
  const seeds = [
    { transaction_id: "00".repeat(32), output_index: 0 },
    { transaction_id: "ab".repeat(32), output_index: 1 },
    { transaction_id: "0123456789abcdef".repeat(4), output_index: 65535 },
  ];
  const roots = seeds.map((s) => ({
    ...s,
    preimage: bytesToHex(concatBytes(hexToBytes(s.transaction_id), be16(s.output_index))),
    tree_id: rootTokenName({ transaction_id: s.transaction_id, output_index: BigInt(s.output_index) }),
  }));
  const parent = roots[1]?.tree_id ?? "";
  const children = [0, 1, 255, 256, 65536, 4294967295].map((index) => ({
    parent_id: parent,
    child_index: index,
    preimage: bytesToHex(concatBytes(hexToBytes(parent), be32(index))),
    node_id: childTokenName(parent, BigInt(index)),
  }));
  const configs = roots.map((r) => ({ tree_id: r.tree_id, config_name: configTokenName(r.tree_id) }));

  const leaves = vectorLeaves(9);
  const merkle = Array.from({ length: 9 }, (_, k) => {
    const n = k + 1;
    const set = leaves.slice(0, n);
    return {
      leaf_count: n,
      root: merkleRoot(set),
      proofs: set.map((_, i) => ({ index: i, proof: merkleProof(set, i) })),
    };
  });

  return {
    description:
      "Cascade cross-language vectors. Token names per ADR 0001 section 2, plan Merkle per section 3, Plutus Data CBOR per sections 4 and 5. Integers are decimal strings. Leaf i uses spec_hash = sha256(utf8('spec-' + i)), parent_spec_hash = 32 zero bytes for i = 0 else spec_hash of leaf 0, kind = i mod 4, max_budget = 1000000 * (i + 1), max_fee = 100000 * (i + 1) except 0 for AddressPayment, payee_hash = first 28 bytes of sha256(utf8('payee-' + i)) for AddressPayment (i mod 4 = 3) else 28 zero bytes, acceptance_hash = sha256(acceptance_bytes) of [BuyerAccept, ParentAccept, VerifierQuorum(keys 33.., 44.., 55.., k 2), AutoAfterWindow][i mod 4].",
    token_names: { root: roots, child: children, config: configs },
    acceptance: ACCEPTANCES.map((a) => ({ acceptance: a.type === "VerifierQuorum" ? { ...a, k: a.k.toString() } : a, bytes: bytesToHex(acceptanceBytes(a)), hash: acceptanceHash(a) })),
    plan_leaves: leaves.map((l) => ({ leaf: leafJson(l), leaf_bytes: bytesToHex(planLeafBytes(l)), leaf_hash: bytesToHex(planLeafHash(l)), leaf_cbor: encodePlanLeaf(l) })),
    merkle,
    plutus_data: {
      tree_config: encodeTreeConfig(treeConfig),
      node_datum_root: encodeNodeDatum(rootNode),
      node_datum_receipt: encodeNodeDatum(receiptNode),
      bond_datum: encodeBondDatum(bondDatum),
      withdraw_redeemer_all_actions: encodeWithdrawRedeemer(allActions),
      logic_redeemer_core: encodeLogicRedeemer({ node_hash: NODE_HASH, actions: allActions.filter((a) => logicScriptOf(a.type) === "core") }),
      logic_redeemer_draw: encodeLogicRedeemer({ node_hash: NODE_HASH, actions: allActions.filter((a) => logicScriptOf(a.type) === "draw") }),
      logic_redeemer_ext: encodeLogicRedeemer({ node_hash: NODE_HASH, actions: allActions.filter((a) => logicScriptOf(a.type) === "ext") }),
    },
  };
}
