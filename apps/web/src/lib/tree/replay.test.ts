import { describe, expect, it } from "vitest";
import type { CascadeEvent } from "@cascade/shared/browser";
import { FIXTURE_CLOSED, FIXTURE_LIVE } from "@/lib/fixtures/tree";
import { describeEvent, replayTree } from "./replay";

const { tree, events, nameOf } = FIXTURE_CLOSED;
const idByName = (name: string): string => {
  for (const [id, n] of nameOf) if (n === name) return id;
  throw new Error(name);
};
const indexOf = (predicate: (e: CascadeEvent) => boolean): number => events.findIndex(predicate);

describe("replayTree", () => {
  it("shows nothing before funding", () => {
    const view = replayTree(tree, events, 0);
    expect([...view.nodes.values()].some((n) => n.visible)).toBe(false);
    expect(view.active).toBeNull();
  });

  it("shows the root funded after the first event", () => {
    const view = replayTree(tree, events, 1);
    const root = view.nodes.get(tree.tree_id);
    expect(root?.visible).toBe(true);
    expect(root?.state).toBe("Funded");
    expect(root?.stateTxId).toBe(events[0]?.tx_id);
    expect(root?.held).toBe(150_000_000n);
  });

  it("moves value down on Draw and back up on Refund", () => {
    const flaky = idByName("Flaky Lisan");
    const refundAt = indexOf((e) => e.type === "node.refunded");
    const before = replayTree(tree, events, refundAt);
    const after = replayTree(tree, events, refundAt + 1);
    expect(before.nodes.get(flaky)?.flow).toMatchObject({ kind: "draw", direction: "down", amount: 15_000_000n });
    expect(after.nodes.get(flaky)?.state).toBe("Refunded");
    expect(after.nodes.get(flaky)?.flow).toMatchObject({ kind: "refund", direction: "up", amount: 15_000_000n });
    expect(after.nodes.get(tree.tree_id)?.held).toBe((before.nodes.get(tree.tree_id)?.held ?? 0n) + 15_000_000n);
    expect(after.active?.type).toBe("node.refunded");
  });

  it("marks Working from the off-chain event without losing the creating tx", () => {
    const at = indexOf((e) => e.type === "node.working") + 1;
    const view = replayTree(tree, events, at);
    const working = [...view.nodes.values()].find((n) => n.state === "Working");
    expect(working?.stateTxId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ends closed with every value accounted for", () => {
    const view = replayTree(tree, events);
    expect(view.closed).toBe(true);
    for (const n of view.nodes.values()) expect(n.held).toBe(0n);
    expect(view.nodes.get(idByName("Flaky Lisan"))?.state).toBe("Refunded");
    expect(view.nodes.get(idByName("Scribe"))?.verdicts).toHaveLength(2);
  });

  it("keeps the live tree open with the root submitted", () => {
    const view = replayTree(FIXTURE_LIVE.tree, FIXTURE_LIVE.events);
    expect(view.closed).toBe(false);
    expect(view.nodes.get(FIXTURE_LIVE.tree.tree_id)?.state).toBe("Submitted");
  });

  it("ignores events undone by a rollback", () => {
    const refundAt = indexOf((e) => e.type === "node.refunded");
    const refund = events[refundAt] as CascadeEvent;
    const rollback: CascadeEvent = {
      type: "chain.rollback",
      event_id: "rb-1",
      tree_id: tree.tree_id,
      node_id: refund.node_id,
      tx_id: refund.tx_id,
      slot: refund.slot,
      confirmations: 0,
      value: refund.value,
      emitted_at: refund.emitted_at + 1,
      payload: { rollback_to_slot: refund.slot - 1, undone_event_ids: [refund.event_id] },
    };
    const log = [...events.slice(0, refundAt + 1), rollback];
    const view = replayTree(tree, log);
    expect(view.rolledBack).toBe(1);
    expect(view.nodes.get(refund.node_id)?.state).not.toBe("Refunded");
  });

  it("uses the snapshot for Disputed, which has no event", () => {
    const scribe = idByName("Scribe");
    const disputed = { ...tree, nodes: tree.nodes.map((n) => (n.node_id === scribe ? { ...n, state: "Disputed" as const } : n)) };
    expect(replayTree(disputed, events).nodes.get(scribe)?.state).toBe("Disputed");
  });

  it("describes events in plain words", () => {
    const refund = events.find((e) => e.type === "node.refunded") as CascadeEvent;
    expect(describeEvent(refund, (id) => nameOf.get(id) ?? id)).toBe("Flaky Lisan missed its deadline and was refunded");
  });
});

describe("spent (ADR 0001 1.5)", () => {
  it("takes a live node's balance from budget - committed - spent", () => {
    const live = FIXTURE_LIVE.tree;
    const root = live.nodes.find((n) => n.parent_id === null);
    if (root === undefined) throw new Error("no root");
    const fromEvents = replayTree(live, FIXTURE_LIVE.events).nodes.get(root.node_id)?.held;
    expect(BigInt(root.budget) - BigInt(root.committed) - BigInt(root.spent ?? "0")).toBe(fromEvents);
    const drifted = { ...live, nodes: live.nodes.map((n) => (n.node_id === root.node_id ? { ...n, spent: (BigInt(n.spent ?? "0") + 1n).toString() } : n)) };
    expect(replayTree(drifted, FIXTURE_LIVE.events).nodes.get(root.node_id)?.held).toBe((fromEvents ?? 0n) - 1n);
  });
});

describe("replacements", () => {
  it("marks the hire after a sibling's refund as its replacement", () => {
    const view = replayTree(tree, events);
    expect(view.nodes.get(idByName("Lisan"))?.replaces).toBe(idByName("Flaky Lisan"));
    expect(view.nodes.get(idByName("Scout"))?.replaces).toBeNull();
  });

  it("prefers a later sibling with the refunded node's spec", () => {
    const flaky = idByName("Flaky Lisan");
    const flakySpec = tree.nodes.find((n) => n.node_id === flaky)?.spec_hash ?? "";
    const lisan = idByName("Lisan");
    const sameSpec = { ...tree, nodes: tree.nodes.map((n) => (n.node_id === lisan ? { ...n, spec_hash: flakySpec } : n)) };
    expect(replayTree(sameSpec, events).nodes.get(lisan)?.replaces).toBe(flaky);
  });
});
