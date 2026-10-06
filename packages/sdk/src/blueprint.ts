/**
 * Loads the Cascade validators from the CIP-57 blueprint (`contracts/plutus.json`) and applies
 * the `cascade_node` parameters (ADR 1): `config_hash`, `bond_hash`, `channel_hash`.
 */
import {
  applyDoubleCborEncoding,
  applyParamsToScript,
  credentialToAddress,
  credentialToRewardAddress,
  validatorToScriptHash,
  type Network,
  type Script,
} from "@lucid-evolution/lucid";
import { z } from "zod";

const ValidatorSchema = z.object({
  title: z.string(),
  compiledCode: z.string().regex(/^[0-9a-f]+$/),
  hash: z.string().regex(/^[0-9a-f]{56}$/),
  parameters: z.array(z.object({ title: z.string() }).passthrough()).optional(),
});

export const BlueprintSchema = z.object({
  preamble: z.object({ plutusVersion: z.literal("v3") }).passthrough(),
  validators: z.array(ValidatorSchema).min(1),
});
export type Blueprint = z.infer<typeof BlueprintSchema>;

export interface CascadeScripts {
  /** Thread-token policy and node address (mint, spend). */
  node: Script;
  /** Withdraw validator for every action except Draw, CloseReceipt and Resolve. */
  logicCore: Script;
  /** Withdraw validator for Draw (ADR 1.4). */
  logicDraw: Script;
  /** Withdraw validator for CloseReceipt and Resolve (ADR 1.4). */
  logicExt: Script;
  config: Script;
  bond: Script;
  /** Metered-leaf voucher channel (ADR 9). */
  channel: Script;
  nodeHash: string;
  logicCoreHash: string;
  logicDrawHash: string;
  logicExtHash: string;
  configHash: string;
  bondHash: string;
  channelHash: string;
}

function validator(bp: Blueprint, name: string) {
  const v = bp.validators.find((x) => x.title.startsWith(`${name}.${name}.`));
  if (v === undefined) throw new Error(`blueprint has no validator ${name}`);
  return v;
}

function plutusV3(code: string): Script {
  return { type: "PlutusV3", script: applyDoubleCborEncoding(code) };
}

/**
 * Build the Cascade scripts (ADR 1, 1.3, 1.4) from the blueprint. `channelHash`, when given, must equal
 * the blueprint's `cascade_channel` hash: it is a guard against loading a mismatched deployment.
 */
export function loadCascadeScripts(blueprintJson: unknown, options: { channelHash?: string } = {}): CascadeScripts {
  const bp = BlueprintSchema.parse(blueprintJson);
  const config = plutusV3(validator(bp, "cascade_config").compiledCode);
  const bond = plutusV3(validator(bp, "cascade_bond").compiledCode);
  const configHash = validatorToScriptHash(config);
  const bondHash = validatorToScriptHash(bond);
  const channel = plutusV3(validator(bp, "cascade_channel").compiledCode);
  const channelHash = validatorToScriptHash(channel);
  if (options.channelHash !== undefined && options.channelHash !== channelHash) {
    throw new Error("channelHash differs from the blueprint's cascade_channel hash");
  }
  const base = [configHash, bondHash, channelHash];
  const logicCore = plutusV3(applyParamsToScript(validator(bp, "cascade_logic_core").compiledCode, base));
  const logicDraw = plutusV3(applyParamsToScript(validator(bp, "cascade_logic_draw").compiledCode, base));
  const logicExt = plutusV3(applyParamsToScript(validator(bp, "cascade_logic_ext").compiledCode, base));
  const logicCoreHash = validatorToScriptHash(logicCore);
  const logicDrawHash = validatorToScriptHash(logicDraw);
  const logicExtHash = validatorToScriptHash(logicExt);
  const nodeValidator = validator(bp, "cascade_node");
  if (nodeValidator.parameters?.length !== 6) throw new Error("cascade_node must take 6 parameters (ADR 1.4)");
  const node = plutusV3(applyParamsToScript(nodeValidator.compiledCode, [...base, logicCoreHash, logicDrawHash, logicExtHash]));
  return {
    node,
    logicCore,
    logicDraw,
    logicExt,
    config,
    bond,
    channel,
    nodeHash: validatorToScriptHash(node),
    logicCoreHash,
    logicDrawHash,
    logicExtHash,
    configHash,
    bondHash,
    channelHash,
  };
}

export interface CascadeAddresses {
  /** Base address: payment and stake credential are both `cascade_node`. */
  node: string;
  logicCoreReward: string;
  logicDrawReward: string;
  logicExtReward: string;
  config: string;
  bond: string;
}

export function cascadeAddresses(network: Network, s: CascadeScripts): CascadeAddresses {
  const nodeCred = { type: "Script" as const, hash: s.nodeHash };
  return {
    node: credentialToAddress(network, nodeCred, nodeCred),
    logicCoreReward: credentialToRewardAddress(network, { type: "Script", hash: s.logicCoreHash }),
    logicDrawReward: credentialToRewardAddress(network, { type: "Script", hash: s.logicDrawHash }),
    logicExtReward: credentialToRewardAddress(network, { type: "Script", hash: s.logicExtHash }),
    config: credentialToAddress(network, { type: "Script", hash: s.configHash }),
    bond: credentialToAddress(network, { type: "Script", hash: s.bondHash }),
  };
}
