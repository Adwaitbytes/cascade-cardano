/**
 * Rebuilds what a tree looked like after its first `cursor` indexed events. The Tree Explorer, the
 * timeline scrubber and the live view all render from this one pure function, so replay and live
 * mode can never disagree.
 */
import type { CascadeEvent } from "@cascade/shared/browser";
import type { ApiNode, ApiNodeState, Tree } from "@/lib/api/schemas";

/** PRD 14.3 states. `Working` is off-chain (a `node.working` event on a Funded node). */
export const DISPLAY_STATES = ["Funded", "Working", "Submitted", "Challenged", "Disputed", "Accepted", "Refunded", "Settled"] as const;
export type DisplayState = (typeof DISPLAY_STATES)[number];

export type FlowKind = "draw" | "refund" | "settle" | "resolve" | "receipt";

export interface Flow {
  kind: FlowKind;
  direction: "down" | "up";
  amount: bigint;
  asset: string;
  eventId: string;
  txId: string;
}

export interface NodeView {
  node: ApiNode;
  visible: boolean;
  state: DisplayState;
  /** Transaction that set `state`; every badge links to it (PRD 14.7). */
  stateTxId: string | null;
  /** Value this node's UTxO holds right now: its draw, minus what it drew for children, plus returns. */
  held: bigint;
  awaitingInput: boolean;
  verdicts: { verdict: "accept" | "reject"; verifier: string; txId: string }[];
  /** Last value movement on the edge from the parent to this node. */
  flow: Flow | null;
  /** The refunded sibling this node was hired to replace, if any. */
  replaces: string | null;
}

export interface TreeView {
  asset: string;
  nodes: Map<string, NodeView>;
  rootId: string | null;
  frozen: boolean;
  closed: boolean;
  /** Number of events applied. */
  cursor: number;
  /** The event at `cursor - 1`, which the explorer animates. */
  active: CascadeEvent | null;
  /** Distinct L1 transactions seen so far. */
  txCount: number;
  rolledBack: number;
}

const toBig = (amount: string): bigint => BigInt(amount);

function initialView(node: ApiNode): NodeView {
  return { node, visible: false, state: "Funded", stateTxId: null, held: 0n, awaitingInput: false, verdicts: [], flow: null, replaces: null };
}

/** Event ids undone by `chain.rollback` events that are themselves within the applied prefix. */
function undoneIds(events: readonly CascadeEvent[], cursor: number): Set<string> {
  const undone = new Set<string>();
  for (let i = 0; i < cursor; i++) {
    const event = events[i];
    if (event?.type === "chain.rollback") for (const id of event.payload.undone_event_ids) undone.add(id);
  }
  return undone;
}

export function replayTree(tree: Tree, events: readonly CascadeEvent[], cursor: number = events.length): TreeView {
  const applied = Math.max(0, Math.min(cursor, events.length));
  const nodes = new Map<string, NodeView>(tree.nodes.map((n) => [n.node_id, initialView(n)]));
  const root = tree.nodes.find((n) => n.parent_id === null) ?? null;
  const undone = undoneIds(events, applied);
  const txIds = new Set<string>();
  let frozen = false;
  let closed = false;
  let rolledBack = 0;
  // Refunded nodes per parent that have not been replaced yet, in refund order.
  const awaitingReplacement = new Map<string, string[]>();

  const setState = (view: NodeView, state: DisplayState, txId: string): void => {
    view.state = state;
    view.stateTxId = txId;
  };
  const returnToParent = (view: NodeView, amount: bigint, flow: Omit<Flow, "direction">): void => {
    view.held = 0n;
    view.flow = { ...flow, direction: "up" };
    const parent = view.node.parent_id === null ? undefined : nodes.get(view.node.parent_id);
    if (parent !== undefined) parent.held += amount;
  };

  for (let i = 0; i < applied; i++) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.type === "chain.rollback") continue;
    if (undone.has(event.event_id)) {
      rolledBack += 1;
      continue;
    }
    txIds.add(event.tx_id);
    const view = nodes.get(event.node_id);
    if (view === undefined) continue;
    const amount = toBig(event.value.amount);
    const flowBase = { amount, asset: event.value.asset, eventId: event.event_id, txId: event.tx_id };

    switch (event.type) {
      case "tree.funded":
        // A later tree.funded on a funded root is a TopUp: the budget grows by the event value.
        if (view.visible) {
          view.held += amount;
          break;
        }
        view.visible = true;
        view.held = amount;
        setState(view, "Funded", event.tx_id);
        break;
      case "node.drawn": {
        view.visible = true;
        view.held = amount;
        view.flow = { ...flowBase, kind: "draw", direction: "down" };
        setState(view, "Funded", event.tx_id);
        const parent = nodes.get(event.payload.parent_id);
        if (parent !== undefined) parent.held -= amount;
        // ADR 0001 section 3: a re-hire reuses the refunded node's spec. Fall back to the next hire
        // under the same parent when no refunded sibling shares the spec.
        const pending = awaitingReplacement.get(event.payload.parent_id) ?? [];
        if (pending.length > 0) {
          const sameSpec = pending.find((id) => nodes.get(id)?.node.spec_hash === view.node.spec_hash);
          const replaced = sameSpec ?? pending[0];
          if (replaced !== undefined) {
            view.replaces = replaced;
            awaitingReplacement.set(event.payload.parent_id, pending.filter((id) => id !== replaced));
          }
        }
        break;
      }
      case "node.working":
        if (view.state === "Funded") setState(view, "Working", event.tx_id);
        view.awaitingInput = false;
        break;
      case "node.input_requested":
        view.awaitingInput = true;
        break;
      case "node.submitted":
        view.awaitingInput = false;
        setState(view, "Submitted", event.tx_id);
        break;
      case "node.verified":
        view.verdicts.push({ verdict: event.payload.verdict, verifier: event.payload.verifier, txId: event.tx_id });
        break;
      case "node.challenged":
        setState(view, "Challenged", event.tx_id);
        break;
      case "node.resolved":
        setState(view, "Settled", event.tx_id);
        returnToParent(view, toBig(event.payload.parent), { ...flowBase, amount: toBig(event.payload.parent), kind: "resolve" });
        break;
      case "node.accepted":
        setState(view, "Accepted", event.tx_id);
        break;
      case "node.refunded":
        setState(view, "Refunded", event.tx_id);
        returnToParent(view, amount, { ...flowBase, kind: "refund" });
        if (view.node.parent_id !== null) awaitingReplacement.set(view.node.parent_id, [...(awaitingReplacement.get(view.node.parent_id) ?? []), view.node.node_id]);
        break;
      case "node.settled": {
        const returned = toBig(event.payload.returned_to_parent);
        setState(view, "Settled", event.tx_id);
        returnToParent(view, returned, { ...flowBase, amount: returned, kind: "settle" });
        break;
      }
      case "receipt.closed":
        setState(view, "Settled", event.tx_id);
        returnToParent(view, amount, { ...flowBase, kind: "receipt" });
        break;
      case "tree.frozen":
        frozen = event.payload.frozen;
        break;
      case "tree.closed":
        closed = true;
        view.held = 0n;
        setState(view, "Settled", event.tx_id);
        break;
    }
  }

  const complete = applied === events.length;
  if (complete) reconcileWithSnapshot(tree, nodes);

  let active: CascadeEvent | null = null;
  for (let i = applied - 1; i >= 0; i--) {
    const event = events[i];
    if (event !== undefined && event.type !== "chain.rollback" && !undone.has(event.event_id)) {
      active = event;
      break;
    }
  }

  return {
    asset: tree.asset,
    nodes,
    rootId: root?.node_id ?? null,
    frozen: complete ? tree.frozen || frozen : frozen,
    closed: complete ? closed || tree.state !== "open" : closed,
    cursor: applied,
    active,
    txCount: txIds.size,
    rolledBack,
  };
}

/**
 * With every event applied, the chain-confirmed snapshot wins where events cannot express the
 * state (Disputed has no event) or where the event stream has a gap (a node with no draw event).
 */
function reconcileWithSnapshot(tree: Tree, nodes: Map<string, NodeView>): void {
  for (const node of tree.nodes) {
    const view = nodes.get(node.node_id);
    if (view === undefined) continue;
    const lastTx = node.tx_ids.at(-1) ?? null;
    if (!view.visible) {
      view.visible = true;
      view.state = snapshotDisplayState(node.state);
      view.stateTxId = lastTx;
      continue;
    }
    if (node.state === "Disputed" && view.state !== "Disputed") {
      view.state = "Disputed";
      view.stateTxId = lastTx;
    }
    // The chain-confirmed datum is the authority on a live node's balance (ADR 0001 1.5).
    if (node.spent !== undefined && view.state !== "Refunded" && view.state !== "Settled") {
      view.held = BigInt(node.budget) - BigInt(node.committed) - BigInt(node.spent);
    }
  }
}

const snapshotDisplayState = (state: ApiNodeState): DisplayState => state;

/** Short sentence for the scrubber and the event feed. */
export function describeEvent(event: CascadeEvent, nameOf: (nodeId: string) => string): string {
  const who = nameOf(event.node_id);
  switch (event.type) {
    case "tree.funded":
      return "Buyer funded the root";
    case "node.drawn":
      return `${nameOf(event.payload.parent_id)} hired ${who}`;
    case "node.working":
      return `${who} started work`;
    case "node.input_requested":
      return `${who} asked for more input`;
    case "node.submitted":
      return `${who} submitted a result`;
    case "node.verified":
      return `${event.payload.verifier} ${event.payload.verdict === "accept" ? "accepted" : "rejected"} ${who}'s result`;
    case "node.challenged":
      return `${who}'s result was challenged`;
    case "node.resolved":
      return `Dispute on ${who} resolved`;
    case "node.accepted":
      return `${who}'s result was accepted`;
    case "node.refunded":
      return `${who} missed its deadline and was refunded`;
    case "node.settled":
      return `${who} was paid and settled`;
    case "receipt.closed":
      return `${who}'s external escrow closed`;
    case "tree.frozen":
      return event.payload.frozen ? "Buyer froze the tree" : "Buyer unfroze the tree";
    case "tree.closed":
      return "Root closed and settled";
    case "chain.rollback":
      return `Chain rolled back to slot ${event.payload.rollback_to_slot.toLocaleString("en-US")}`;
  }
}
