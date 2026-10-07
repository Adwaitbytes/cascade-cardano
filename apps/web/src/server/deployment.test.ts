import { describe, expect, it } from "vitest";
import { deployedScriptHashes, deployedScripts } from "./deployment";
import type { DeploymentFile } from "./repo";

const NODE = "a".repeat(56);
const CONFIG = "b".repeat(56);
const slotConfig = { zeroTime: 0, zeroSlot: 0, slotLength: 1000 };

describe("deployedScriptHashes", () => {
  it("reads the hashes from the deployment file when it has them", () => {
    const file: DeploymentFile = { network: "preprod", slotConfig, scripts: { cascade_node: { hash: NODE }, cascade_config: CONFIG } };
    expect(deployedScriptHashes(file, null)).toEqual({ node: NODE, config: CONFIG });
  });

  it("falls back to the local runtime file the local stack writes", () => {
    const file: DeploymentFile = { network: "local", slotConfig };
    const runtime: DeploymentFile = { network: "local", slotConfig, scripts: { cascade_node: { hash: NODE }, cascade_config: { hash: CONFIG } } };
    expect(deployedScriptHashes(file, runtime)).toEqual({ node: NODE, config: CONFIG });
  });

  it("reports missing hashes as null", () => {
    expect(deployedScriptHashes({ network: "local", slotConfig }, null)).toEqual({ node: null, config: null });
  });
});

describe("deployedScripts", () => {
  it("lists every preprod script with its hash and reference transaction", () => {
    const scripts = deployedScripts();
    expect(scripts.map((s) => s.name).sort()).toEqual(["cascade_bond", "cascade_channel", "cascade_config", "cascade_logic_core", "cascade_logic_draw", "cascade_logic_ext", "cascade_node"]);
    for (const s of scripts) {
      expect(s.hash).toMatch(/^[0-9a-f]{56}$/);
      expect(s.referenceTx).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
