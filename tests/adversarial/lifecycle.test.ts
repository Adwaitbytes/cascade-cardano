/**
 * One or more single-field mutations for every redeemer after Draw, plus global checks and the
 * channel Redeem, on the local devnet. Each `it` builds the honest SDK tx for the tree's current
 * state, runs its mutations (all must be refused by the node for a script failure), then submits
 * the honest tx so the next `it` starts from the following state. Tests run in file order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { CML, Data } from "@lucid-evolution/lucid";
import { bytesToHex, decodeChannelRedeemer, encodeChannelRedeemer, signVoucher } from "@cascade/shared";
import type { BuiltTx } from "@cascade/sdk";
import { waitUntilAfter } from "../lib/devnet.js";
import { ADA, h32, TreeLab, type Plan } from "../lib/tree-fixture.js";
import { inputIndex, mapNodeOutput, refKey, type RawPlan } from "./lib/raw-tx.js";
import { acceptSignedByStranger } from "./lib/mutations.js";
import { runCase, type CaseSpec } from "./lib/runner.js";

let lab: TreeLab;
let plan: Plan;

/** Runs every mutation against the same honest tx; each must be refused by a script. */
async function expectAllRejected(honest: () => Promise<BuiltTx>, cases: [CaseSpec, (p: RawPlan) => void][]): Promise<BuiltTx> {
  const built = await honest();
  for (const [spec, apply] of cases) {
    const result = await runCase(spec, lab.caseContext(), async () => built, apply);
    expect(result.outcome, `${spec.id}: ${result.detail}`).toBe("rejected_by_script");
  }
  return built;
}

const spec = (id: string, action: string, mutation: string, threats: string[]): CaseSpec => ({ id, action, mutation, threats });

function lovelaceShift(p: RawPlan, index: number, delta: bigint): void {
  const out = p.outputs[index]!;
  p.outputs[index] = { ...out, assets: { ...out.assets, lovelace: (out.assets.lovelace ?? 0n) + delta } };
}

function dropUnit(record: Record<string, bigint>, unit: string): Record<string, bigint> {
  return Object.fromEntries(Object.entries(record).filter(([u]) => u !== unit));
}

const VOID_DATUM = Data.void();

async function rootSubmitBy(id: string): Promise<bigint> {
  return (await lab.client.node(id)).datum.submit_by;
}

beforeAll(async () => {
  lab = await TreeLab.create();
  plan = lab.plan("adversarial-lifecycle", 100n * ADA, [
    { tag: "challenged", parent: 0, maxBudget: 10n * ADA, maxFee: 2n * ADA },
    { tag: "settled", parent: 0, maxBudget: 10n * ADA, maxFee: 2n * ADA },
    { tag: "refunded", parent: 0, maxBudget: 10n * ADA, maxFee: 2n * ADA },
    { tag: "metered", parent: 0, kind: "MeteredReceipt", maxBudget: 4n * ADA, maxFee: 0n },
  ]);
}, 900_000);

describe("root-only actions and global checks (tree T2, ends in Cancel)", () => {
  let t2: string;
  let other: string;

  beforeAll(async () => {
    t2 = (await lab.fund(plan, 20n * ADA, 2n * ADA, 900_000n, 12n * ADA)).treeId;
    other = (await lab.fund(plan, 20n * ADA, 2n * ADA, 900_000n, 12n * ADA)).treeId;
  }, 900_000);

  it("TopUp and global checks", async () => {
    const otherRoot = await lab.client.node(other);
    const honest = await expectAllRejected(() => lab.client.topUp(t2, 1n * ADA), [
      [spec("top_up.budget_grows_more_than_paid", "TopUp", "root datum budget raised by amount + 1 lovelace", ["T4"]), (p) => mapNodeOutput(p, 0, (d) => ({ ...d, budget: d.budget + 1n }))],
      [spec("top_up.not_signed_by_buyer", "TopUp", "buyer removed from required signers", ["T16"]), (p) => (p.signers = [])],
      [
        spec("global.extra_mint", "TopUp", "one extra token minted under the node policy, sent to change", ["T1", "T2"]),
        (p) => (p.mint = { ...p.mint, [lab.client.policyId + "ff".repeat(28)]: 1n }),
      ],
      [spec("global.no_logic_withdrawal", "TopUp", "logic withdrawal removed (node spent with no logic run)", ["T18"]), (p) => (p.logicReward = null)],
      [
        spec("global.unclaimed_cascade_input", "TopUp", "a second tree's root spent in the same tx without an action", ["T2"]),
        (p) => {
          p.scriptInputs = [...p.scriptInputs, otherRoot.utxo];
          const topUp = p.redeemer.actions[0];
          if (topUp?.type !== "TopUp") throw new Error("TopUp expected");
          topUp.node_in = inputIndex(p, p.scriptInputs[0]!);
        },
      ],
    ]);
    await lab.submit(honest);
  });

  it("Freeze", async () => {
    const honest = await expectAllRejected(() => lab.client.freeze(t2), [
      [spec("freeze.not_signed_by_buyer", "Freeze", "buyer removed from required signers", ["T16"]), (p) => (p.signers = [])],
      [spec("freeze.changes_more_than_frozen", "Freeze", "datum fee lowered by 1 lovelace beside frozen = True", ["T4"]), (p) => mapNodeOutput(p, 0, (d) => ({ ...d, fee: d.fee - 1n }))],
    ]);
    await lab.submit(honest);
  });

  it("Unfreeze", async () => {
    const honest = await expectAllRejected(() => lab.client.unfreeze(t2), [
      [spec("unfreeze.not_signed_by_buyer", "Unfreeze", "buyer removed from required signers", ["T16"]), (p) => (p.signers = [])],
    ]);
    await lab.submit(honest);
  });

  it("Cancel", async () => {
    const configUnit = (p: RawPlan) => Object.keys(p.mint).find((u) => u.startsWith(lab.client.policyId) && u.length > 56 + 56);
    const honest = await expectAllRejected(() => lab.client.cancel(t2), [
      [spec("cancel.refund_short", "Cancel", "1 ADA taken from the buyer_refund output (left in change)", ["T4"]), (p) => lovelaceShift(p, 0, -1n * ADA)],
      [spec("cancel.refund_carries_datum", "Cancel", "buyer_refund output tagged with an inline datum (ADR 1.6 E1)", ["T2"]), (p) => (p.outputs[0] = { ...p.outputs[0]!, datum: VOID_DATUM })],
      [
        spec("cancel.config_token_not_burned", "Cancel", "config token burn removed (token leaves in change)", ["T1"]),
        (p) => {
          const unit = configUnit(p);
          if (unit === undefined) throw new Error("honest Cancel burns no config token");
          p.mint = dropUnit(p.mint, unit);
        },
      ],
      [spec("cancel.not_signed_by_buyer", "Cancel", "buyer removed from required signers", ["T16"]), (p) => (p.signers = [])],
    ]);
    await lab.submit(honest);
  });
});

describe("child lifecycle (tree T)", () => {
  let treeId: string;
  let challenged: string;
  let settled: string;
  let refunded: string;
  let receipt: string;
  const payer = CML.PrivateKey.generate_ed25519();
  const payerSecret = payer.to_raw_bytes();
  const payerVkey = bytesToHex(payer.to_public().to_raw_bytes());

  beforeAll(async () => {
    const { workerA, workerB, seller, operator } = lab.parties;
    treeId = (await lab.fund(plan, 60n * ADA, 5n * ADA, 1_200_000n, 20n * ADA, { allowed_leaf_kinds: ["Native", "MeteredReceipt", "AddressPayment"] })).treeId;
    const parentSubmitBy = await rootSubmitBy(treeId);
    const accept = { type: "ParentAccept" as const, key: operator.vkh };
    const metered = lab.nativeChild(plan, 4, workerA, 4n * ADA, 0n, parentSubmitBy, accept, 300_000n);
    const drawn = await lab.client.draw(treeId, [
      lab.nativeChild(plan, 1, workerA, 10n * ADA, 2n * ADA, parentSubmitBy, accept, 300_000n),
      lab.nativeChild(plan, 2, workerB, 10n * ADA, 2n * ADA, parentSubmitBy, accept, 300_000n),
      lab.nativeChild(plan, 3, workerB, 10n * ADA, 2n * ADA, parentSubmitBy, accept, 5_000n),
      {
        kind: "metered",
        leaf: metered.leaf,
        proof: metered.proof,
        operator: workerA.vkh,
        payee: seller.plutus,
        budget: 4n * ADA,
        input_hash: h32("lifecycle-metered"),
        acceptance: accept,
        submit_by: metered.submit_by,
        challenge_until: metered.challenge_until,
        refund_after: metered.refund_after,
        dispute_until: metered.dispute_until,
        payerVkey,
        timeout: metered.submit_by,
      },
    ]);
    await lab.submit(drawn);
    [challenged, settled, refunded, receipt] = drawn.childIds as [string, string, string, string];
  }, 900_000);

  it("Submit", async () => {
    const honest = await expectAllRejected(() => lab.client.submit(challenged, h32("bad result")), [
      [spec("submit.not_signed_by_operator", "Submit", "operator removed from required signers", ["T16"]), (p) => (p.signers = [])],
      [spec("submit.state_skips_to_accepted", "Submit", "output state Accepted instead of Submitted", ["T6"]), (p) => mapNodeOutput(p, 0, (d) => ({ ...d, state: "Accepted" }))],
    ]);
    await lab.submit(honest);
  });

  it("Accept", async () => {
    const { seller, operator } = lab.parties;
    const stranger = acceptSignedByStranger(seller.vkh);
    await expectAllRejected(() => lab.client.accept(challenged, [operator.vkh]), [
      [stranger.spec, stranger.apply],
      [spec("accept.raises_fee", "Accept", "output fee raised by 1 lovelace beside state Accepted", ["T4"]), (p) => mapNodeOutput(p, 0, (d) => ({ ...d, fee: d.fee + 1n }))],
    ]);
  });

  it("Challenge", async () => {
    const { operator } = lab.parties;
    const honest = await expectAllRejected(
      () => lab.client.challenge({ nodeId: challenged, reasonHash: h32("reason"), challenger: operator.vkh, challengerAddress: operator.address }),
      [
        [spec("challenge.not_signed_by_challenger", "Challenge", "challenger removed from required signers", ["T7"]), (p) => (p.signers = [])],
        [
          spec("challenge.bond_below_minimum", "Challenge", "bond output 1 lovelace below config.challenge_bond", ["T7"]),
          (p) => {
            const c = p.redeemer.actions[0];
            if (c?.type !== "Challenge") throw new Error("Challenge expected");
            lovelaceShift(p, Number(c.bond_out), -1n);
          },
        ],
      ],
    );
    await lab.submit(honest);
  });

  it("Escalate", async () => {
    await expectAllRejected(() => lab.client.escalate(challenged), [
      [spec("escalate.not_signed_by_operator", "Escalate", "node operator removed from required signers", ["T7"]), (p) => (p.signers = [])],
      [spec("escalate.state_accepted", "Escalate", "output state Accepted instead of Disputed", ["T7"]), (p) => mapNodeOutput(p, 0, (d) => ({ ...d, state: "Accepted" }))],
    ]);
  });

  it("Resolve", async () => {
    const { arbiterA, arbiterB, seller } = lab.parties;
    const honest = await expectAllRejected(
      async () => {
        const bonds = await lab.client.bonds(challenged);
        if (bonds.length !== 1) throw new Error(`expected one bond, found ${bonds.length}`);
        return lab.client.resolve({ nodeId: challenged, mode: "ruling", split: { worker: 0n, parent: 10n * ADA }, bonds: [{ bond: bonds[0]!, ruling: "ReturnBond" }], signers: [arbiterA.vkh, arbiterB.vkh] });
      },
      [
        [spec("resolve.below_arbiter_threshold", "Resolve", "one of two required arbiter signatures removed", ["T9"]), (p) => (p.signers = [arbiterA.vkh])],
        [
          spec("resolve.bond_returned_to_stranger", "Resolve", "ReturnBond output sent to another key instead of the bond owner", ["T7", "T9"]),
          (p) => {
            const r = p.redeemer.actions[0];
            if (r?.type !== "Resolve" || r.bonds.length !== 1) throw new Error("Resolve with one bond expected");
            const out = Number(r.bonds[0]!.outs[0]);
            p.outputs[out] = { ...p.outputs[out]!, address: seller.address };
          },
        ],
      ],
    );
    await lab.submit(honest);
  });

  it("SettleChild", async () => {
    const { operator } = lab.parties;
    await lab.submit(await lab.client.submit(settled, h32("good result")));
    await lab.submit(await lab.client.accept(settled, [operator.vkh]));
    const payeeOut = (p: RawPlan) => {
      const a = p.redeemer.actions[0];
      if (a?.type !== "SettleChild") throw new Error("SettleChild expected");
      return Number(a.payee_out);
    };
    const childUnit = lab.client.policyId + settled;
    const honest = await expectAllRejected(() => lab.client.settleChild(settled), [
      [spec("settle_child.payee_short", "SettleChild", "payee output 1 lovelace short of the fee (left in change)", ["T4"]), (p) => lovelaceShift(p, payeeOut(p), -1n)],
      [spec("settle_child.payee_carries_datum", "SettleChild", "payee output tagged with an inline datum (ADR 1.6 E1)", ["T2"]), (p) => (p.outputs[payeeOut(p)] = { ...p.outputs[payeeOut(p)]!, datum: VOID_DATUM })],
      [spec("settle_child.token_not_burned", "SettleChild", "child token burn removed (token leaves in change)", ["T1"]), (p) => (p.mint = dropUnit(p.mint, childUnit))],
    ]);
    await lab.submit(honest);
  });

  it("Refund", async () => {
    await waitUntilAfter(lab.client.lucid, (await lab.client.node(refunded)).datum.refund_after);
    const childUnit = lab.client.policyId + refunded;
    const honest = await expectAllRejected(() => lab.client.refund(refunded), [
      [spec("refund.parent_short", "Refund", "parent output 1 ADA short of the returned child value (left in change)", ["T4"]), (p) => lovelaceShift(p, 0, -1n * ADA)],
      [spec("refund.token_not_burned", "Refund", "child token burn removed (token leaves in change)", ["T1"]), (p) => (p.mint = dropUnit(p.mint, childUnit))],
    ]);
    await lab.submit(honest);
  });

  it("channel Redeem", async () => {
    const amount = 1n * ADA;
    const signature = signVoucher(payerSecret, treeId, receipt, amount);
    const honest = await expectAllRejected(() => lab.client.redeemChannels([{ receiptId: receipt, amount, signature }]), [
      [
        spec("channel.redeem_above_voucher", "Redeem", "redeemer amount raised 1 lovelace above the signed voucher", ["T5"]),
        (p) => {
          const ch = p.scriptInputs[0]!;
          const r = decodeChannelRedeemer(p.spendRedeemers[refKey(ch)]!);
          if (r.type !== "Redeem") throw new Error("Redeem expected");
          p.spendRedeemers[refKey(ch)] = encodeChannelRedeemer({ ...r, amount: r.amount + 1n });
        },
      ],
      [
        spec("channel.payout_above_claim", "Redeem", "1 ADA moved from the continuing channel to the provider payout", ["T5"]),
        (p) => {
          lovelaceShift(p, 0, -1n * ADA);
          lovelaceShift(p, 1, 1n * ADA);
        },
      ],
    ]);
    await lab.submit(honest);
    await lab.submit(await lab.client.closeReceipt(receipt, "both"));
  });

  it("CloseRoot", async () => {
    const { buyer } = lab.parties;
    await lab.submit(await lab.client.submit(treeId, h32("root result")));
    await lab.submit(await lab.client.accept(treeId, [buyer.vkh]));
    const refundOut = (p: RawPlan) => {
      const a = p.redeemer.actions[0];
      if (a?.type !== "CloseRoot") throw new Error("CloseRoot expected");
      return [Number(a.payee_out), Number(a.refund_out)] as const;
    };
    const honest = await expectAllRejected(() => lab.client.closeRoot(treeId), [
      [
        spec("close_root.payee_overpaid", "CloseRoot", "1 ADA moved from the buyer refund to the operator payee", ["T4"]),
        (p) => {
          const [payee, refund] = refundOut(p);
          lovelaceShift(p, payee, 1n * ADA);
          lovelaceShift(p, refund, -1n * ADA);
        },
      ],
      [spec("close_root.refund_carries_datum", "CloseRoot", "buyer_refund output tagged with an inline datum (ADR 1.6 E1)", ["T2"]), (p) => (p.outputs[refundOut(p)[1]] = { ...p.outputs[refundOut(p)[1]]!, datum: VOID_DATUM })],
      [spec("close_root.early_without_buyer", "CloseRoot", "buyer signature removed before challenge_until", ["T6"]), (p) => (p.signers = p.signers.filter((s) => s !== buyer.vkh))],
    ]);
    await lab.submit(honest);
  });
});
