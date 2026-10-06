/**
 * Bond authority (ADR 1.3, W1 finding `bond_rejects_logic_withdrawal_alone`). A logic script trusts
 * the `node_hash` in its own redeemer; only the `cascade_node` shell checks it. A bond must move
 * only when the tx also mints or burns under the node policy, which forces the shell to run.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ADA, h32, TreeLab } from "../lib/tree-fixture.js";
import { bondSlashWithFakeNodeHash } from "./lib/mutations.js";
import { runCase } from "./lib/runner.js";

let lab: TreeLab;
let childId: string;

beforeAll(async () => {
  lab = await TreeLab.create();
  const { operator, workerA } = lab.parties;
  const plan = lab.plan("adversarial-bond", 100n * ADA, [{ tag: "child", parent: 0, maxBudget: 20n * ADA, maxFee: 3n * ADA }]);
  const { treeId } = await lab.fund(plan, 60n * ADA, 5n * ADA, 900_000n, 12n * ADA);
  const root = await lab.client.node(treeId);
  const c = lab.nativeChild(plan, 1, workerA, 10n * ADA, 2n * ADA, root.datum.submit_by, { type: "ParentAccept", key: operator.vkh }, 120_000n);
  const drawn = await lab.client.draw(treeId, [c]);
  await lab.submit(drawn);
  childId = drawn.childIds[0]!;
  await lab.submit(await lab.client.submit(childId, h32("bad-result")));
  await lab.submit(await lab.client.challenge({ nodeId: childId, reasonHash: h32("reason"), challenger: operator.vkh, challengerAddress: operator.address }));
}, 900_000);

describe("cascade_bond", () => {
  it("rejects a bond slash run by a logic withdrawal with a fake node_hash and no node mint or burn", async () => {
    const { arbiterA, arbiterB } = lab.parties;
    const m = bondSlashWithFakeNodeHash(lab.client.addresses.bond);
    const result = await runCase(
      m.spec,
      lab.caseContext(),
      async () => {
        const bonds = await lab.client.bonds(childId);
        if (bonds.length !== 1) throw new Error(`expected one challenger bond, found ${bonds.length}`);
        return lab.client.resolve({
          nodeId: childId,
          mode: "ruling",
          split: { worker: 0n, parent: 10n * ADA },
          bonds: [{ bond: bonds[0]!, ruling: "SlashBond" }],
          signers: [arbiterA.vkh, arbiterB.vkh],
        });
      },
      m.apply,
    );
    expect(result.outcome, result.detail).toBe("rejected_by_script");
    // The bond's own check must refuse, whatever the logic run concludes.
    expect(result.detail, "cascade_bond spend must be among the failing validators").toMatch(/spend:\d+/);
  });
});
