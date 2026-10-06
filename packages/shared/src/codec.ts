/**
 * Plutus Data codecs for every on-chain type in docs/adr/0001-onchain-design.md.
 * Constructor indices and field order follow the ADR exactly. Decoders are strict: wrong constructor
 * index, wrong arity or wrong byte length throws.
 */
import { Constr, Data } from "@lucid-evolution/lucid";
import { plutusAddressFromBech32, plutusAddressToBech32, type NetworkId } from "./address.js";
import {
  ACTION_INDEX,
  BOND_ROLES,
  MASUMI_STATES,
  NODE_KINDS,
  NODE_STATES,
  RULINGS,
  type Acceptance,
  type Action,
  type ActionType,
  type AssetClass,
  type BondDatum,
  type BondRuling,
  type ChannelDatum,
  type ChannelRedeemer,
  type ChildDraw,
  type LogicRedeemer,
  type MasumiDatum,
  type Credential,
  type NodeDatum,
  type NodeKind,
  type OutputReference,
  type ParentLink,
  type PlanLeaf,
  type PlutusAddress,
  type ProofStep,
  type Split,
  type StakeCredential,
  type TreeConfig,
} from "./types.js";

export type PlutusData = Data;
export { Constr };

export class CodecError extends Error {
  override readonly name = "CodecError";
}

// ---------------------------------------------------------------------------------------------
// Primitive helpers

function fail(path: string, message: string): never {
  throw new CodecError(`${path}: ${message}`);
}

function constr(index: number, fields: Data[]): Constr<Data> {
  return new Constr(index, fields);
}

function asConstr(d: Data, path: string, index?: number, arity?: number): Data[] {
  if (!(d instanceof Constr)) fail(path, "expected Constr");
  if (index !== undefined && d.index !== index) fail(path, `expected constructor ${index}, got ${d.index}`);
  if (arity !== undefined && d.fields.length !== arity) fail(path, `expected ${arity} fields, got ${d.fields.length}`);
  return d.fields;
}

function constrIndex(d: Data, path: string, max: number): { index: number; fields: Data[] } {
  if (!(d instanceof Constr)) fail(path, "expected Constr");
  if (d.index < 0 || d.index > max) fail(path, `constructor ${d.index} out of range 0..${max}`);
  return { index: d.index, fields: d.fields };
}

function field(fields: Data[], i: number, path: string): Data {
  const f = fields[i];
  if (f === undefined) fail(path, `missing field ${i}`);
  return f;
}

function asInt(d: Data, path: string): bigint {
  if (typeof d !== "bigint") fail(path, "expected Int");
  return d;
}

function asBytes(d: Data, path: string, length?: number): string {
  if (typeof d !== "string") fail(path, "expected ByteArray");
  if (!/^(?:[0-9a-f]{2})*$/.test(d)) fail(path, "ByteArray is not lowercase hex");
  if (length !== undefined && d.length !== length * 2) fail(path, `expected ${length} bytes, got ${d.length / 2}`);
  return d;
}

function bytesOut(hex: string, path: string, length?: number): string {
  return asBytes(hex.toLowerCase(), path, length);
}

function asList(d: Data, path: string): Data[] {
  if (!Array.isArray(d)) fail(path, "expected List");
  return d;
}

function enumToData<T extends string>(values: readonly T[], value: T, path: string): Constr<Data> {
  const i = values.indexOf(value);
  if (i < 0) fail(path, `unknown variant ${value}`);
  return constr(i, []);
}

function enumFromData<T extends string>(values: readonly T[], d: Data, path: string): T {
  const { index } = constrIndex(d, path, values.length - 1);
  asConstr(d, path, index, 0);
  return values[index] as T;
}

export const optionToData = <T>(value: T | null, enc: (v: T) => Data): Data =>
  value === null ? constr(1, []) : constr(0, [enc(value)]);

export function optionFromData<T>(d: Data, dec: (d: Data, path: string) => T, path: string): T | null {
  const { index, fields } = constrIndex(d, path, 1);
  if (index === 1) {
    asConstr(d, path, 1, 0);
    return null;
  }
  asConstr(d, path, 0, 1);
  return dec(field(fields, 0, path), `${path}.some`);
}

/** Aiken `Bool`: False = Constr 0 [], True = Constr 1 []. */
export const boolToData = (b: boolean): Data => constr(b ? 1 : 0, []);
export function boolFromData(d: Data, path = "Bool"): boolean {
  const { index } = constrIndex(d, path, 1);
  asConstr(d, path, index, 0);
  return index === 1;
}

const intOut = (v: bigint): Data => v;
const hash28 = (hex: string, path: string) => bytesOut(hex, path, 28);
const hash32 = (hex: string, path: string) => bytesOut(hex, path, 32);
const int = (d: Data, p: string) => asInt(d, p);
const b28 = (d: Data, p: string) => asBytes(d, p, 28);
const b32 = (d: Data, p: string) => asBytes(d, p, 32);

// ---------------------------------------------------------------------------------------------
// Ledger types

export function credentialToData(c: Credential, path = "Credential"): Data {
  return constr(c.type === "VerificationKey" ? 0 : 1, [hash28(c.hash, `${path}.hash`)]);
}

export function credentialFromData(d: Data, path = "Credential"): Credential {
  const { index, fields } = constrIndex(d, path, 1);
  asConstr(d, path, index, 1);
  return { type: index === 0 ? "VerificationKey" : "Script", hash: b28(field(fields, 0, path), `${path}.hash`) };
}

export function stakeCredentialToData(s: StakeCredential, path = "StakeCredential"): Data {
  if (s.type === "Inline") return constr(0, [credentialToData(s.credential, `${path}.credential`)]);
  return constr(1, [s.slot_number, s.transaction_index, s.certificate_index]);
}

export function stakeCredentialFromData(d: Data, path = "StakeCredential"): StakeCredential {
  const { index, fields } = constrIndex(d, path, 1);
  if (index === 0) {
    asConstr(d, path, 0, 1);
    return { type: "Inline", credential: credentialFromData(field(fields, 0, path), `${path}.credential`) };
  }
  asConstr(d, path, 1, 3);
  return {
    type: "Pointer",
    slot_number: int(field(fields, 0, path), `${path}.slot_number`),
    transaction_index: int(field(fields, 1, path), `${path}.transaction_index`),
    certificate_index: int(field(fields, 2, path), `${path}.certificate_index`),
  };
}

export function addressToData(a: PlutusAddress, path = "Address"): Data {
  return constr(0, [
    credentialToData(a.payment_credential, `${path}.payment_credential`),
    optionToData(a.stake_credential, (s) => stakeCredentialToData(s, `${path}.stake_credential`)),
  ]);
}

export function addressFromData(d: Data, path = "Address"): PlutusAddress {
  const f = asConstr(d, path, 0, 2);
  return {
    payment_credential: credentialFromData(field(f, 0, path), `${path}.payment_credential`),
    stake_credential: optionFromData(field(f, 1, path), stakeCredentialFromData, `${path}.stake_credential`),
  };
}

/** Bech32 address to Plutus Data (base or enterprise; payment plus optional inline stake credential). */
export const bech32ToData = (address: string): Data => addressToData(plutusAddressFromBech32(address));
export const dataToBech32 = (d: Data, networkId: NetworkId): string => plutusAddressToBech32(addressFromData(d), networkId);

export function outputReferenceToData(o: OutputReference, path = "OutputReference"): Data {
  return constr(0, [hash32(o.transaction_id, `${path}.transaction_id`), o.output_index]);
}

export function outputReferenceFromData(d: Data, path = "OutputReference"): OutputReference {
  const f = asConstr(d, path, 0, 2);
  return {
    transaction_id: b32(field(f, 0, path), `${path}.transaction_id`),
    output_index: int(field(f, 1, path), `${path}.output_index`),
  };
}

// ---------------------------------------------------------------------------------------------
// ADR 4.1

export function assetClassToData(a: AssetClass, path = "AssetClass"): Data {
  return constr(0, [bytesOut(a.policy, `${path}.policy`), bytesOut(a.name, `${path}.name`)]);
}

export function assetClassFromData(d: Data, path = "AssetClass"): AssetClass {
  const f = asConstr(d, path, 0, 2);
  return { policy: asBytes(field(f, 0, path), `${path}.policy`), name: asBytes(field(f, 1, path), `${path}.name`) };
}

export const nodeKindToData = (k: NodeKind, path = "NodeKind"): Data => enumToData(NODE_KINDS, k, path);
export const nodeKindFromData = (d: Data, path = "NodeKind"): NodeKind => enumFromData(NODE_KINDS, d, path);
export const nodeStateToData = (s: NodeDatum["state"], path = "NodeState"): Data => enumToData(NODE_STATES, s, path);
export const nodeStateFromData = (d: Data, path = "NodeState"): NodeDatum["state"] => enumFromData(NODE_STATES, d, path);

export function acceptanceToData(a: Acceptance, path = "Acceptance"): Data {
  switch (a.type) {
    case "ParentAccept":
      return constr(0, [hash28(a.key, `${path}.key`)]);
    case "VerifierQuorum":
      return constr(1, [a.keys.map((k, i) => hash28(k, `${path}.keys[${i}]`)), a.k]);
    case "AutoAfterWindow":
      return constr(2, []);
    case "BuyerAccept":
      return constr(3, [hash28(a.key, `${path}.key`)]);
  }
}

export function acceptanceFromData(d: Data, path = "Acceptance"): Acceptance {
  const { index, fields } = constrIndex(d, path, 3);
  switch (index) {
    case 0:
      asConstr(d, path, 0, 1);
      return { type: "ParentAccept", key: b28(field(fields, 0, path), `${path}.key`) };
    case 1:
      asConstr(d, path, 1, 2);
      return {
        type: "VerifierQuorum",
        keys: asList(field(fields, 0, path), `${path}.keys`).map((k, i) => b28(k, `${path}.keys[${i}]`)),
        k: int(field(fields, 1, path), `${path}.k`),
      };
    case 2:
      asConstr(d, path, 2, 0);
      return { type: "AutoAfterWindow" };
    default:
      asConstr(d, path, 3, 1);
      return { type: "BuyerAccept", key: b28(field(fields, 0, path), `${path}.key`) };
  }
}

// ---------------------------------------------------------------------------------------------
// ADR 4.2 TreeConfig

export function treeConfigToData(c: TreeConfig): Data {
  const p = "TreeConfig";
  return constr(0, [
    hash28(c.tree_id, `${p}.tree_id`),
    hash28(c.buyer, `${p}.buyer`),
    addressToData(c.buyer_refund, `${p}.buyer_refund`),
    assetClassToData(c.asset, `${p}.asset`),
    c.arbiters.map((k, i) => hash28(k, `${p}.arbiters[${i}]`)),
    c.arbiter_threshold,
    addressToData(c.arbiter_fee_address, `${p}.arbiter_fee_address`),
    c.max_depth,
    c.max_fanout,
    c.max_child_share_bps,
    c.min_challenge_window,
    c.min_safety_margin,
    c.allowed_leaf_kinds.map((k) => nodeKindToData(k, `${p}.allowed_leaf_kinds`)),
    hash28(c.masumi_script_hash, `${p}.masumi_script_hash`),
    hash28(c.channel_script_hash, `${p}.channel_script_hash`),
    hash32(c.plan_root, `${p}.plan_root`),
    c.protocol_fee_bps,
    addressToData(c.protocol_fee_address, `${p}.protocol_fee_address`),
    c.challenge_bond,
    c.slash_wronged_bps,
    c.min_dispute_window,
  ]);
}

export function treeConfigFromData(d: Data): TreeConfig {
  const p = "TreeConfig";
  const f = asConstr(d, p, 0, 21);
  const g = (i: number) => field(f, i, p);
  return {
    tree_id: b28(g(0), `${p}.tree_id`),
    buyer: b28(g(1), `${p}.buyer`),
    buyer_refund: addressFromData(g(2), `${p}.buyer_refund`),
    asset: assetClassFromData(g(3), `${p}.asset`),
    arbiters: asList(g(4), `${p}.arbiters`).map((k, i) => b28(k, `${p}.arbiters[${i}]`)),
    arbiter_threshold: int(g(5), `${p}.arbiter_threshold`),
    arbiter_fee_address: addressFromData(g(6), `${p}.arbiter_fee_address`),
    max_depth: int(g(7), `${p}.max_depth`),
    max_fanout: int(g(8), `${p}.max_fanout`),
    max_child_share_bps: int(g(9), `${p}.max_child_share_bps`),
    min_challenge_window: int(g(10), `${p}.min_challenge_window`),
    min_safety_margin: int(g(11), `${p}.min_safety_margin`),
    allowed_leaf_kinds: asList(g(12), `${p}.allowed_leaf_kinds`).map((k, i) => nodeKindFromData(k, `${p}.allowed_leaf_kinds[${i}]`)),
    masumi_script_hash: b28(g(13), `${p}.masumi_script_hash`),
    channel_script_hash: b28(g(14), `${p}.channel_script_hash`),
    plan_root: b32(g(15), `${p}.plan_root`),
    protocol_fee_bps: int(g(16), `${p}.protocol_fee_bps`),
    protocol_fee_address: addressFromData(g(17), `${p}.protocol_fee_address`),
    challenge_bond: int(g(18), `${p}.challenge_bond`),
    slash_wronged_bps: int(g(19), `${p}.slash_wronged_bps`),
    min_dispute_window: int(g(20), `${p}.min_dispute_window`),
  };
}

// ---------------------------------------------------------------------------------------------
// ADR 4.3 NodeDatum

export function nodeDatumToData(n: NodeDatum): Data {
  const p = "NodeDatum";
  return constr(0, [
    hash28(n.tree_id, `${p}.tree_id`),
    hash28(n.node_id, `${p}.node_id`),
    optionToData(n.parent_id, (v) => hash28(v, `${p}.parent_id`)),
    n.depth,
    n.next_child,
    hash28(n.operator, `${p}.operator`),
    addressToData(n.payee, `${p}.payee`),
    nodeKindToData(n.kind, `${p}.kind`),
    n.budget,
    n.fee,
    n.committed,
    n.children_open,
    n.structural,
    n.external_lovelace,
    hash32(n.spec_hash, `${p}.spec_hash`),
    hash32(n.input_hash, `${p}.input_hash`),
    optionToData(n.result_hash, (v) => bytesOut(v, `${p}.result_hash`)),
    acceptanceToData(n.acceptance, `${p}.acceptance`),
    n.submit_by,
    n.challenge_until,
    n.refund_after,
    n.dispute_until,
    optionToData(n.external_ref, (v) => outputReferenceToData(v, `${p}.external_ref`)),
    boolToData(n.frozen),
    nodeStateToData(n.state, `${p}.state`),
    n.spent,
  ]);
}

export function nodeDatumFromData(d: Data): NodeDatum {
  const p = "NodeDatum";
  const f = asConstr(d, p, 0, 26);
  const g = (i: number) => field(f, i, p);
  return {
    tree_id: b28(g(0), `${p}.tree_id`),
    node_id: b28(g(1), `${p}.node_id`),
    parent_id: optionFromData(g(2), b28, `${p}.parent_id`),
    depth: int(g(3), `${p}.depth`),
    next_child: int(g(4), `${p}.next_child`),
    operator: b28(g(5), `${p}.operator`),
    payee: addressFromData(g(6), `${p}.payee`),
    kind: nodeKindFromData(g(7), `${p}.kind`),
    budget: int(g(8), `${p}.budget`),
    fee: int(g(9), `${p}.fee`),
    committed: int(g(10), `${p}.committed`),
    children_open: int(g(11), `${p}.children_open`),
    structural: int(g(12), `${p}.structural`),
    external_lovelace: int(g(13), `${p}.external_lovelace`),
    spec_hash: b32(g(14), `${p}.spec_hash`),
    input_hash: b32(g(15), `${p}.input_hash`),
    result_hash: optionFromData(g(16), (x, path) => asBytes(x, path), `${p}.result_hash`),
    acceptance: acceptanceFromData(g(17), `${p}.acceptance`),
    submit_by: int(g(18), `${p}.submit_by`),
    challenge_until: int(g(19), `${p}.challenge_until`),
    refund_after: int(g(20), `${p}.refund_after`),
    dispute_until: int(g(21), `${p}.dispute_until`),
    external_ref: optionFromData(g(22), outputReferenceFromData, `${p}.external_ref`),
    frozen: boolFromData(g(23), `${p}.frozen`),
    state: nodeStateFromData(g(24), `${p}.state`),
    spent: int(g(25), `${p}.spent`),
  };
}

// ---------------------------------------------------------------------------------------------
// ADR 4.4 BondDatum

export function bondDatumToData(b: BondDatum): Data {
  const p = "BondDatum";
  return constr(0, [
    hash28(b.authority, `${p}.authority`),
    hash28(b.tree_id, `${p}.tree_id`),
    hash28(b.node_id, `${p}.node_id`),
    hash28(b.owner, `${p}.owner`),
    addressToData(b.owner_address, `${p}.owner_address`),
    enumToData(BOND_ROLES, b.role, `${p}.role`),
    b.release_after,
  ]);
}

export function bondDatumFromData(d: Data): BondDatum {
  const p = "BondDatum";
  const f = asConstr(d, p, 0, 7);
  const g = (i: number) => field(f, i, p);
  return {
    authority: b28(g(0), `${p}.authority`),
    tree_id: b28(g(1), `${p}.tree_id`),
    node_id: b28(g(2), `${p}.node_id`),
    owner: b28(g(3), `${p}.owner`),
    owner_address: addressFromData(g(4), `${p}.owner_address`),
    role: enumFromData(BOND_ROLES, g(5), `${p}.role`),
    release_after: int(g(6), `${p}.release_after`),
  };
}

// ---------------------------------------------------------------------------------------------
// ADR 9 channel

export function channelDatumToData(c: ChannelDatum): Data {
  const p = "ChannelDatum";
  return constr(0, [
    hash28(c.authority, `${p}.authority`),
    hash28(c.tree_id, `${p}.tree_id`),
    hash28(c.node_id, `${p}.node_id`),
    hash32(c.payer_vkey, `${p}.payer_vkey`),
    hash28(c.provider, `${p}.provider`),
    addressToData(c.provider_address, `${p}.provider_address`),
    assetClassToData(c.asset, `${p}.asset`),
    c.deposit,
    c.redeemed,
    c.timeout,
  ]);
}

export function channelDatumFromData(d: Data): ChannelDatum {
  const p = "ChannelDatum";
  const f = asConstr(d, p, 0, 10);
  const g = (i: number) => field(f, i, p);
  return {
    authority: b28(g(0), `${p}.authority`),
    tree_id: b28(g(1), `${p}.tree_id`),
    node_id: b28(g(2), `${p}.node_id`),
    payer_vkey: b32(g(3), `${p}.payer_vkey`),
    provider: b28(g(4), `${p}.provider`),
    provider_address: addressFromData(g(5), `${p}.provider_address`),
    asset: assetClassFromData(g(6), `${p}.asset`),
    deposit: int(g(7), `${p}.deposit`),
    redeemed: int(g(8), `${p}.redeemed`),
    timeout: int(g(9), `${p}.timeout`),
  };
}

export const channelRedeemerToData = (r: ChannelRedeemer): Data =>
  r.type === "Redeem" ? constr(0, [r.amount, bytesOut(r.signature, "ChannelRedeemer.signature", 64), r.out]) : constr(1, []);

export function channelRedeemerFromData(d: Data): ChannelRedeemer {
  const p = "ChannelRedeemer";
  const { index, fields } = constrIndex(d, p, 1);
  if (index === 1) {
    asConstr(d, p, 1, 0);
    return { type: "Close" };
  }
  asConstr(d, p, 0, 3);
  return {
    type: "Redeem",
    amount: int(field(fields, 0, p), `${p}.amount`),
    signature: asBytes(field(fields, 1, p), `${p}.signature`, 64),
    out: int(field(fields, 2, p), `${p}.out`),
  };
}

// ---------------------------------------------------------------------------------------------
// ADR 8 Masumi vested_pay V2

export function masumiDatumToData(m: MasumiDatum): Data {
  const p = "MasumiDatum";
  const addr = (a: PlutusAddress, f: string) => addressToData(a, `${p}.${f}`);
  return constr(0, [
    addr(m.buyer, "buyer"),
    optionToData(m.buyer_return_address, (a) => addr(a, "buyer_return_address")),
    addr(m.seller, "seller"),
    optionToData(m.seller_return_address, (a) => addr(a, "seller_return_address")),
    bytesOut(m.reference_key, `${p}.reference_key`),
    bytesOut(m.reference_signature, `${p}.reference_signature`),
    bytesOut(m.seller_nonce, `${p}.seller_nonce`),
    bytesOut(m.buyer_nonce, `${p}.buyer_nonce`),
    bytesOut(m.agent_identifier, `${p}.agent_identifier`),
    m.collateral_return_lovelace,
    bytesOut(m.input_hash, `${p}.input_hash`),
    bytesOut(m.result_hash, `${p}.result_hash`),
    m.pay_by_time,
    m.submit_result_time,
    m.unlock_time,
    m.external_dispute_unlock_time,
    m.seller_cooldown_time,
    m.buyer_cooldown_time,
    enumToData(MASUMI_STATES, m.state, `${p}.state`),
  ]);
}

export function masumiDatumFromData(d: Data): MasumiDatum {
  const p = "MasumiDatum";
  const f = asConstr(d, p, 0, 19);
  const g = (i: number) => field(f, i, p);
  const bytes = (i: number, name: string) => asBytes(g(i), `${p}.${name}`);
  return {
    buyer: addressFromData(g(0), `${p}.buyer`),
    buyer_return_address: optionFromData(g(1), addressFromData, `${p}.buyer_return_address`),
    seller: addressFromData(g(2), `${p}.seller`),
    seller_return_address: optionFromData(g(3), addressFromData, `${p}.seller_return_address`),
    reference_key: bytes(4, "reference_key"),
    reference_signature: bytes(5, "reference_signature"),
    seller_nonce: bytes(6, "seller_nonce"),
    buyer_nonce: bytes(7, "buyer_nonce"),
    agent_identifier: bytes(8, "agent_identifier"),
    collateral_return_lovelace: int(g(9), `${p}.collateral_return_lovelace`),
    input_hash: bytes(10, "input_hash"),
    result_hash: bytes(11, "result_hash"),
    pay_by_time: int(g(12), `${p}.pay_by_time`),
    submit_result_time: int(g(13), `${p}.submit_result_time`),
    unlock_time: int(g(14), `${p}.unlock_time`),
    external_dispute_unlock_time: int(g(15), `${p}.external_dispute_unlock_time`),
    seller_cooldown_time: int(g(16), `${p}.seller_cooldown_time`),
    buyer_cooldown_time: int(g(17), `${p}.buyer_cooldown_time`),
    state: enumFromData(MASUMI_STATES, g(18), `${p}.state`),
  };
}

// ---------------------------------------------------------------------------------------------
// ADR 3 and 5: plan leaf, proof, redeemer parts

export function planLeafToData(l: PlanLeaf, path = "PlanLeaf"): Data {
  return constr(0, [
    hash32(l.spec_hash, `${path}.spec_hash`),
    hash32(l.parent_spec_hash, `${path}.parent_spec_hash`),
    nodeKindToData(l.kind, `${path}.kind`),
    l.max_budget,
    l.max_fee,
    hash28(l.payee_hash, `${path}.payee_hash`),
    hash32(l.acceptance_hash, `${path}.acceptance_hash`),
  ]);
}

export function planLeafFromData(d: Data, path = "PlanLeaf"): PlanLeaf {
  const f = asConstr(d, path, 0, 7);
  return {
    spec_hash: b32(field(f, 0, path), `${path}.spec_hash`),
    parent_spec_hash: b32(field(f, 1, path), `${path}.parent_spec_hash`),
    kind: nodeKindFromData(field(f, 2, path), `${path}.kind`),
    max_budget: int(field(f, 3, path), `${path}.max_budget`),
    max_fee: int(field(f, 4, path), `${path}.max_fee`),
    payee_hash: b28(field(f, 5, path), `${path}.payee_hash`),
    acceptance_hash: b32(field(f, 6, path), `${path}.acceptance_hash`),
  };
}

export function proofStepToData(s: ProofStep, path = "ProofStep"): Data {
  return constr(0, [hash32(s.sibling, `${path}.sibling`), boolToData(s.sibling_on_left)]);
}

export function proofStepFromData(d: Data, path = "ProofStep"): ProofStep {
  const f = asConstr(d, path, 0, 2);
  return { sibling: b32(field(f, 0, path), `${path}.sibling`), sibling_on_left: boolFromData(field(f, 1, path), `${path}.sibling_on_left`) };
}

export function childDrawToData(c: ChildDraw, path = "ChildDraw"): Data {
  return constr(0, [
    c.out,
    optionToData(c.external_out, intOut),
    planLeafToData(c.leaf, `${path}.leaf`),
    c.proof.map((s, i) => proofStepToData(s, `${path}.proof[${i}]`)),
  ]);
}

export function childDrawFromData(d: Data, path = "ChildDraw"): ChildDraw {
  const f = asConstr(d, path, 0, 4);
  return {
    out: int(field(f, 0, path), `${path}.out`),
    external_out: optionFromData(field(f, 1, path), int, `${path}.external_out`),
    leaf: planLeafFromData(field(f, 2, path), `${path}.leaf`),
    proof: asList(field(f, 3, path), `${path}.proof`).map((s, i) => proofStepFromData(s, `${path}.proof[${i}]`)),
  };
}

export function parentLinkToData(l: ParentLink): Data {
  return l.type === "ParentNode" ? constr(0, [l.parent_in, l.parent_out]) : constr(1, [l.config_in, l.refund_out]);
}

export function parentLinkFromData(d: Data, path = "ParentLink"): ParentLink {
  const { index, fields } = constrIndex(d, path, 1);
  asConstr(d, path, index, 2);
  const a = int(field(fields, 0, path), `${path}[0]`);
  const b = int(field(fields, 1, path), `${path}[1]`);
  return index === 0 ? { type: "ParentNode", parent_in: a, parent_out: b } : { type: "RootExit", config_in: a, refund_out: b };
}

export const splitToData = (s: Split): Data => constr(0, [s.worker, s.parent]);
export function splitFromData(d: Data, path = "Split"): Split {
  const f = asConstr(d, path, 0, 2);
  return { worker: int(field(f, 0, path), `${path}.worker`), parent: int(field(f, 1, path), `${path}.parent`) };
}

export function bondRulingToData(r: BondRuling, path = "BondRuling"): Data {
  return constr(0, [r.bond_in, enumToData(RULINGS, r.ruling, `${path}.ruling`), [...r.outs]]);
}

export function bondRulingFromData(d: Data, path = "BondRuling"): BondRuling {
  const f = asConstr(d, path, 0, 3);
  return {
    bond_in: int(field(f, 0, path), `${path}.bond_in`),
    ruling: enumFromData(RULINGS, field(f, 1, path), `${path}.ruling`),
    outs: asList(field(f, 2, path), `${path}.outs`).map((o, i) => int(o, `${path}.outs[${i}]`)),
  };
}

// ---------------------------------------------------------------------------------------------
// ADR 5 Action

export function actionToData(a: Action): Data {
  const i = ACTION_INDEX[a.type];
  const p = `Action.${a.type}`;
  switch (a.type) {
    case "FundRoot":
      return constr(i, [outputReferenceToData(a.seed, `${p}.seed`), a.root_out, a.config_out]);
    case "TopUp":
      return constr(i, [a.node_in, a.node_out, a.amount]);
    case "Draw":
      return constr(i, [
        a.node_in,
        a.node_out,
        a.config_ref,
        optionToData(a.root_ref, intOut),
        a.children.map((c, k) => childDrawToData(c, `${p}.children[${k}]`)),
      ]);
    case "Submit":
      return constr(i, [a.node_in, a.node_out, hash32(a.result_hash, `${p}.result_hash`)]);
    case "Accept":
    case "Escalate":
    case "Freeze":
    case "Unfreeze":
      return constr(i, [a.node_in, a.node_out]);
    case "Challenge":
      return constr(i, [
        a.node_in,
        a.node_out,
        hash32(a.reason_hash, `${p}.reason_hash`),
        hash28(a.challenger, `${p}.challenger`),
        addressToData(a.challenger_address, `${p}.challenger_address`),
        a.bond_out,
        a.config_ref,
        optionToData(a.parent_ref, intOut),
      ]);
    case "Resolve":
      return constr(i, [
        a.node_in,
        parentLinkToData(a.parent),
        a.config_ref,
        splitToData(a.split),
        a.payee_out,
        a.payee_lovelace,
        a.bonds.map((b, k) => bondRulingToData(b, `${p}.bonds[${k}]`)),
      ]);
    case "Refund":
      return constr(i, [a.node_in, parentLinkToData(a.parent)]);
    case "SettleChild":
      return constr(i, [a.node_in, a.parent_in, a.parent_out, a.payee_out, a.payee_lovelace]);
    case "CloseReceipt":
      return constr(i, [a.node_in, a.parent_in, a.parent_out, optionToData(a.channel_in, intOut)]);
    case "CloseRoot":
      return constr(i, [
        a.node_in,
        a.config_in,
        a.payee_out,
        a.payee_lovelace,
        a.protocol_lovelace,
        optionToData(a.protocol_out, intOut),
        a.refund_out,
      ]);
    case "Cancel":
      return constr(i, [a.node_in, a.config_in, a.refund_out]);
  }
}

const ACTION_BY_INDEX = Object.fromEntries(Object.entries(ACTION_INDEX).map(([k, v]) => [v, k])) as Record<number, ActionType>;

export function actionFromData(d: Data): Action {
  const { index, fields } = constrIndex(d, "Action", 14);
  const type = ACTION_BY_INDEX[index];
  if (type === undefined) fail("Action", `unknown constructor ${index}`);
  const p = `Action.${type}`;
  const g = (k: number) => field(fields, k, p);
  const n = (k: number, name: string) => int(g(k), `${p}.${name}`);
  const arity = (count: number) => asConstr(d, p, index, count);
  switch (type) {
    case "FundRoot":
      arity(3);
      return { type, seed: outputReferenceFromData(g(0), `${p}.seed`), root_out: n(1, "root_out"), config_out: n(2, "config_out") };
    case "TopUp":
      arity(3);
      return { type, node_in: n(0, "node_in"), node_out: n(1, "node_out"), amount: n(2, "amount") };
    case "Draw":
      arity(5);
      return {
        type,
        node_in: n(0, "node_in"),
        node_out: n(1, "node_out"),
        config_ref: n(2, "config_ref"),
        root_ref: optionFromData(g(3), int, `${p}.root_ref`),
        children: asList(g(4), `${p}.children`).map((c, k) => childDrawFromData(c, `${p}.children[${k}]`)),
      };
    case "Submit":
      arity(3);
      return { type, node_in: n(0, "node_in"), node_out: n(1, "node_out"), result_hash: b32(g(2), `${p}.result_hash`) };
    case "Accept":
    case "Escalate":
    case "Freeze":
    case "Unfreeze":
      arity(2);
      return { type, node_in: n(0, "node_in"), node_out: n(1, "node_out") };
    case "Challenge":
      arity(8);
      return {
        type,
        node_in: n(0, "node_in"),
        node_out: n(1, "node_out"),
        reason_hash: b32(g(2), `${p}.reason_hash`),
        challenger: b28(g(3), `${p}.challenger`),
        challenger_address: addressFromData(g(4), `${p}.challenger_address`),
        bond_out: n(5, "bond_out"),
        config_ref: n(6, "config_ref"),
        parent_ref: optionFromData(g(7), int, `${p}.parent_ref`),
      };
    case "Resolve":
      arity(7);
      return {
        type,
        node_in: n(0, "node_in"),
        parent: parentLinkFromData(g(1), `${p}.parent`),
        config_ref: n(2, "config_ref"),
        split: splitFromData(g(3), `${p}.split`),
        payee_out: n(4, "payee_out"),
        payee_lovelace: n(5, "payee_lovelace"),
        bonds: asList(g(6), `${p}.bonds`).map((b, k) => bondRulingFromData(b, `${p}.bonds[${k}]`)),
      };
    case "Refund":
      arity(2);
      return { type, node_in: n(0, "node_in"), parent: parentLinkFromData(g(1), `${p}.parent`) };
    case "SettleChild":
      arity(5);
      return {
        type,
        node_in: n(0, "node_in"),
        parent_in: n(1, "parent_in"),
        parent_out: n(2, "parent_out"),
        payee_out: n(3, "payee_out"),
        payee_lovelace: n(4, "payee_lovelace"),
      };
    case "CloseReceipt":
      arity(4);
      return {
        type,
        node_in: n(0, "node_in"),
        parent_in: n(1, "parent_in"),
        parent_out: n(2, "parent_out"),
        channel_in: optionFromData(g(3), int, `${p}.channel_in`),
      };
    case "CloseRoot":
      arity(7);
      return {
        type,
        node_in: n(0, "node_in"),
        config_in: n(1, "config_in"),
        payee_out: n(2, "payee_out"),
        payee_lovelace: n(3, "payee_lovelace"),
        protocol_lovelace: n(4, "protocol_lovelace"),
        protocol_out: optionFromData(g(5), int, `${p}.protocol_out`),
        refund_out: n(6, "refund_out"),
      };
    case "Cancel":
      arity(3);
      return { type, node_in: n(0, "node_in"), config_in: n(1, "config_in"), refund_out: n(2, "refund_out") };
  }
}

/** `withdraw` redeemer of `cascade_node`: `List<Action>`. */
export const actionsToData = (actions: Action[]): Data => actions.map(actionToData);
export const actionsFromData = (d: Data): Action[] => asList(d, "List<Action>").map(actionFromData);

/** Logic withdraw redeemer (ADR 1.3): `LogicRedeemer { node_hash, actions }`. */
export const logicRedeemerToData = (r: LogicRedeemer): Data =>
  constr(0, [hash28(r.node_hash, "LogicRedeemer.node_hash"), actionsToData(r.actions)]);

export function logicRedeemerFromData(d: Data): LogicRedeemer {
  const f = asConstr(d, "LogicRedeemer", 0, 2);
  return { node_hash: b28(field(f, 0, "LogicRedeemer"), "LogicRedeemer.node_hash"), actions: actionsFromData(field(f, 1, "LogicRedeemer")) };
}

// ---------------------------------------------------------------------------------------------
// CBOR hex

export const toCbor = (d: Data): string => Data.to(d);
export const fromCbor = (cborHex: string): Data => Data.from(cborHex);

export const encodeTreeConfig = (c: TreeConfig): string => toCbor(treeConfigToData(c));
export const decodeTreeConfig = (cbor: string): TreeConfig => treeConfigFromData(fromCbor(cbor));
export const encodeNodeDatum = (n: NodeDatum): string => toCbor(nodeDatumToData(n));
export const decodeNodeDatum = (cbor: string): NodeDatum => nodeDatumFromData(fromCbor(cbor));
export const encodeBondDatum = (b: BondDatum): string => toCbor(bondDatumToData(b));
export const decodeBondDatum = (cbor: string): BondDatum => bondDatumFromData(fromCbor(cbor));
export const encodeAction = (a: Action): string => toCbor(actionToData(a));
export const decodeAction = (cbor: string): Action => actionFromData(fromCbor(cbor));
export const encodeWithdrawRedeemer = (actions: Action[]): string => toCbor(actionsToData(actions));
export const decodeWithdrawRedeemer = (cbor: string): Action[] => actionsFromData(fromCbor(cbor));
export const encodeLogicRedeemer = (r: LogicRedeemer): string => toCbor(logicRedeemerToData(r));
export const decodeLogicRedeemer = (cbor: string): LogicRedeemer => logicRedeemerFromData(fromCbor(cbor));
export const encodeChannelDatum = (c: ChannelDatum): string => toCbor(channelDatumToData(c));
export const decodeChannelDatum = (cbor: string): ChannelDatum => channelDatumFromData(fromCbor(cbor));
export const encodeChannelRedeemer = (r: ChannelRedeemer): string => toCbor(channelRedeemerToData(r));
export const decodeChannelRedeemer = (cbor: string): ChannelRedeemer => channelRedeemerFromData(fromCbor(cbor));
export const encodeMasumiDatum = (m: MasumiDatum): string => toCbor(masumiDatumToData(m));
export const decodeMasumiDatum = (cbor: string): MasumiDatum => masumiDatumFromData(fromCbor(cbor));
export const encodePlanLeaf = (l: PlanLeaf): string => toCbor(planLeafToData(l));
export const decodePlanLeaf = (cbor: string): PlanLeaf => planLeafFromData(fromCbor(cbor));
