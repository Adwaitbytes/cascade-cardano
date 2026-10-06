// Reads the Aiken CIP-57 blueprint and applies Cascade's script parameters in
// dependency order (ADR 0001 sections 1, 1.3 and 1.4).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyDoubleCborEncoding,
  applyParamsToScript,
  validatorToScriptHash,
  type Script,
} from "@lucid-evolution/lucid";
import { REPO_ROOT } from "./env.js";

export const DEFAULT_BLUEPRINT_PATH = resolve(REPO_ROOT, "contracts", "plutus.json");

/** Deployment order: every script's parameters are hashes of scripts earlier in this list. */
export const CASCADE_SCRIPTS = [
  "cascade_config",
  "cascade_bond",
  "cascade_channel",
  "cascade_logic_core",
  "cascade_logic_draw",
  "cascade_logic_ext",
  "cascade_node",
] as const;
export type CascadeScriptName = (typeof CASCADE_SCRIPTS)[number];

/** Parameter names per script, in the order the validator declares them. */
export const SCRIPT_PARAMETERS: Readonly<Record<CascadeScriptName, readonly CascadeScriptName[]>> = {
  cascade_config: [],
  cascade_bond: [],
  cascade_channel: [],
  cascade_logic_core: ["cascade_config", "cascade_bond", "cascade_channel"],
  cascade_logic_draw: ["cascade_config", "cascade_bond", "cascade_channel"],
  cascade_logic_ext: ["cascade_config", "cascade_bond", "cascade_channel"],
  // ADR 0001 section 1.4 order.
  cascade_node: ["cascade_config", "cascade_bond", "cascade_channel", "cascade_logic_core", "cascade_logic_draw", "cascade_logic_ext"],
};

/** Logic scripts run as withdraw-zero stake validators and need a registered credential (T18). */
export const STAKE_SCRIPTS = ["cascade_logic_core", "cascade_logic_draw", "cascade_logic_ext"] as const satisfies readonly CascadeScriptName[];

interface BlueprintValidator {
  title: string;
  compiledCode: string;
  hash: string;
  parameters?: unknown[];
}

export interface Blueprint {
  path: string;
  sha256: string;
  compilerVersion: string;
  plutusVersion: string;
  validators: BlueprintValidator[];
}

export interface AppliedScript {
  name: CascadeScriptName;
  script: Script;
  hash: string;
  /** Bytes of the double-CBOR script, within a few bytes of its size in a reference output. */
  sizeBytes: number;
  parameters: { name: CascadeScriptName; hash: string }[];
}

export function loadBlueprint(path: string = DEFAULT_BLUEPRINT_PATH): Blueprint {
  const bytes = readFileSync(path);
  const raw = JSON.parse(bytes.toString("utf8")) as {
    preamble?: { compiler?: { version?: string }; plutusVersion?: string };
    validators?: BlueprintValidator[];
  };
  if (!Array.isArray(raw.validators)) throw new Error(`${path}: no validators array`);
  const plutusVersion = raw.preamble?.plutusVersion ?? "";
  if (plutusVersion !== "v3") throw new Error(`${path}: expected plutusVersion v3, found "${plutusVersion}"`);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    compilerVersion: raw.preamble?.compiler?.version ?? "unknown",
    plutusVersion,
    validators: raw.validators,
  };
}

function findValidator(blueprint: Blueprint, name: CascadeScriptName): BlueprintValidator {
  const prefix = `${name}.${name}.`;
  const entry = blueprint.validators.find((v) => v.title.startsWith(prefix));
  if (entry === undefined) throw new Error(`Blueprint ${blueprint.path} has no validator ${name}`);
  const declared = entry.parameters?.length ?? 0;
  const expected = SCRIPT_PARAMETERS[name].length;
  if (declared !== expected) {
    throw new Error(`Blueprint validator ${name} declares ${declared} parameters, deploy expects ${expected}`);
  }
  return entry;
}

export function missingValidators(blueprint: Blueprint): CascadeScriptName[] {
  return CASCADE_SCRIPTS.filter((name) => !blueprint.validators.some((v) => v.title.startsWith(`${name}.${name}.`)));
}

/** Applies parameters in dependency order and returns every script with its final hash. */
export function applyCascadeParameters(blueprint: Blueprint): Record<CascadeScriptName, AppliedScript> {
  const applied = {} as Record<CascadeScriptName, AppliedScript>;
  for (const name of CASCADE_SCRIPTS) {
    const entry = findValidator(blueprint, name);
    const parameters = SCRIPT_PARAMETERS[name].map((dep) => {
      const done = applied[dep];
      if (done === undefined) throw new Error(`${name} depends on ${dep}, which is not applied yet`);
      return { name: dep, hash: done.hash };
    });
    const base = applyDoubleCborEncoding(entry.compiledCode);
    const code = parameters.length === 0 ? base : applyParamsToScript(base, parameters.map((p) => p.hash));
    const script: Script = { type: "PlutusV3", script: code };
    const hash = validatorToScriptHash(script);
    if (parameters.length === 0 && hash !== entry.hash) {
      throw new Error(`${name}: computed hash ${hash} differs from blueprint hash ${entry.hash}`);
    }
    applied[name] = { name, script, hash, sizeBytes: code.length / 2, parameters };
  }
  return applied;
}
