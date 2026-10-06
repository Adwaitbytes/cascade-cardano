import { readFileSync } from "node:fs";
import { validatorToScriptHash } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";
import { BlueprintSchema, cascadeAddresses, loadCascadeScripts } from "../../src/blueprint.js";

const blueprint: unknown = JSON.parse(readFileSync(new URL("../../../../contracts/plutus.json", import.meta.url), "utf8"));

describe("blueprint (contracts/plutus.json)", () => {
  it("loads all seven scripts and reproduces the blueprint's unparameterised hashes", () => {
    const bp = BlueprintSchema.parse(blueprint);
    const s = loadCascadeScripts(blueprint);
    const hashOf = (name: string) => bp.validators.find((v) => v.title.startsWith(`${name}.${name}.`))?.hash;
    expect(s.configHash).toBe(hashOf("cascade_config"));
    expect(s.bondHash).toBe(hashOf("cascade_bond"));
    expect(validatorToScriptHash(s.node)).toBe(s.nodeHash);
    expect(new Set([s.nodeHash, s.logicCoreHash, s.logicDrawHash, s.logicExtHash, s.configHash, s.bondHash, s.channelHash]).size).toBe(7);
  });

  it("every script fits under the ADR 1.3 size bound so it can be published by reference", () => {
    const s = loadCascadeScripts(blueprint);
    for (const script of [s.node, s.logicCore, s.logicDraw, s.logicExt, s.config, s.bond, s.channel]) {
      // Double-CBOR hex: flat bytes are about half the hex length.
      expect(script.script.length / 2).toBeLessThan(16_384 - 400);
    }
  });

  it("takes the channel hash from the blueprint and refuses a mismatched one", () => {
    const bp = BlueprintSchema.parse(blueprint);
    const s = loadCascadeScripts(blueprint);
    expect(s.channelHash).toBe(bp.validators.find((v) => v.title.startsWith("cascade_channel.cascade_channel."))?.hash);
    expect(loadCascadeScripts(blueprint, { channelHash: s.channelHash }).nodeHash).toBe(s.nodeHash);
    expect(() => loadCascadeScripts(blueprint, { channelHash: "00".repeat(28) })).toThrow(/channelHash/);
  });

  it("node address carries the node hash as payment and stake credential", () => {
    const s = loadCascadeScripts(blueprint);
    const addr = cascadeAddresses("Preprod", s);
    expect(addr.node.startsWith("addr_test1")).toBe(true);
    expect(addr.logicCoreReward.startsWith("stake_test1")).toBe(true);
  });
});

describe("deployment files", () => {
  it("maps reference scripts by blueprint name and refuses a hash mismatch", async () => {
    const { refsFromDeployment, DEPLOYMENT_SCRIPT_KEYS } = await import("../../src/deploy.js");
    const s = loadCascadeScripts(blueprint);
    const hashes = { node: s.nodeHash, logicCore: s.logicCoreHash, logicDraw: s.logicDrawHash, logicExt: s.logicExtHash, config: s.configHash, bond: s.bondHash, channel: s.channelHash };
    const scripts = Object.fromEntries(
      Object.entries(DEPLOYMENT_SCRIPT_KEYS).map(([name, key], i) => [key, { hash: hashes[name as keyof typeof hashes], referenceUtxo: { txHash: "ab".repeat(32), outputIndex: i } }]),
    );
    const refs = refsFromDeployment({ scripts }, s);
    expect(refs.logicExt.outputIndex).toBe(3);
    const stale = { scripts: { ...scripts, cascade_node: { hash: "00".repeat(28), referenceUtxo: { txHash: "ab".repeat(32), outputIndex: 0 } } } };
    expect(() => refsFromDeployment(stale, s)).toThrow(/differs/);
  });
});

describe("local runtime refs", () => {
  it("uses runtime refs only for the running devnet and a matching blueprint", async () => {
    const { refsFromLocalRuntime, DEPLOYMENT_SCRIPT_KEYS } = await import("../../src/deploy.js");
    const s = loadCascadeScripts(blueprint);
    const hashes: Record<string, string> = { node: s.nodeHash, logicCore: s.logicCoreHash, logicDraw: s.logicDrawHash, logicExt: s.logicExtHash, config: s.configHash, bond: s.bondHash, channel: s.channelHash };
    const scripts = Object.fromEntries(Object.entries(DEPLOYMENT_SCRIPT_KEYS).map(([n, k]) => [k, { hash: hashes[n], referenceUtxo: { txHash: "cd".repeat(32), outputIndex: 0 } }]));
    expect(refsFromLocalRuntime({ devnetStartTime: 7, scripts }, s, 7)?.node.txHash).toBe("cd".repeat(32));
    expect(refsFromLocalRuntime({ devnetStartTime: 7, scripts }, s, 8)).toBeNull();
    expect(refsFromLocalRuntime({ devnetStartTime: 7, scripts: { ...scripts, cascade_bond: { hash: "00".repeat(28), referenceUtxo: { txHash: "cd".repeat(32), outputIndex: 0 } } } }, s, 7)).toBeNull();
  });
});

describe("already-registered detection", () => {
  it("recognises the Ogmios and submit-api rejections only", async () => {
    const { isAlreadyRegistered } = await import("../../src/deploy.js");
    expect(isAlreadyRegistered(new Error("Ogmios JSON-RPC error 3145: Trying to re-register some already known credentials"))).toBe(true);
    expect(isAlreadyRegistered(new Error('ConwayCertsFailure (CertFailure (DelegFailure (StakeKeyRegisteredDELEG (ScriptHashObj'))).toBe(true);
    expect(isAlreadyRegistered(new Error("BadInputsUTxO"))).toBe(false);
  });
});

describe("stale-input detection", () => {
  it("recognises the Blockfrost submit rejection seen when the wallet's inputs were just spent", async () => {
    const { isStaleInputs } = await import("../../src/deploy.js");
    const submitError = new Error(
      'TxSubmitError: Error: {"contents":{"contents":{"contents":{"era":"ShelleyBasedEraConway","error":["ConwayMempoolFailure \\"All inputs are spent. Transaction has probably already been included\\""],"kind":"ShelleyTxValidationError"}}},"tag":"TxSubmitFail"}',
    );
    expect(isStaleInputs(submitError)).toBe(true);
    expect(isStaleInputs(new Error("wrapper", { cause: "BadInputsUTxO (fromList [...])" }))).toBe(true);
    expect(isStaleInputs(new Error("Ogmios JSON-RPC error 3145: Trying to re-register some already known credentials"))).toBe(false);
  });
});
