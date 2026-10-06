/**
 * Plain-language preview of an unsigned transaction (PRD 14.7, 17.2 `POST /v1/tx/preview`), shown
 * to a buyer before signing. Decodes the body, the Cascade logic redeemer and the outputs, and
 * names nodes from the indexer's view of the UTxOs the tx spends.
 */
import type { Action, NodeDatum, TreeConfig } from "@cascade/shared";
import { cascadeActions, chainTxFromCbor, nodeOutputs, paymentCredentialOf, type CascadeScripts, type ChainTx } from "@cascade/service-kit";
import type { TrackedUtxo } from "./projector.js";

export interface PreviewMove {
  to: string;
  value: { asset: string; amount: string };
}

export interface TxPreview {
  tx_body_hash: string;
  summary: string;
  actions: { type: Action["type"]; node_id?: string; text: string }[];
  moves: PreviewMove[];
  warnings: string[];
}

const short = (hex: string) => `${hex.slice(0, 8)}…${hex.slice(-4)}`;

export function formatAmount(asset: string, amount: bigint, decimals: number): string {
  if (asset === "lovelace") return `${formatUnits(amount, 6)} ADA`;
  const [policy, name] = asset.split(".") as [string, string];
  const ticker = name === "0014df10745553444d" || name === "0014df105553444d" ? "USDM" : `${short(policy)}.${name}`;
  return `${formatUnits(amount, decimals)} ${ticker}`;
}

function formatUnits(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const v = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac === "" ? "" : `.${frac}`}`;
}

export interface PreviewContext {
  scripts: CascadeScripts;
  tracked: ReadonlyMap<string, TrackedUtxo>;
  configs: ReadonlyMap<string, TreeConfig>;
  addressText: (a: NodeDatum["payee"]) => string;
  decimalsOf: (asset: string) => number;
  /** Current tip slot and horizon, to warn on validity ranges nodes cannot evaluate. */
  tipSlot: number | null;
  horizonSlots: number;
}

export function previewTx(cborHex: string, ctx: PreviewContext): TxPreview {
  let tx: ChainTx;
  try {
    tx = chainTxFromCbor(cborHex);
  } catch {
    throw new PreviewError("tx_cbor is not a Conway transaction");
  }
  return describe(tx, ctx);
}

export class PreviewError extends Error {
  override readonly name = "PreviewError";
}

function nodeAt(tx: ChainTx, ctx: PreviewContext, index: bigint): TrackedUtxo | undefined {
  const ref = tx.inputs[Number(index)];
  return ref === undefined ? undefined : ctx.tracked.get(ref);
}

function describe(tx: ChainTx, ctx: PreviewContext): TxPreview {
  const warnings: string[] = [];
  const actions = cascadeActions(tx, ctx.scripts) ?? [];
  const described: TxPreview["actions"] = [];
  const created = nodeOutputs(tx, ctx.scripts.node);

  const fmt = (treeId: string, amount: bigint): string => {
    const c = ctx.configs.get(treeId);
    const asset = c === undefined ? "lovelace" : c.asset.policy === "" ? "lovelace" : `${c.asset.policy}.${c.asset.name}`;
    return formatAmount(asset, amount, ctx.decimalsOf(asset));
  };

  for (const a of actions) {
    if (a.type === "FundRoot") {
      const root = created.find((n) => n.datum.parent_id === null);
      described.push({
        type: a.type,
        ...(root === undefined ? {} : { node_id: root.datum.node_id }),
        text:
          root === undefined
            ? "Fund a new Cascade tree."
            : `Fund a new tree ${short(root.datum.tree_id)} with a budget of ${fmt(root.datum.tree_id, root.datum.budget)}, of which the orchestrator fee is ${fmt(root.datum.tree_id, root.datum.fee)}.`,
      });
      continue;
    }
    const t = nodeAt(tx, ctx, a.node_in);
    const node = t?.kind === "node" ? t.datum : undefined;
    const id = node?.node_id;
    const name = id === undefined ? "an unknown node" : `node ${short(id)}`;
    const base = id === undefined ? {} : { node_id: id };
    if (t === undefined) warnings.push(`The ${a.type} action spends input ${a.node_in}, which the indexer does not know as a Cascade node.`);
    const tree = node?.tree_id ?? "";
    switch (a.type) {
      case "TopUp":
        described.push({ type: a.type, ...base, text: `Add ${fmt(tree, a.amount)} to the budget of ${name}.` });
        break;
      case "Draw": {
        const total = a.children.reduce((s, c) => s + c.leaf.max_budget, 0n);
        const kinds = a.children.map((c) => c.leaf.kind).join(", ");
        described.push({
          type: a.type,
          ...base,
          text: `Hire ${a.children.length} child${a.children.length === 1 ? "" : "ren"} (${kinds}) from ${name}, each within its plan price cap (caps total ${fmt(tree, total)}).`,
        });
        for (const c of a.children) {
          if (c.leaf.kind !== "AddressPayment") continue;
          const out = tx.outputs[Number(c.out)];
          if (out === undefined) continue;
          const cred = paymentCredentialOf(out.address);
          if (cred?.hash !== c.leaf.payee_hash) warnings.push(`Address payment to ${out.address} does not match the plan payee ${short(c.leaf.payee_hash)}.`);
        }
        break;
      }
      case "Submit":
        described.push({ type: a.type, ...base, text: `Submit the result of ${name} with result hash ${short(a.result_hash)}.` });
        break;
      case "Accept":
        described.push({ type: a.type, ...base, text: `Accept the result of ${name}; its fee becomes payable at settlement.` });
        break;
      case "Challenge":
        described.push({ type: a.type, ...base, text: `Challenge the result of ${name}, posting a challenger bond.` });
        break;
      case "Escalate":
        described.push({ type: a.type, ...base, text: `Escalate the dispute on ${name} to the arbiters.` });
        break;
      case "Resolve":
        described.push({ type: a.type, ...base, text: `Resolve the dispute on ${name}: ${fmt(tree, a.split.worker)} to the worker, ${fmt(tree, a.split.parent)} back to the parent.` });
        break;
      case "Refund":
        described.push({
          type: a.type,
          ...base,
          text: node?.parent_id === null ? `Refund the whole root budget of ${name} to the buyer.` : `Refund ${name}: its whole value returns into its parent node.`,
        });
        break;
      case "SettleChild":
        described.push({ type: a.type, ...base, text: `Settle ${name}: pay its fee of ${node === undefined ? "?" : fmt(tree, node.fee)} and return unused budget to the parent.` });
        break;
      case "CloseReceipt":
        described.push({ type: a.type, ...base, text: `Close the external receipt ${name} and release the parent's commitment.` });
        break;
      case "CloseRoot":
        described.push({ type: a.type, ...base, text: `Close the tree: pay the orchestrator fee and return everything else to the buyer.` });
        break;
      case "Cancel":
        described.push({ type: a.type, ...base, text: `Cancel the tree and return the full budget to the buyer.` });
        break;
      case "Freeze":
        described.push({ type: a.type, ...base, text: `Freeze the tree: no new hires anywhere until unfrozen.` });
        break;
      case "Unfreeze":
        described.push({ type: a.type, ...base, text: `Unfreeze the tree: hiring may resume.` });
        break;
    }
  }

  const moves: PreviewMove[] = [];
  for (const o of tx.outputs) {
    moves.push({ to: o.address, value: { asset: "lovelace", amount: o.lovelace.toString() } });
    for (const [unit, qty] of Object.entries(o.assets)) moves.push({ to: o.address, value: { asset: unit, amount: qty.toString() } });
  }

  if (tx.validTo !== null && ctx.tipSlot !== null && tx.validTo - ctx.tipSlot > ctx.horizonSlots) {
    warnings.push(`The validity range ends ${tx.validTo - ctx.tipSlot} slots after the tip, beyond the ${ctx.horizonSlots}-slot horizon; the node cannot evaluate it.`);
  }
  if (tx.validTo !== null && ctx.tipSlot !== null && tx.validTo < ctx.tipSlot) warnings.push("The validity range has already expired.");
  if (actions.length === 0 && created.length === 0) warnings.push("This transaction runs no Cascade action.");

  const cascadeCount = described.length;
  const summary =
    cascadeCount === 0
      ? `Transaction ${short(tx.id)} with ${tx.inputs.length} inputs and ${tx.outputs.length} outputs; fee ${formatAmount("lovelace", tx.fee, 6)}.`
      : `${described.map((d) => d.text).join(" ")} Network fee ${formatAmount("lovelace", tx.fee, 6)}.`;
  return { tx_body_hash: tx.id, summary, actions: described, moves, warnings };
}
