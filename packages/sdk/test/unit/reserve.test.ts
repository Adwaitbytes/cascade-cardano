import { readFileSync } from "node:fs";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";
import type { NodeDatum } from "@cascade/shared";
import { loadCascadeScripts } from "../../src/blueprint.js";
import { CascadeClient, StructuralShortfallError } from "../../src/client.js";
import type { ReferenceScripts } from "../../src/deploy.js";

const blueprint: unknown = JSON.parse(readFileSync(new URL("../../../../contracts/plutus.json", import.meta.url), "utf8"));
// Only the network and protocol parameters are read by reserve sizing; no chain access.
const lucid = { config: () => ({ network: "Preprod", protocolParameters: { coinsPerUtxoByte: 4310n } }) } as unknown as LucidEvolution;
const client = new CascadeClient(lucid, loadCascadeScripts(blueprint), {} as ReferenceScripts);
const key = { payment_credential: { type: "VerificationKey" as const, hash: "11".repeat(28) }, stake_credential: null };
const node = (overrides: Partial<NodeDatum>): NodeDatum => ({
  tree_id: "77".repeat(28),
  node_id: "77".repeat(28),
  parent_id: null,
  depth: 0n,
  next_child: 0n,
  operator: "22".repeat(28),
  payee: key,
  kind: "Native",
  budget: 20_000_000n,
  fee: 1_000_000n,
  committed: 0n,
  children_open: 0n,
  structural: 0n,
  external_lovelace: 0n,
  spec_hash: "ab".repeat(32),
  input_hash: "cd".repeat(32),
  result_hash: null,
  acceptance: { type: "BuyerAccept", key: "11".repeat(28) },
  submit_by: 1n,
  challenge_until: 2n,
  refund_after: 1n,
  dispute_until: 3n,
  external_ref: null,
  frozen: false,
  state: "Funded",
  spent: 0n,
  ...overrides,
});
const token = { policy: "ab".repeat(28), name: "0014df10745553444d" };

describe("node reserve vs min-UTxO", () => {
  it("a token node with no structural lovelace is short by the whole min-UTxO", () => {
    expect(client.nodeReserveShortfall(token, node({}))).toBeGreaterThan(1_000_000n);
    // minStructural is the fixed point (the coin's own CBOR width grows with it): exactly enough.
    const enough = client.minStructural(token, node({}));
    expect(client.nodeReserveShortfall(token, node({ structural: enough }))).toBe(0n);
    expect(client.nodeReserveShortfall(token, node({ structural: enough - 1n }))).toBeGreaterThan(0n);
  });

  it("held lovelace counts in a lovelace tree, until it is drawn away", () => {
    const lovelace = { policy: "", name: "" };
    expect(client.nodeReserveShortfall(lovelace, node({}))).toBe(0n);
    expect(client.nodeReserveShortfall(lovelace, node({ committed: 20_000_000n }))).toBeGreaterThan(0n);
  });

  it("the error names the node and the shortfall", () => {
    const e = new StructuralShortfallError("77".repeat(28), 123n);
    expect(e).toBeInstanceOf(Error);
    expect(e.shortfall).toBe(123n);
    expect(e.message).toMatch(/123 lovelace/);
  });
});
