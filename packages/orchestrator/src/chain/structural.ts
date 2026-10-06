/**
 * Exact structural lovelace for a plan (PRD 7.8), from the SDK's own min-UTxO sizing instead of a
 * flat per-node estimate. A node's reserve covers its own output at its largest datum, plus what
 * each child takes from it at Draw: a native child's whole subtree reserve, a Metered receipt's
 * own reserve plus the lovelace its channel needs once fully redeemed. An address payment (and a
 * Masumi purchase through P, ADR 8.1) takes nothing.
 */
import type { CascadeClient } from "@cascade/sdk";
import { channelTokenName, encodeChannelDatum, minUtxoForOutput, type AssetClass, type NodeDatum, type NodeKind, type Plan, type PlutusAddress } from "@cascade/shared";
import { assetClassOf } from "./buyer-tx.js";
import { acceptanceForSpec } from "./sdk-chain.js";

type PlanNode = Plan["root"];

const KEY = "ee".repeat(28);
const ID = "dd".repeat(28);
const HASH = "cc".repeat(32);
/** Largest deadlines the tree can hold (13-digit POSIX ms). */
const FAR = 9_999_999_999_999n;
/** Worst-case payee: a base address (payment key and stake key). */
const PAYEE: PlutusAddress = { payment_credential: { type: "VerificationKey", hash: KEY }, stake_credential: { type: "Inline", credential: { type: "VerificationKey", hash: KEY } } };

function worstDatum(node: PlanNode, kind: NodeKind, depth: number): NodeDatum {
  const spec = node.spec;
  return {
    tree_id: ID,
    node_id: ID,
    parent_id: depth === 0 ? null : ID,
    depth: BigInt(depth),
    next_child: 0n,
    operator: KEY,
    payee: PAYEE,
    kind,
    budget: BigInt(spec.price.max_budget),
    fee: BigInt(spec.price.max_fee),
    committed: 0n,
    children_open: 0n,
    structural: 0n,
    external_lovelace: 0n,
    spec_hash: HASH,
    input_hash: HASH,
    result_hash: null,
    acceptance: spec.acceptance === "BuyerAccept" ? { type: "BuyerAccept", key: KEY } : acceptanceForSpec(spec, KEY),
    submit_by: FAR,
    challenge_until: FAR,
    refund_after: FAR,
    dispute_until: FAR,
    external_ref: null,
    frozen: false,
    state: "Funded",
    spent: 0n,
  };
}

/** Lovelace a Metered receipt's channel carries beside the deposit (min-UTxO once fully redeemed). */
function channelLovelace(client: CascadeClient, asset: AssetClass, receipt: NodeDatum, coinsPerUtxoByte: bigint): bigint {
  const drained = encodeChannelDatum({
    authority: client.scripts.nodeHash,
    tree_id: receipt.tree_id,
    node_id: receipt.node_id,
    payer_vkey: HASH,
    provider: KEY,
    provider_address: PAYEE,
    asset,
    deposit: receipt.budget,
    redeemed: receipt.budget,
    timeout: FAR,
  });
  const token = { [client.policyId + channelTokenName(receipt.node_id)]: 1n };
  const lovelaceTree = asset.policy === "" && asset.name === "";
  const assets = lovelaceTree ? token : { ...token, [asset.policy + asset.name]: receipt.budget };
  const address = client.bech32({ payment_credential: { type: "Script", hash: client.scripts.channelHash }, stake_credential: null });
  return minUtxoForOutput({ address, assets, datum: drained }, coinsPerUtxoByte);
}

/** Structural lovelace the node at `depth` needs for itself and everything drawn below it. */
export function subtreeReserve(client: CascadeClient, asset: AssetClass, node: PlanNode, depth: number): bigint {
  const coinsPerUtxoByte = client.lucid.config().protocolParameters?.coinsPerUtxoByte;
  if (coinsPerUtxoByte === undefined) throw new Error("protocol parameters are not loaded");
  let reserve = client.minStructural(asset, worstDatum(node, "Native", depth));
  for (const child of node.children) {
    const spec = child.spec;
    if (spec.rail === "native") reserve += subtreeReserve(client, asset, child, depth + 1);
    else if (spec.rail === "metered") {
      const receipt = worstDatum(child, "MeteredReceipt", depth + 1);
      reserve += client.minStructural(asset, receipt) + channelLovelace(client, asset, receipt, coinsPerUtxoByte);
    } else if (spec.rail === "masumi") throw new Error(`spec ${spec.id}: MasumiReceipt leaves are superseded by the purchase wallet P (ADR 8.1)`);
    // An address payment (including a Masumi purchase through P) leaves no output in the tree.
  }
  return reserve;
}

/** A planner hook: the exact structural reserve of a plan node at `depth`, for the plan's asset id. */
export type StructuralSizer = (node: PlanNode, assetId: string, depth: number) => bigint;

export const sdkStructuralSizer =
  (client: CascadeClient): StructuralSizer =>
  (node, assetId, depth) =>
    subtreeReserve(client, assetClassOf(assetId), node, depth);
