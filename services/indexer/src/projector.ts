/**
 * Pure projection of one confirmed transaction onto Cascade state: which node and config UTxOs it
 * creates and spends, and which PRD 17.3 events it produces, with the value each moves.
 *
 * Events are derived from datum transitions and token burns, refined by the decoded logic
 * redeemer when present (ADR 0001 section 1.3). Every event also carries internal ledger `flows`
 * (deposits, payouts, refunds, structural lovelace) so receipts reconcile from events alone.
 */
import { decodeMasumiDatum, masumiIdentifierFromDatum, type Action, type BondDatum, type MasumiDatum, type NodeDatum, type TreeConfig } from "@cascade/shared";
import {
  assetId,
  bondOutputs,
  channelOutputs,
  spentOf,
  type ChannelDatum,
  cascadeActions,
  configOutputs,
  isScriptAddress,
  nodeOutputs,
  paymentCredentialOf,
  outRef,
  type CascadeScripts,
  type ChainTx,
  type TxOutput,
} from "@cascade/service-kit";
import type { EventType } from "@cascade/shared";

export interface TrackedNodeUtxo {
  kind: "node";
  outRef: string;
  nodeId: string;
  treeId: string;
  datum: NodeDatum;
  lovelace: bigint;
}

export interface TrackedConfigUtxo {
  kind: "config";
  outRef: string;
  nodeId: string;
  treeId: string;
  config: TreeConfig;
  lovelace: bigint;
}

export interface TrackedBondUtxo {
  kind: "bond";
  outRef: string;
  /** The node whose dispute can move this bond. */
  nodeId: string;
  treeId: string;
  bond: BondDatum;
  lovelace: bigint;
}

export interface TrackedChannelUtxo {
  kind: "channel";
  outRef: string;
  /** The metered receipt node this channel belongs to. */
  nodeId: string;
  treeId: string;
  channel: ChannelDatum;
  lovelace: bigint;
}

/** An AddressPayment output to the Masumi purchase wallet P (ADR 0001 8.1), awaiting P's lock. */
export interface TrackedPaymentUtxo {
  kind: "payment";
  outRef: string;
  /** The node whose Draw paid P. */
  nodeId: string;
  treeId: string;
  lovelace: bigint;
}

/** A vested_pay lock P created from a tracked payment, or its continuation. */
export interface TrackedMasumiLockUtxo {
  kind: "masumi_lock";
  outRef: string;
  nodeId: string;
  treeId: string;
  /** Out ref of the payment this lock was made from: the Masumi leaf's identity. */
  leafRef: string;
  address: string;
  lock: MasumiDatum;
  lovelace: bigint;
}

export type TrackedUtxo = TrackedNodeUtxo | TrackedConfigUtxo | TrackedBondUtxo | TrackedChannelUtxo | TrackedPaymentUtxo | TrackedMasumiLockUtxo;

export interface CreatedChannel {
  outRef: string;
  datum: ChannelDatum;
  output: TxOutput;
}

export type FlowKind = "deposit" | "fee" | "masumi" | "refund" | "protocol_fee" | "structural_in" | "structural_out" | "structural_returned";

/** One movement of value across the tree boundary. `amount` is in `asset` units. */
export interface Flow {
  kind: FlowKind;
  node_id: string;
  to: string;
  asset: string;
  amount: bigint;
  /** Masumi lock lines: the lock's blockchainIdentifier, rebuilt from its datum (A3). */
  blockchain_identifier?: string;
  /** `masumi` flows: the payment output to P, which keys the leaf's lock and outcome. */
  out_ref?: string;
}

/** The Masumi blockchainIdentifier of a vested_pay lock output, or null when the datum does not decode. */
export function masumiIdentifier(lock: TxOutput): string | null {
  if (lock.datum === null) return null;
  try {
    return masumiIdentifierFromDatum(decodeMasumiDatum(lock.datum), lock.address);
  } catch {
    return null;
  }
}

export interface ProjectedEvent {
  type: EventType;
  treeId: string;
  nodeId: string;
  asset: string;
  amount: bigint;
  payload: Record<string, unknown>;
  flows: Flow[];
}

export interface CreatedNode {
  outRef: string;
  datum: NodeDatum;
  output: TxOutput;
  isNew: boolean;
}

export interface CreatedBond {
  outRef: string;
  datum: BondDatum;
  output: TxOutput;
}

export interface CreatedConfig {
  outRef: string;
  config: TreeConfig;
  output: TxOutput;
}

export type TerminalState = "Refunded" | "Settled";

export interface Projection {
  txId: string;
  createdNodes: CreatedNode[];
  createdConfigs: CreatedConfig[];
  /** Governed bonds (authority = cascade_node hash) this tx creates. */
  createdBonds: CreatedBond[];
  /** Governed metered channels this tx opens or continues (voucher Redeem). */
  createdChannels: CreatedChannel[];
  /** Out refs of tracked UTxOs this tx spends. */
  spent: string[];
  /** Nodes whose token burned, with the terminal state they reached. */
  terminal: { nodeId: string; treeId: string; state: TerminalState }[];
  /** Trees whose config UTxO was consumed. */
  closedTrees: { treeId: string; state: "closed" | "cancelled" }[];
  frozenChanges: { treeId: string; frozen: boolean }[];
  /** AddressPayments to the Masumi purchase wallet P (ADR 0001 8.1). */
  masumiPayments: { outRef: string; nodeId: string; treeId: string; output: TxOutput }[];
  /** vested_pay locks P made from a tracked payment, and their continuations. */
  masumiLocks: { outRef: string; leafRef: string; nodeId: string; treeId: string; lock: MasumiDatum; output: TxOutput; blockchainIdentifier: string | null }[];
  /** Tracked locks that left the script: `Refunded` paid buyer_return_address, `Settled` did not (seller withdrawal). */
  masumiOutcomes: { outRef: string; outcome: TerminalState }[];
  /** Masumi receipt locks, linked off chain as (draw tx id, external_out) (ADR 8 amendment). */
  externalLinks: { nodeId: string; outRef: string; blockchainIdentifier: string | null }[];
  events: ProjectedEvent[];
}

export interface ProjectContext {
  scripts: CascadeScripts;
  /** Tracked UTxOs by out ref (only those this tx may spend need to be present). */
  tracked: ReadonlyMap<string, TrackedUtxo>;
  /** Tree configs by tree id, for trees this tx touches. */
  configs: ReadonlyMap<string, TreeConfig>;
  /** Bech32 of a Plutus address (network aware). */
  addressText: (a: NodeDatum["payee"]) => string;
  /** Recorded external locks of receipt nodes this tx may close (datum `external_ref` is None). */
  externalRefs?: ReadonlyMap<string, { outRef: string; blockchainIdentifier: string | null }>;
  /** Payment key hash of the Masumi purchase wallet P (wallet role `masumi-purchaser`), if any. */
  purchaserKeyHash?: string | null;
}

const ZERO = 0n;

export function emptyProjection(txId: string): Projection {
  return { txId, createdNodes: [], createdConfigs: [], createdBonds: [], createdChannels: [], spent: [], terminal: [], closedTrees: [], frozenChanges: [], masumiPayments: [], masumiLocks: [], masumiOutcomes: [], externalLinks: [], events: [] };
}

/** Which action (if any) claims each spent input index. */
function actionsByInput(actions: Action[] | null): Map<number, Action> {
  const m = new Map<number, Action>();
  if (actions === null) return m;
  for (const a of actions) {
    switch (a.type) {
      case "TopUp":
      case "Draw":
      case "Submit":
      case "Accept":
      case "Challenge":
      case "Escalate":
      case "Freeze":
      case "Unfreeze":
      case "Refund":
      case "Resolve":
      case "CloseRoot":
      case "Cancel":
        m.set(Number(a.node_in), a);
        break;
      case "SettleChild":
      case "CloseReceipt":
        m.set(Number(a.node_in), a);
        break;
      case "FundRoot":
        break;
    }
  }
  return m;
}

export function project(tx: ChainTx, ctx: ProjectContext): Projection {
  const p = emptyProjection(tx.id);
  if (!tx.valid) return p;

  const nodeHash = ctx.scripts.node;
  const createdNodes = nodeOutputs(tx, nodeHash);
  const createdConfigs = configOutputs(tx, ctx.scripts);
  const createdBonds = bondOutputs(tx, ctx.scripts);
  const createdChannels = channelOutputs(tx, ctx.scripts);
  const spentTracked: { index: number; utxo: TrackedUtxo }[] = [];
  tx.inputs.forEach((ref, index) => {
    const t = ctx.tracked.get(ref);
    if (t !== undefined) spentTracked.push({ index, utxo: t });
  });
  if (createdNodes.length === 0 && createdConfigs.length === 0 && createdBonds.length === 0 && createdChannels.length === 0 && spentTracked.length === 0) return p;

  const actions = cascadeActions(tx, ctx.scripts);
  const byInput = actionsByInput(actions);
  const configs = new Map(ctx.configs);
  for (const c of createdConfigs) configs.set(c.config.tree_id, c.config);

  p.spent = spentTracked.map((s) => s.utxo.outRef);
  p.createdConfigs = createdConfigs.map((c) => ({ outRef: outRef(tx.id, c.index), config: c.config, output: c.output }));
  p.createdBonds = createdBonds.map((b) => ({ outRef: outRef(tx.id, b.index), datum: b.datum, output: b.output }));
  p.createdChannels = createdChannels.map((c) => ({ outRef: outRef(tx.id, c.index), datum: c.datum, output: c.output }));

  const spentNodes = new Map<string, { index: number; utxo: TrackedNodeUtxo }>();
  for (const s of spentTracked) if (s.utxo.kind === "node") spentNodes.set(s.utxo.nodeId, { index: s.index, utxo: s.utxo });
  const continued = new Set<string>();

  const assetOf = (treeId: string): string => {
    const c = configs.get(treeId);
    return c === undefined ? "lovelace" : assetId(c.asset);
  };

  // 1. Trees funded in this tx (config output plus its root node output).
  for (const c of createdConfigs) {
    const root = createdNodes.find((n) => n.datum.node_id === c.config.tree_id && n.datum.parent_id === null);
    const budget = root?.datum.budget ?? ZERO;
    const structural = (root?.datum.structural ?? ZERO) + c.output.lovelace;
    const asset = assetId(c.config.asset);
    p.events.push({
      type: "tree.funded",
      treeId: c.config.tree_id,
      nodeId: c.config.tree_id,
      asset,
      amount: budget,
      payload: { plan_root: c.config.plan_root, config_utxo: outRef(tx.id, c.index) },
      flows: [
        { kind: "deposit", node_id: c.config.tree_id, to: "tree", asset, amount: budget },
        { kind: "structural_in", node_id: c.config.tree_id, to: "tree", asset: "lovelace", amount: structural },
      ],
    });
  }

  // 2. Node outputs: continuations and new nodes.
  for (const n of createdNodes) {
    const ref = outRef(tx.id, n.index);
    const prev = spentNodes.get(n.datum.node_id);
    p.createdNodes.push({ outRef: ref, datum: n.datum, output: n.output, isNew: prev === undefined });
    const asset = assetOf(n.datum.tree_id);
    if (prev === undefined) {
      if (n.datum.parent_id === null) continue; // root: covered by tree.funded
      p.events.push({
        type: "node.drawn",
        treeId: n.datum.tree_id,
        nodeId: n.datum.node_id,
        asset,
        amount: n.datum.budget,
        payload: { parent_id: n.datum.parent_id, kind: n.datum.kind, spec_hash: n.datum.spec_hash },
        flows: [],
      });
      continue;
    }
    continued.add(n.datum.node_id);
    p.events.push(...transitionEvents(tx, prev.utxo.datum, n.datum, asset, byInput.get(prev.index)));
    if (prev.utxo.datum.frozen !== n.datum.frozen && n.datum.parent_id === null) {
      p.frozenChanges.push({ treeId: n.datum.tree_id, frozen: n.datum.frozen });
    }
  }

  // 3. Draws that paid key addresses (AddressPayment children, ADR 5.2) and Masumi/metered locks.
  if (actions !== null) {
    for (const a of actions) {
      if (a.type !== "Draw") continue;
      for (const child of a.children) {
        if (child.leaf.kind !== "MasumiReceipt" || child.external_out === null) continue;
        const receipt = createdNodes.find((n) => n.index === Number(child.out));
        const lock = tx.outputs[Number(child.external_out)];
        if (receipt !== undefined) {
          p.externalLinks.push({ nodeId: receipt.datum.node_id, outRef: outRef(tx.id, child.external_out), blockchainIdentifier: lock === undefined ? null : masumiIdentifier(lock) });
        }
      }
      const parentRef = tx.inputs[Number(a.node_in)];
      const parent = parentRef === undefined ? undefined : ctx.tracked.get(parentRef);
      if (parent === undefined || parent.kind !== "node") continue;
      const asset = assetOf(parent.treeId);
      for (const child of a.children) {
        if (child.leaf.kind !== "AddressPayment") continue;
        const out = tx.outputs[Number(child.out)];
        if (out === undefined) continue;
        const amount = asset === "lovelace" ? out.lovelace : (out.assets[asset] ?? ZERO);
        const ref = outRef(tx.id, child.out);
        const cred = paymentCredentialOf(out.address);
        const toPurchaser = ctx.purchaserKeyHash != null && cred?.type === "Key" && cred.hash === ctx.purchaserKeyHash;
        if (toPurchaser) p.masumiPayments.push({ outRef: ref, nodeId: parent.nodeId, treeId: parent.treeId, output: out });
        const flows: Flow[] = [{ kind: toPurchaser ? "masumi" : "fee", node_id: parent.nodeId, to: out.address, asset, amount, ...(toPurchaser ? { out_ref: ref } : {}) }];
        if (asset !== "lovelace") flows.push({ kind: "structural_out", node_id: parent.nodeId, to: out.address, asset: "lovelace", amount: out.lovelace });
        p.events.push({
          type: "node.settled",
          treeId: parent.treeId,
          nodeId: parent.nodeId,
          asset,
          amount,
          payload: { fee_paid: amount.toString(), returned_to_parent: "0" },
          flows,
        });
      }
    }
  }

  // 4. Spent nodes whose token burned: terminal transitions.
  for (const [nodeId, s] of spentNodes) {
    if (continued.has(nodeId)) continue;
    const d = s.utxo.datum;
    const action = byInput.get(s.index);
    const asset = assetOf(d.tree_id);
    const config = configs.get(d.tree_id);
    const parentAfter = d.parent_id === null ? undefined : createdNodes.find((n) => n.datum.node_id === d.parent_id);
    const parentBefore = d.parent_id === null ? undefined : spentNodes.get(d.parent_id)?.utxo.datum;
    // Value that left the tree through this close (ADR 1.5): the parent's `spent` grows by the
    // child's own `spent` plus what this close paid out.
    const parentBudgetDrop =
      parentBefore === undefined || parentAfter === undefined ? null : spentOf(parentAfter.datum) - spentOf(parentBefore) - spentOf(d);
    const held = d.budget - d.committed - spentOf(d);
    const payee = ctx.addressText(d.payee);
    const refundTo = config === undefined ? "buyer_refund" : ctx.addressText(config.buyer_refund);
    const configLovelace = [...spentTracked].find((x) => x.utxo.kind === "config" && x.utxo.treeId === d.tree_id)?.utxo.lovelace ?? ZERO;

    const kind = terminalKind(d, action);
    switch (kind) {
      case "settle": {
        const payeeLovelace = action?.type === "SettleChild" ? action.payee_lovelace : ZERO;
        const feePaid = parentBudgetDrop ?? d.fee;
        p.terminal.push({ nodeId, treeId: d.tree_id, state: "Settled" });
        p.events.push({
          type: "node.settled",
          treeId: d.tree_id,
          nodeId,
          asset,
          amount: feePaid,
          payload: { fee_paid: feePaid.toString(), returned_to_parent: (held - feePaid).toString() },
          flows: [
            { kind: "fee", node_id: nodeId, to: payee, asset, amount: feePaid },
            ...(payeeLovelace > ZERO ? [{ kind: "structural_out" as const, node_id: nodeId, to: payee, asset: "lovelace", amount: payeeLovelace }] : []),
          ],
        });
        break;
      }
      case "refund": {
        p.terminal.push({ nodeId, treeId: d.tree_id, state: "Refunded" });
        const flows: Flow[] = [];
        if (d.parent_id === null) {
          flows.push({ kind: "refund", node_id: nodeId, to: refundTo, asset, amount: held });
          flows.push({ kind: "structural_returned", node_id: nodeId, to: refundTo, asset: "lovelace", amount: d.structural + configLovelace });
        }
        p.events.push({ type: "node.refunded", treeId: d.tree_id, nodeId, asset, amount: held, payload: {}, flows });
        if (d.parent_id === null) p.events.push(treeClosed(d, asset, ZERO, held, d.structural + configLovelace, []));
        break;
      }
      case "resolve": {
        const a = action?.type === "Resolve" ? action : undefined;
        const worker = a?.split.worker ?? parentBudgetDrop ?? ZERO;
        const toParent = a?.split.parent ?? held - worker;
        const payeeLovelace = a?.payee_lovelace ?? ZERO;
        p.terminal.push({ nodeId, treeId: d.tree_id, state: "Settled" });
        const flows: Flow[] = [];
        if (worker > ZERO) flows.push({ kind: "fee", node_id: nodeId, to: payee, asset, amount: worker });
        if (payeeLovelace > ZERO) flows.push({ kind: "structural_out", node_id: nodeId, to: payee, asset: "lovelace", amount: payeeLovelace });
        p.events.push({
          type: "node.resolved",
          treeId: d.tree_id,
          nodeId,
          asset,
          amount: worker,
          payload: { worker: worker.toString(), parent: toParent.toString() },
          flows,
        });
        if (d.parent_id === null) {
          const structural = d.structural + configLovelace - payeeLovelace;
          p.events.push(treeClosed(d, asset, worker, toParent, structural, [
            { kind: "refund", node_id: nodeId, to: refundTo, asset, amount: toParent },
            { kind: "structural_returned", node_id: nodeId, to: refundTo, asset: "lovelace", amount: structural },
          ]));
        }
        break;
      }
      case "receipt": {
        const paid = parentBudgetDrop ?? d.budget;
        const link = ctx.externalRefs?.get(nodeId);
        const ext = d.external_ref === null ? (link?.outRef ?? "") : `${d.external_ref.transaction_id}#${d.external_ref.output_index}`;
        p.terminal.push({ nodeId, treeId: d.tree_id, state: "Settled" });
        const flows: Flow[] = [
          {
            kind: "fee",
            node_id: nodeId,
            to: d.kind === "MasumiReceipt" ? `masumi:${ext}` : `channel:${ext}`,
            asset,
            amount: paid,
            ...(d.kind === "MasumiReceipt" && link?.blockchainIdentifier != null ? { blockchain_identifier: link.blockchainIdentifier } : {}),
          },
        ];
        // Structural lovelace that left the tree: the receipt's own reserve plus its external
        // lovelace, less what the parent's reserve regained in this close. A Masumi lock keeps its
        // min-ADA; a metered channel's min-ADA comes back to the parent (W4's 21.2 tree, Yaci).
        const regained = parentBefore === undefined || parentAfter === undefined ? null : parentAfter.datum.structural - parentBefore.structural;
        const left = regained === null ? (d.kind === "MasumiReceipt" ? d.external_lovelace : ZERO) : d.structural + d.external_lovelace - regained;
        if (left > ZERO) flows.push({ kind: "structural_out", node_id: nodeId, to: `escrow:${ext}`, asset: "lovelace", amount: left });
        p.events.push({
          type: "receipt.closed",
          treeId: d.tree_id,
          nodeId,
          asset,
          amount: paid,
          payload: { external_ref: ext === "" ? `${"0".repeat(64)}#0` : ext },
          flows,
        });
        break;
      }
      case "close_root": {
        const a = action?.type === "CloseRoot" ? action : undefined;
        const bps = config?.protocol_fee_bps ?? ZERO;
        const protocol = ((d.budget - d.fee) * bps) / 10_000n;
        const payeeLovelace = a?.payee_lovelace ?? ZERO;
        // ADR 1.5 F3: the protocol output's lovelace also comes from the root's structural reserve.
        const protocolLovelace = a?.protocol_lovelace ?? ZERO;
        const refunded = held - d.fee - protocol;
        const structural = d.structural + configLovelace - payeeLovelace - protocolLovelace;
        p.terminal.push({ nodeId, treeId: d.tree_id, state: "Settled" });
        const flows: Flow[] = [{ kind: "fee", node_id: nodeId, to: payee, asset, amount: d.fee }];
        if (payeeLovelace > ZERO) flows.push({ kind: "structural_out", node_id: nodeId, to: payee, asset: "lovelace", amount: payeeLovelace });
        if (protocol > ZERO) flows.push({ kind: "protocol_fee", node_id: nodeId, to: config === undefined ? "protocol" : ctx.addressText(config.protocol_fee_address), asset, amount: protocol });
        if (protocolLovelace > ZERO) flows.push({ kind: "structural_out", node_id: nodeId, to: config === undefined ? "protocol" : ctx.addressText(config.protocol_fee_address), asset: "lovelace", amount: protocolLovelace });
        flows.push({ kind: "refund", node_id: nodeId, to: refundTo, asset, amount: refunded });
        flows.push({ kind: "structural_returned", node_id: nodeId, to: refundTo, asset: "lovelace", amount: structural });
        p.events.push({ type: "node.settled", treeId: d.tree_id, nodeId, asset, amount: d.fee, payload: { fee_paid: d.fee.toString(), returned_to_parent: "0" }, flows: [] });
        p.events.push(treeClosed(d, asset, d.fee + protocol, refunded, structural, flows));
        break;
      }
      case "cancel": {
        const structural = d.structural + configLovelace;
        p.terminal.push({ nodeId, treeId: d.tree_id, state: "Refunded" });
        p.events.push(treeClosed(d, asset, ZERO, held, structural, [
          { kind: "refund", node_id: nodeId, to: refundTo, asset, amount: held },
          { kind: "structural_returned", node_id: nodeId, to: refundTo, asset: "lovelace", amount: structural },
        ]));
        break;
      }
    }
  }

  // 5. Masumi leaves (ADR 0001 8.1): P's lock made from a payment, continuations, outcomes.
  for (const s of spentTracked) {
    const u = s.utxo;
    if (u.kind === "payment") {
      const script = configs.get(u.treeId)?.masumi_script_hash ?? null;
      const lock = script === null ? null : firstLock(tx, (o) => isScriptAddress(o.address, script));
      if (lock !== null) p.masumiLocks.push({ ...lock, leafRef: u.outRef, nodeId: u.nodeId, treeId: u.treeId });
    } else if (u.kind === "masumi_lock") {
      const next = firstLock(tx, (o) => o.address === u.address);
      if (next !== null) {
        p.masumiLocks.push({ ...next, leafRef: u.leafRef, nodeId: u.nodeId, treeId: u.treeId });
        continue;
      }
      const back = u.lock.buyer_return_address?.payment_credential;
      const refunded =
        back !== undefined &&
        tx.outputs.some((o) => {
          const c = paymentCredentialOf(o.address);
          return c !== null && c.hash === back.hash && (c.type === "Key") === (back.type === "VerificationKey");
        });
      p.masumiOutcomes.push({ outRef: u.outRef, outcome: refunded ? "Refunded" : "Settled" });
    }
  }

  // 6. Config UTxOs consumed: the tree is closed or cancelled.
  for (const s of spentTracked) {
    if (s.utxo.kind !== "config") continue;
    const rootAction = [...spentNodes.values()].find((n) => n.utxo.nodeId === s.utxo.treeId);
    const a = rootAction === undefined ? undefined : byInput.get(rootAction.index);
    const cancelled = a?.type === "Cancel" || (a?.type === "Refund" && a.parent.type === "RootExit") || rootAction?.utxo.datum.state === "Funded";
    p.closedTrees.push({ treeId: s.utxo.treeId, state: cancelled ? "cancelled" : "closed" });
  }

  return p;
}

function firstLock(tx: ChainTx, at: (o: TxOutput) => boolean): { outRef: string; lock: MasumiDatum; output: TxOutput; blockchainIdentifier: string | null } | null {
  for (const [i, o] of tx.outputs.entries()) {
    if (o.datum === null || !at(o)) continue;
    try {
      return { outRef: outRef(tx.id, i), lock: decodeMasumiDatum(o.datum), output: o, blockchainIdentifier: masumiIdentifier(o) };
    } catch {
      continue;
    }
  }
  return null;
}

type TerminalKind = "settle" | "refund" | "resolve" | "receipt" | "close_root" | "cancel";

function terminalKind(d: NodeDatum, action: Action | undefined): TerminalKind {
  if (action !== undefined) {
    switch (action.type) {
      case "SettleChild":
        return "settle";
      case "Refund":
        return "refund";
      case "Resolve":
        return "resolve";
      case "CloseReceipt":
        return "receipt";
      case "CloseRoot":
        return "close_root";
      case "Cancel":
        return "cancel";
      default:
        break;
    }
  }
  if (d.kind === "MasumiReceipt" || d.kind === "MeteredReceipt") return "receipt";
  if (d.parent_id === null) {
    if (d.state === "Accepted" || d.state === "Submitted") return "close_root";
    if (d.state === "Challenged" || d.state === "Disputed") return "resolve";
    return d.committed === ZERO ? "cancel" : "refund";
  }
  if (d.state === "Accepted" || d.state === "Submitted") return "settle";
  if (d.state === "Challenged" || d.state === "Disputed") return "resolve";
  return "refund";
}

function treeClosed(root: NodeDatum, asset: string, paid: bigint, refunded: bigint, structural: bigint, flows: Flow[]): ProjectedEvent {
  return {
    type: "tree.closed",
    treeId: root.tree_id,
    nodeId: root.node_id,
    asset,
    amount: refunded,
    payload: { paid: paid.toString(), refunded: refunded.toString(), structural_returned_lovelace: structural.toString() },
    flows,
  };
}

function transitionEvents(tx: ChainTx, prev: NodeDatum, next: NodeDatum, asset: string, action: Action | undefined): ProjectedEvent[] {
  const out: ProjectedEvent[] = [];
  const base = { treeId: next.tree_id, nodeId: next.node_id, asset };
  if (next.parent_id === null && next.budget > prev.budget && next.state === prev.state && action?.type !== "Draw") {
    const amount = next.budget - prev.budget;
    out.push({
      ...base,
      type: "tree.funded",
      amount,
      // Same strict payload as the funding event (plan_root, config_utxo); the store fills it from
      // the tree row, since a top-up only references the config UTxO. A top-up is a tree.funded
      // whose config_utxo was created by an earlier transaction.
      payload: {},
      flows: [{ kind: "deposit", node_id: next.node_id, to: "tree", asset, amount }],
    });
  }
  if (prev.state !== next.state) {
    switch (next.state) {
      case "Submitted":
        out.push({ ...base, type: "node.submitted", amount: ZERO, payload: { result_hash: next.result_hash ?? "0".repeat(64) }, flows: [] });
        break;
      case "Challenged": {
        const c = action?.type === "Challenge" ? action : undefined;
        const bond = c === undefined ? undefined : tx.outputs[Number(c.bond_out)];
        // Only a bond whose datum names this node and the cascade_node authority counts (ADR 1.3).
        out.push({
          ...base,
          type: "node.challenged",
          amount: ZERO,
          payload: { reason_hash: c?.reason_hash ?? "0".repeat(64), challenger: c?.challenger ?? "0".repeat(56), bond_lovelace: (bond?.lovelace ?? ZERO).toString() },
          flows: [],
        });
        break;
      }
      case "Accepted":
        out.push({ ...base, type: "node.accepted", amount: ZERO, payload: {}, flows: [] });
        break;
      default:
        break;
    }
  }
  if (prev.frozen !== next.frozen && next.parent_id === null) {
    out.push({ ...base, type: "tree.frozen", amount: ZERO, payload: { frozen: next.frozen }, flows: [] });
  }
  return out;
}
