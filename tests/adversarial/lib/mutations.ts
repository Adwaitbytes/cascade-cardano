/**
 * Single mutations shared by the Yaci suite and the preprod samples (A10 to A13, A19), so both
 * networks run exactly the same offending transactions.
 */
import { merkleProof, type PlanLeaf } from "@cascade/shared";
import type { CaseSpec } from "./runner.js";
import { inputIndex, mapConfigOutput, mapNodeOutput, type RawPlan } from "./raw-tx.js";

export interface Mutation {
  spec: CaseSpec;
  apply: (p: RawPlan) => void;
}

function drawOf(p: RawPlan) {
  const draw = p.redeemer.actions[0];
  if (draw?.type !== "Draw") throw new Error("honest Draw expected");
  return draw;
}

function withoutUnit(assets: Record<string, bigint>, unit: string): Record<string, bigint> {
  return Object.fromEntries(Object.entries(assets).filter(([u]) => u !== unit));
}

function childTokenUnit(p: RawPlan, policyId: string): string {
  const unit = Object.keys(p.mint).find((u) => u.startsWith(policyId));
  if (unit === undefined) throw new Error("honest Draw mints no child token");
  return unit;
}

/** T3, T16, A10: a native child's output goes to a key address. */
export const childOutputToKey = (keyAddress: string): Mutation => ({
  spec: { id: "draw.child_output_to_operator_key", action: "Draw", mutation: "child output address replaced by the operator key address", threats: ["T3", "T16"] },
  apply: (p) => {
    p.outputs[1] = { ...p.outputs[1]!, address: keyAddress };
  },
});

/** T3, T4, A11: child spec, leaf and proof from a plan the buyer did not sign. Same parent spec and caps. */
export const leafOutsidePlan = (rootSpecHash: string, otherRoot: PlanLeaf, otherChild: PlanLeaf): Mutation => {
  const forged: PlanLeaf = { ...otherChild, parent_spec_hash: rootSpecHash };
  const proof = merkleProof([otherRoot, forged], 1);
  return {
    spec: { id: "draw.leaf_outside_plan_root", action: "Draw", mutation: "child spec, leaf and proof taken from a plan the buyer did not sign", threats: ["T3", "T4"] },
    apply: (p) => {
      const draw = drawOf(p);
      const c = draw.children[0]!;
      draw.children[0] = { ...c, leaf: forged, proof };
      mapNodeOutput(p, Number(c.out), (d) => ({ ...d, spec_hash: forged.spec_hash }));
    },
  };
};

/** T6, A12: child dispute_until set so that dispute_until + margin passes the parent's submit_by. */
export const disputeBreaksParentWindow = (disputeUntil: bigint): Mutation => ({
  spec: { id: "draw.dispute_until_breaks_parent_window", action: "Draw", mutation: `child dispute_until set past parent.submit_by - min_safety_margin (${disputeUntil})`, threats: ["T6"] },
  apply: (p) => mapNodeOutput(p, 1, (d) => ({ ...d, dispute_until: disputeUntil })),
});

/** T2: the second child names the first child's output. Needs an honest two-child Draw. */
export const twoChildrenOneOutput = (): Mutation => ({
  spec: { id: "draw.two_children_name_one_output", action: "Draw", mutation: "second ChildDraw.out set to the first child's output index", threats: ["T2"] },
  apply: (p) => {
    const draw = drawOf(p);
    if (draw.children.length !== 2) throw new Error("honest Draw with two children expected");
    draw.children[1] = { ...draw.children[1]!, out: draw.children[0]!.out };
  },
});

/** T1: the child output carries no thread token and none is minted. */
export const childWithoutThreadToken = (policyId: string): Mutation => ({
  spec: { id: "draw.child_output_without_thread_token", action: "Draw", mutation: "child token removed from the child output and from the mint", threats: ["T1"] },
  apply: (p) => {
    const unit = childTokenUnit(p, policyId);
    p.outputs[1] = { ...p.outputs[1]!, assets: withoutUnit(p.outputs[1]!.assets, unit) };
    p.mint = withoutUnit(p.mint, unit);
  },
});

/** T1: the child token is minted but leaves in change instead of the child output. */
export const childTokenToWallet = (policyId: string): Mutation => ({
  spec: { id: "draw.child_token_to_wallet", action: "Draw", mutation: "child token removed from the child output (it leaves in change)", threats: ["T1"] },
  apply: (p) => {
    p.outputs[1] = { ...p.outputs[1]!, assets: withoutUnit(p.outputs[1]!.assets, childTokenUnit(p, policyId)) };
  },
});

/** T7, T9, ADR 1.5 F5: no arbiters and threshold 0 while Native leaves are allowed. Honest tx: FundRoot. */
export const noArbitersWithNativeLeaves = (): Mutation => ({
  spec: { id: "fund_root.no_arbiters_with_native_leaves", action: "FundRoot", mutation: "config arbiters [] and arbiter_threshold 0, Native still allowed", threats: ["T7", "T9"] },
  apply: (p) => mapConfigOutput(p, 1, (c) => ({ ...c, arbiters: [], arbiter_threshold: 0n })),
});

/**
 * T2, T9, T18 (ADR 1.3 finding): a bond spent by a logic withdrawal whose node_hash is fake, with
 * no node mint or burn. Honest tx: Resolve with one bond ruling.
 */
export const bondSlashWithFakeNodeHash = (bondAddress: string): Mutation => ({
  spec: {
    id: "bond.slash_with_fake_node_hash",
    action: "Resolve",
    mutation: "bond spent with only a logic withdrawal whose node_hash is fake; node, parent and config inputs and the node burn removed",
    threats: ["T2", "T9", "T18"],
  },
  apply: (p) => {
    const resolve = p.redeemer.actions[0];
    if (resolve?.type !== "Resolve" || resolve.bonds.length !== 1) throw new Error("honest Resolve with one bond ruling expected");
    const bondInput = p.scriptInputs.find((u) => u.address === bondAddress);
    if (bondInput === undefined) throw new Error("honest Resolve spends no bond");
    const ruling = resolve.bonds[0]!;
    const keep = new Set(ruling.outs.map(Number));
    p.scriptInputs = [bondInput];
    p.outputs = p.outputs.filter((_, i) => keep.has(i));
    p.mint = {};
    p.redeemer = {
      node_hash: "ab".repeat(28),
      actions: [{ ...resolve, bonds: [{ ...ruling, bond_in: inputIndex(p, bondInput), outs: ruling.outs.map((_, i) => BigInt(i)) }] }],
    };
  },
});

/** T5, ADR 1.5 F4: provider signature removed from a pre-timeout Metered close. Honest tx: closeReceipt "both". */
export const meteredEarlyCloseByOperator = (providerVkh: string): Mutation => ({
  spec: { id: "close_receipt.metered_early_close_by_operator", action: "CloseReceipt", mutation: "provider signature removed from a pre-timeout Metered close (operator signs alone)", threats: ["T5"] },
  apply: (p) => {
    if (!p.signers.includes(providerVkh)) throw new Error("honest close is signed by the provider");
    p.signers = p.signers.filter((s) => s !== providerVkh);
  },
});

/** T8: the ParentAccept signature replaced by an unrelated key. Honest tx: accept signed by the approved key. */
export const acceptSignedByStranger = (strangerVkh: string): Mutation => ({
  spec: { id: "accept.signed_by_stranger", action: "Accept", mutation: "ParentAccept signature replaced by an unrelated key", threats: ["T8"] },
  apply: (p) => {
    p.signers = [strangerVkh];
  },
});
