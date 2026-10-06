/**
 * Rebuilds node outcomes (PRD 12.2) from chain history alone, independently of the indexer's
 * database, for A17: every thread token ever minted under the node policy, its datums, the action
 * that burned it (decoded from the tx's logic redeemer), and the parent's datum before and after.
 */
import { CML } from "@lucid-evolution/lucid";
import { decodeLogicRedeemer, decodeNodeDatum, decodeTreeConfig, plutusAddressToBech32, type LogicRedeemer, type NodeDatum } from "@cascade/shared";
import { ledgerOrder } from "@cascade/sdk";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { assetMintHistory, assetTxs, getTx, policyAssets, txCbor, type ChainTx } from "./chain.js";
import { repoPath } from "./repo.js";
import type { NodeOutcome } from "@cascade/indexer/read";

export interface ChainNodeOutcome {
  nodeId: string;
  treeId: string;
  datum: NodeDatum;
  submitted: boolean;
  kind: "settle" | "refund" | "resolve" | "receipt" | "close_root" | "cancel";
  feePaid: bigint;
  resolvedWorker: bigint | null;
  endedAt: number;
  burnTx: string;
}

const NODE_NAME = /^[0-9a-f]{56}$/;

function withdrawRedeemer(tx: CML.Transaction): string | null {
  const redeemers = tx.witness_set().redeemers();
  if (redeemers === undefined) return null;
  const legacy = redeemers.as_arr_legacy_redeemer();
  if (legacy !== undefined) {
    for (let i = 0; i < legacy.len(); i++) if (legacy.get(i).tag() === CML.RedeemerTag.Reward) return legacy.get(i).data().to_cbor_hex();
  }
  const map = redeemers.as_map_redeemer_key_to_redeemer_val();
  if (map !== undefined) {
    const keys = map.keys();
    for (let i = 0; i < keys.len(); i++) if (keys.get(i).tag() === CML.RedeemerTag.Reward) return map.get(keys.get(i))!.data().to_cbor_hex();
  }
  return null;
}

const txCache = new Map<string, ChainTx>();
const cborCache = new Map<string, string>();

/** A confirmed transaction, fetched from Blockfrost once per process: node histories share most of their txs. */
export async function cachedTx(hash: string): Promise<ChainTx | null> {
  const hit = txCache.get(hash);
  if (hit !== undefined) return hit;
  const t = await getTx(hash);
  if (t !== null) txCache.set(hash, t);
  return t;
}

async function requireTx(hash: string): Promise<ChainTx> {
  const t = await cachedTx(hash);
  if (t === null) throw new Error(`tx ${hash} not on chain`);
  return t;
}

async function cachedCbor(hash: string): Promise<string> {
  const hit = cborCache.get(hash);
  if (hit !== undefined) return hit;
  const cbor = await txCbor(hash);
  cborCache.set(hash, cbor);
  return cbor;
}

/** The logic actions of a Cascade transaction, decoded from its withdraw-zero redeemer, and its inputs in ledger order (what `node_in` indexes). */
export async function logicActions(tx: ChainTx): Promise<{ actions: LogicRedeemer["actions"]; inputs: ChainTx["inputs"] }> {
  const raw = withdrawRedeemer(CML.Transaction.from_cbor_hex(await cachedCbor(tx.hash)));
  return { actions: raw === null ? [] : decodeLogicRedeemer(raw).actions, inputs: ledgerOrder(tx.inputs) };
}

/** The slot at which deployments/preprod.json says the current scripts were deployed. */
export function deploySlot(): number {
  const m = z
    .object({ deployedAt: z.iso.datetime(), slotConfig: z.object({ zeroTime: z.number(), zeroSlot: z.number(), slotLength: z.number() }) })
    .parse(JSON.parse(readFileSync(repoPath("deployments", "preprod.json"), "utf8")));
  return m.slotConfig.zeroSlot + Math.floor((Date.parse(m.deployedAt) - m.slotConfig.zeroTime) / m.slotConfig.slotLength);
}

const datumAt = (outputs: { assets: { unit: string }[]; inlineDatum: string | null }[], unit: string): NodeDatum | null => {
  const o = outputs.find((x) => x.assets.some((a) => a.unit === unit) && x.inlineDatum !== null);
  return o === undefined ? null : decodeNodeDatum(o.inlineDatum!);
};

/** The slot of the tx that minted `unit`, or null if it was never minted. */
async function mintSlot(unit: string): Promise<{ slot: number; tx: ChainTx } | null> {
  const minted = (await assetMintHistory(unit)).find((h) => h.action === "minted");
  if (minted === undefined) return null;
  const tx = await requireTx(minted.txHash);
  return { slot: tx.slot, tx };
}

/** Every node that reached a terminal state, read from chain, in trees funded at or after `fromSlot`. */
export async function terminalNodesFromChain(policyId: string, fromSlot = 0): Promise<ChainNodeOutcome[]> {
  const units = (await policyAssets(policyId)).filter((u) => NODE_NAME.test(u.slice(56)));
  const treeFundSlot = new Map<string, number | null>();
  const fundedSlotOf = async (treeId: string): Promise<number | null> => {
    if (!treeFundSlot.has(treeId)) treeFundSlot.set(treeId, (await mintSlot(policyId + treeId))?.slot ?? null);
    return treeFundSlot.get(treeId) ?? null;
  };
  const out: ChainNodeOutcome[] = [];
  for (const unit of units) {
    const nodeId = unit.slice(56);
    const mintHistory = await assetMintHistory(unit);
    const burnEntry = mintHistory.find((h) => h.action === "burned");
    if (burnEntry === undefined) continue;
    // The root's thread token is minted by FundRoot, so its mint slot is the tree's funding slot.
    const mintedHash = mintHistory.find((h) => h.action === "minted")?.txHash;
    if (mintedHash === undefined) continue;
    const firstDatum = datumAt((await requireTx(mintedHash)).outputs, unit);
    if (firstDatum === null) continue;
    const funded = await fundedSlotOf(firstDatum.tree_id);
    if (funded === null || funded < fromSlot) continue;
    const history = await Promise.all((await assetTxs(unit)).map(requireTx));
    const burn = await requireTx(burnEntry.txHash);
    const datums = history.map((t) => datumAt(t.outputs, unit)).filter((d): d is NodeDatum => d !== null);
    const last = burn.inputs.find((i) => i.assets.some((a) => a.unit === unit) && i.inlineDatum !== null);
    if (last === undefined) continue;
    const d = decodeNodeDatum(last.inlineDatum!);

    const { actions, inputs } = await logicActions(burn);
    const myIndex = BigInt(inputs.findIndex((i) => i.assets.some((a) => a.unit === unit)));
    const action = actions.find((a) => "node_in" in a && a.node_in === myIndex);
    const parentUnit = d.parent_id === null ? null : policyId + d.parent_id;
    const parentBefore = parentUnit === null ? null : datumAt(burn.inputs, parentUnit);
    const parentAfter = parentUnit === null ? null : datumAt(burn.outputs, parentUnit);
    const budgetDrop = parentBefore === null || parentAfter === null ? null : parentAfter.spent - parentBefore.spent - d.spent;

    let kind: ChainNodeOutcome["kind"];
    let feePaid = 0n;
    let resolvedWorker: bigint | null = null;
    switch (action?.type) {
      case "SettleChild":
        kind = "settle";
        feePaid = budgetDrop ?? d.fee;
        break;
      case "Refund":
        kind = "refund";
        break;
      case "Resolve":
        kind = "resolve";
        resolvedWorker = action.split.worker;
        break;
      case "CloseReceipt":
        kind = "receipt";
        feePaid = budgetDrop ?? d.budget;
        break;
      case "CloseRoot":
        kind = "close_root";
        feePaid = d.fee;
        break;
      case "Cancel":
        kind = "cancel";
        break;
      default:
        continue;
    }
    out.push({
      nodeId,
      treeId: d.tree_id,
      datum: d,
      submitted: datums.some((x) => x.state === "Submitted") || d.state === "Submitted" || d.state === "Accepted",
      kind,
      feePaid,
      resolvedWorker,
      endedAt: burn.blockTime * 1000,
      burnTx: burn.hash,
    });
  }
  return out;
}

/** Buyer key and buyer_refund stake per tree, from each tree's config datum on chain. */
export async function treeBuyers(policyId: string, treeIds: Set<string>): Promise<Map<string, { buyerVkh: string; buyerStake: string | null }>> {
  const out = new Map<string, { buyerVkh: string; buyerStake: string | null }>();
  for (const treeId of treeIds) {
    const unit = `${policyId}63${treeId}`;
    const first = (await assetMintHistory(unit)).find((h) => h.action === "minted")?.txHash;
    if (first === undefined) continue;
    const t = await cachedTx(first);
    const o = t?.outputs.find((x) => x.assets.some((a) => a.unit === unit) && x.inlineDatum !== null);
    if (o === undefined) continue;
    const cfg = decodeTreeConfig(o.inlineDatum!);
    const stake = cfg.buyer_refund.stake_credential;
    out.set(treeId, { buyerVkh: cfg.buyer, buyerStake: stake?.type === "Inline" ? stake.credential.hash : null });
  }
  return out;
}

/** The chain-derived outcomes in W3's published `NodeOutcome` shape, for nodes that ended by `asOf`. */
export async function chainOutcomes(policyId: string, asOf: number, fromSlot = 0): Promise<NodeOutcome[]> {
  const ended = (await terminalNodesFromChain(policyId, fromSlot)).filter((n) => n.endedAt <= asOf);
  const buyers = await treeBuyers(policyId, new Set(ended.map((n) => n.treeId)));
  return ended.map((n) => {
    const buyer = buyers.get(n.treeId);
    const settledViaSettle = n.kind === "settle" || n.kind === "close_root";
    return {
      node_id: n.nodeId,
      tree_id: n.treeId,
      spec_hash: n.datum.spec_hash,
      operator_vkh: n.datum.operator,
      payee: plutusAddressToBech32(n.datum.payee, 0),
      buyer_vkh: buyer?.buyerVkh ?? "",
      buyer_stake: buyer?.buyerStake ?? null,
      fee: n.datum.fee.toString(),
      state: n.kind === "refund" || n.kind === "cancel" ? "Refunded" : "Settled",
      submitted: n.submitted,
      settled_via_settle: settledViaSettle,
      resolved_worker: n.resolvedWorker === null ? null : n.resolvedWorker.toString(),
      fee_paid: n.kind === "settle" || n.kind === "close_root" || n.kind === "receipt" ? n.feePaid.toString() : null,
      ended_at: n.endedAt,
    };
  });
}
