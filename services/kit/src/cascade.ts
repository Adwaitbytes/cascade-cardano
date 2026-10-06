/**
 * Cascade-specific decoding over the ChainTx model: which outputs are node or config UTxOs, and
 * which actions a transaction runs (ADR 0001 section 1.3: the action list lives in the logic
 * withdrawal's `LogicRedeemer { node_hash, actions }`).
 */
import {
  actionsFromData,
  Constr,
  decodeBondDatum,
  decodeNodeDatum,
  decodeTreeConfig,
  fromCbor,
  type Action,
  type BondDatum,
  type NodeDatum,
  type PlutusData,
  type TreeConfig,
} from "@cascade/shared";
import { CML } from "@lucid-evolution/lucid";
import { paymentCredentialOf, type ChainTx, type TxOutput } from "./chaintx.js";

export interface CascadeScripts {
  node: string;
  config: string | null;
  logicCore: string | null;
  logicDraw: string | null;
  /** `cascade_logic_ext` (ADR 0001 1.4); optional until every deployment has it. */
  logicExt?: string | null;
  /** `cascade_bond` hash; bonds are indexed only when it is known. */
  bond?: string | null;
  /** `cascade_channel` hash; metered channels are indexed only when it is known. */
  channel?: string | null;
}

export interface LogicRedeemer {
  nodeHash: string;
  actions: Action[];
}

/** Decodes `LogicRedeemer` (Constr 0 [node_hash, List<Action>]); also accepts a bare `List<Action>`. */
export function decodeLogicRedeemer(cborHex: string): LogicRedeemer | null {
  let d: PlutusData;
  try {
    d = fromCbor(cborHex);
  } catch {
    return null;
  }
  try {
    if (d instanceof Constr && d.index === 0 && d.fields.length === 2 && typeof d.fields[0] === "string") {
      return { nodeHash: d.fields[0], actions: actionsFromData(d.fields[1] as PlutusData) };
    }
    if (Array.isArray(d)) return { nodeHash: "", actions: actionsFromData(d) };
  } catch {
    return null;
  }
  return null;
}

/**
 * The Cascade actions a transaction runs: the first withdraw redeemer that decodes as a
 * `LogicRedeemer` naming our node hash, from a withdrawal whose credential is one of the logic
 * scripts (core, draw or ext) when those hashes are known.
 */
export function cascadeActions(tx: ChainTx, scripts: CascadeScripts): Action[] | null {
  const logicHashes = [scripts.logicCore, scripts.logicDraw, scripts.logicExt ?? null].filter((h): h is string => h !== null);
  const withdrawScripts = tx.withdrawals.filter((w) => w.credential.type === "Script").map((w) => w.credential.hash);
  const hasLogicWithdrawal = logicHashes.length === 0 || withdrawScripts.some((h) => logicHashes.includes(h) || h === scripts.node);
  if (!hasLogicWithdrawal) return null;
  for (const r of tx.redeemers) {
    if (r.purpose !== "withdraw") continue;
    const lr = decodeLogicRedeemer(r.data);
    if (lr === null) continue;
    if (lr.nodeHash !== "" && lr.nodeHash !== scripts.node) continue;
    return lr.actions;
  }
  return null;
}

export const nodeTokenUnit = (nodeHash: string, nodeId: string): string => `${nodeHash}.${nodeId}`;

export function isScriptAddress(address: string, scriptHash: string): boolean {
  const cred = paymentCredentialOf(address);
  return cred !== null && cred.type === "Script" && cred.hash === scriptHash;
}

/** Tokens of the node policy held by an output, as `name -> qty`. */
export function policyTokens(out: TxOutput, policy: string): Map<string, bigint> {
  const m = new Map<string, bigint>();
  const prefix = `${policy}.`;
  for (const [unit, qty] of Object.entries(out.assets)) if (unit.startsWith(prefix)) m.set(unit.slice(prefix.length), qty);
  return m;
}

export interface NodeOutput {
  index: number;
  datum: NodeDatum;
  output: TxOutput;
}

export interface ConfigOutput {
  index: number;
  config: TreeConfig;
  output: TxOutput;
}

/**
 * Node outputs: at the node script address, carrying exactly one node-policy token whose 28-byte
 * name equals the inline datum's `node_id` (T1). Anything else at the address is ignored.
 */
export function nodeOutputs(tx: ChainTx, nodeHash: string): NodeOutput[] {
  const out: NodeOutput[] = [];
  tx.outputs.forEach((o, index) => {
    if (o.datum === null || !isScriptAddress(o.address, nodeHash)) return;
    const tokens = policyTokens(o, nodeHash);
    if (tokens.size !== 1) return;
    const [name, qty] = [...tokens][0] as [string, bigint];
    if (qty !== 1n || name.length !== 56) return;
    let datum: NodeDatum;
    try {
      datum = decodeNodeDatum(o.datum);
    } catch {
      return;
    }
    if (datum.node_id !== name) return;
    out.push({ index, datum, output: o });
  });
  return out;
}

/** Config outputs: at the config script address with the config token (`63 ++ tree_id`) of the node policy. */
export function configOutputs(tx: ChainTx, scripts: CascadeScripts): ConfigOutput[] {
  const out: ConfigOutput[] = [];
  tx.outputs.forEach((o, index) => {
    if (o.datum === null) return;
    if (scripts.config !== null && !isScriptAddress(o.address, scripts.config)) return;
    const tokens = policyTokens(o, scripts.node);
    if (tokens.size !== 1) return;
    const [name, qty] = [...tokens][0] as [string, bigint];
    if (qty !== 1n || !name.startsWith("63") || name.length !== 58) return;
    let config: TreeConfig;
    try {
      config = decodeTreeConfig(o.datum);
    } catch {
      return;
    }
    if (`63${config.tree_id}` !== name) return;
    out.push({ index, config, output: o });
  });
  return out;
}

export interface BondOutput {
  index: number;
  datum: BondDatum;
  output: TxOutput;
}

/**
 * Bonds Cascade governs (ADR 1.3 amendment): outputs at the bond script whose datum names the
 * `cascade_node` hash as authority. A bond naming any other authority is not Cascade's.
 */
export function bondOutputs(tx: ChainTx, scripts: CascadeScripts): BondOutput[] {
  const bondHash = scripts.bond ?? null;
  if (bondHash === null) return [];
  const out: BondOutput[] = [];
  tx.outputs.forEach((o, index) => {
    if (o.datum === null || !isScriptAddress(o.address, bondHash)) return;
    let datum: BondDatum;
    try {
      datum = decodeBondDatum(o.datum);
    } catch {
      return;
    }
    if (datum.authority !== scripts.node) return;
    out.push({ index, datum, output: o });
  });
  return out;
}

/** `lovelace` or `policy.name` for an on-chain AssetClass. */
export const assetId = (a: { policy: string; name: string }): string => (a.policy === "" ? "lovelace" : `${a.policy}.${a.name}`);

/**
 * Concrete addresses of the Cascade scripts (ADR 1.3 and the SDK): the node address has both
 * payment and stake credential `cascade_node`; config, bond and channel are enterprise addresses.
 */
export function cascadeScriptAddresses(scripts: CascadeScripts, networkId: 0 | 1): { kind: "node" | "config" | "bond" | "channel"; address: string }[] {
  const script = (h: string) => CML.Credential.new_script(CML.ScriptHash.from_hex(h));
  const out: { kind: "node" | "config" | "bond" | "channel"; address: string }[] = [
    { kind: "node", address: CML.BaseAddress.new(networkId, script(scripts.node), script(scripts.node)).to_address().to_bech32() },
  ];
  const enterprise = (kind: "config" | "bond" | "channel", h: string | null | undefined) => {
    if (h !== null && h !== undefined) out.push({ kind, address: CML.EnterpriseAddress.new(networkId, script(h)).to_address().to_bech32() });
  };
  enterprise("config", scripts.config);
  enterprise("bond", scripts.bond);
  enterprise("channel", scripts.channel);
  return out;
}

/** ADR 0001 section 1.5 field 25: value that left the tree from this node. */
export const spentOf = (d: NodeDatum): bigint => d.spent;
