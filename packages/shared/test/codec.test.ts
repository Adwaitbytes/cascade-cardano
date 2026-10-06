import { Constr, credentialToAddress, getAddressDetails } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";
import { plutusAddressFromBech32, plutusAddressToBech32 } from "../src/address.js";
import {
  actionFromData,
  actionToData,
  addressFromData,
  addressToData,
  bech32ToData,
  boolFromData,
  boolToData,
  bondDatumFromData,
  bondDatumToData,
  CodecError,
  dataToBech32,
  decodeAction,
  decodeBondDatum,
  decodeLogicRedeemer,
  encodeLogicRedeemer,
  decodeNodeDatum,
  decodePlanLeaf,
  decodeTreeConfig,
  decodeWithdrawRedeemer,
  encodeAction,
  encodeBondDatum,
  encodeNodeDatum,
  encodePlanLeaf,
  encodeTreeConfig,
  encodeWithdrawRedeemer,
  fromCbor,
  nodeDatumFromData,
  nodeDatumToData,
  optionFromData,
  optionToData,
  outputReferenceFromData,
  outputReferenceToData,
  planLeafToData,
  toCbor,
  treeConfigFromData,
  treeConfigToData,
} from "../src/codec.js";
import { ActionSchema, BondDatumSchema, LogicRedeemerSchema, NodeDatumSchema, PlanLeafSchema, TreeConfigSchema } from "../src/schemas.js";
import { ACTION_INDEX, logicScriptOf } from "../src/types.js";
import { allActions, bondDatum, h, keyAddr, receiptNode, rootNode, scriptAddr, tag32, treeConfig } from "./fixtures.js";

describe("primitives", () => {
  it("Bool is False = Constr 0, True = Constr 1", () => {
    expect(toCbor(boolToData(false))).toBe("d87980");
    expect(toCbor(boolToData(true))).toBe("d87a80");
    expect(boolFromData(fromCbor("d87a80"))).toBe(true);
    expect(() => boolFromData(new Constr(2, []))).toThrow(CodecError);
  });

  it("Option is Some = Constr 0 [x], None = Constr 1 []", () => {
    expect(toCbor(optionToData<bigint>(null, (v) => v))).toBe("d87a80");
    expect(toCbor(optionToData(5n, (v) => v))).toBe("d8799f05ff");
    expect(optionFromData(fromCbor("d8799f05ff"), (d) => d as bigint, "o")).toBe(5n);
  });

  it("OutputReference round trips", () => {
    const o = { transaction_id: tag32("x"), output_index: 7n };
    expect(outputReferenceFromData(fromCbor(toCbor(outputReferenceToData(o))))).toEqual(o);
  });

  it("encodes the x402 spec's enterprise buyer address vector", () => {
    expect(toCbor(addressToData(keyAddr(h("11", 28))))).toBe("d8799fd8799f581c11111111111111111111111111111111111111111111111111111111ffd87a80ff");
  });

  it("address <-> Plutus Data for every supported shape, matching Lucid", () => {
    const shapes = [keyAddr(h("aa", 28)), keyAddr(h("aa", 28), h("bb", 28)), scriptAddr(h("cc", 28)), scriptAddr(h("cc", 28), h("dd", 28))];
    for (const a of shapes) {
      for (const net of [0, 1] as const) {
        const bech = plutusAddressToBech32(a, net);
        const lucid = credentialToAddress(
          net === 0 ? "Preprod" : "Mainnet",
          { type: a.payment_credential.type === "VerificationKey" ? "Key" : "Script", hash: a.payment_credential.hash },
          a.stake_credential?.type === "Inline"
            ? { type: a.stake_credential.credential.type === "VerificationKey" ? "Key" : "Script", hash: a.stake_credential.credential.hash }
            : undefined,
        );
        expect(bech).toBe(lucid);
        expect(getAddressDetails(bech).paymentCredential?.hash).toBe(a.payment_credential.hash);
        expect(plutusAddressFromBech32(bech)).toEqual(a);
        expect(dataToBech32(fromCbor(toCbor(bech32ToData(bech))), net)).toBe(bech);
        expect(addressFromData(addressToData(a))).toEqual(a);
      }
    }
  });

  it("pointer stake credential round trips as Plutus Data", () => {
    const a = { payment_credential: { type: "VerificationKey" as const, hash: h("aa", 28) }, stake_credential: { type: "Pointer" as const, slot_number: 1n, transaction_index: 2n, certificate_index: 3n } };
    expect(addressFromData(fromCbor(toCbor(addressToData(a))))).toEqual(a);
  });
});

describe("datums", () => {
  it("TreeConfig round trips through Data and CBOR hex", () => {
    expect(TreeConfigSchema.parse(treeConfig)).toEqual(treeConfig);
    expect(treeConfigFromData(treeConfigToData(treeConfig))).toEqual(treeConfig);
    const cbor = encodeTreeConfig(treeConfig);
    expect(decodeTreeConfig(cbor)).toEqual(treeConfig);
    expect(encodeTreeConfig(decodeTreeConfig(cbor))).toBe(cbor);
  });

  it("NodeDatum round trips for root and receipt shapes", () => {
    for (const n of [rootNode, receiptNode]) {
      expect(NodeDatumSchema.parse(n)).toEqual(n);
      expect(nodeDatumFromData(nodeDatumToData(n))).toEqual(n);
      const cbor = encodeNodeDatum(n);
      expect(decodeNodeDatum(cbor)).toEqual(n);
      expect(encodeNodeDatum(decodeNodeDatum(cbor))).toBe(cbor);
    }
  });

  it("NodeDatum field order and enum indices follow the ADR", () => {
    const d = nodeDatumToData(receiptNode) as Constr<unknown>;
    expect(d.index).toBe(0);
    expect(d.fields).toHaveLength(26);
    expect(d.fields[25]).toBe(1_000_000n); // spent (ADR 1.5)
    expect((d.fields[7] as Constr<unknown>).index).toBe(1); // MasumiReceipt
    expect((d.fields[17] as Constr<unknown>).index).toBe(1); // VerifierQuorum
    expect((d.fields[23] as Constr<unknown>).index).toBe(1); // frozen True
    expect((d.fields[24] as Constr<unknown>).index).toBe(3); // Disputed
    expect(d.fields[13]).toBe(1_435_230n); // external_lovelace
  });

  it("BondDatum round trips", () => {
    expect(BondDatumSchema.parse(bondDatum)).toEqual(bondDatum);
    expect(bondDatumFromData(bondDatumToData(bondDatum))).toEqual(bondDatum);
    for (const role of ["Challenger", "Verifier", "Specialist"] as const) {
      const b = { ...bondDatum, role };
      expect(decodeBondDatum(encodeBondDatum(b))).toEqual(b);
    }
  });

  it("every Acceptance and NodeState variant round trips", () => {
    const acceptances = [
      { type: "ParentAccept" as const, key: h("01", 28) },
      { type: "VerifierQuorum" as const, keys: [h("02", 28)], k: 1n },
      { type: "AutoAfterWindow" as const },
      { type: "BuyerAccept" as const, key: h("03", 28) },
    ];
    for (const acceptance of acceptances) {
      const n = { ...rootNode, acceptance };
      expect(decodeNodeDatum(encodeNodeDatum(n))).toEqual(n);
    }
    expect(NodeDatumSchema.safeParse({ ...rootNode, kind: "AddressPayment" }).success).toBe(false);
    for (const state of ["Funded", "Submitted", "Challenged", "Disputed", "Accepted", "Refunded"] as const) {
      const n = { ...rootNode, state };
      expect(decodeNodeDatum(encodeNodeDatum(n))).toEqual(n);
    }
  });

  it("rejects wrong constructor, arity and byte length", () => {
    const d = nodeDatumToData(rootNode) as Constr<unknown>;
    expect(() => nodeDatumFromData(new Constr(1, d.fields as never[]))).toThrow(/constructor/);
    expect(() => nodeDatumFromData(new Constr(0, d.fields.slice(0, 25) as never[]))).toThrow(/25/);
    const badHash = [...d.fields];
    badHash[0] = "aa";
    expect(() => nodeDatumFromData(new Constr(0, badHash as never[]))).toThrow(/28 bytes/);
    expect(() => encodeNodeDatum({ ...rootNode, operator: "aa" })).toThrow(CodecError);
  });
});

describe("plan leaf and actions", () => {
  it("PlanLeaf round trips", () => {
    const leaf = { spec_hash: tag32("a"), parent_spec_hash: tag32("b"), kind: "MeteredReceipt" as const, max_budget: 9n, max_fee: 1n, payee_hash: h("00", 28), acceptance_hash: tag32("acc") };
    expect(decodePlanLeaf(encodePlanLeaf(leaf))).toEqual(leaf);
    const pay = { ...leaf, kind: "AddressPayment" as const, max_fee: 0n, payee_hash: h("ab", 28) };
    expect(decodePlanLeaf(encodePlanLeaf(pay))).toEqual(pay);
    expect((planLeafToData(pay) as Constr<unknown>).fields).toHaveLength(7);
    expect(((planLeafToData(pay) as Constr<unknown>).fields[2] as Constr<unknown>).index).toBe(3);
    expect(PlanLeafSchema.safeParse(pay).success).toBe(true);
    expect(PlanLeafSchema.safeParse({ ...pay, payee_hash: h("00", 28) }).success).toBe(false);
    expect(PlanLeafSchema.safeParse({ ...leaf, payee_hash: h("ab", 28) }).success).toBe(false);
  });

  it("every Action constructor round trips with the ADR index", () => {
    const seen = new Set<string>();
    for (const a of allActions) {
      expect(ActionSchema.parse(a)).toEqual(a);
      const d = actionToData(a) as Constr<unknown>;
      expect(d.index).toBe(ACTION_INDEX[a.type]);
      expect(actionFromData(actionToData(a))).toEqual(a);
      const cbor = encodeAction(a);
      expect(decodeAction(cbor)).toEqual(a);
      expect(encodeAction(decodeAction(cbor))).toBe(cbor);
      seen.add(a.type);
    }
    expect(seen.size).toBe(15);
  });

  it("withdraw redeemer is List<Action>", () => {
    const cbor = encodeWithdrawRedeemer(allActions);
    expect(cbor.startsWith("9f")).toBe(true);
    expect(decodeWithdrawRedeemer(cbor)).toEqual(allActions);
  });

  it("LogicRedeemer is Constr 0 [node_hash, List<Action>] and keeps one logic set", () => {
    const core = allActions.filter((a) => logicScriptOf(a.type) === "core");
    const draw = allActions.filter((a) => logicScriptOf(a.type) === "draw");
    const ext = allActions.filter((a) => logicScriptOf(a.type) === "ext");
    expect(new Set(draw.map((a) => a.type))).toEqual(new Set(["Draw"]));
    expect(new Set(ext.map((a) => a.type))).toEqual(new Set(["CloseReceipt", "Resolve"]));
    for (const actions of [core, draw, ext]) {
      const r = { node_hash: h("55", 28), actions };
      expect(LogicRedeemerSchema.parse(r)).toEqual(r);
      const cbor = encodeLogicRedeemer(r);
      expect(cbor.startsWith("d8799f581c" + h("55", 28) + "9f")).toBe(true);
      expect(decodeLogicRedeemer(cbor)).toEqual(r);
    }
    expect(LogicRedeemerSchema.safeParse({ node_hash: h("55", 28), actions: allActions }).success).toBe(false);
  });

  it("rejects an unknown Action constructor and wrong arity", () => {
    expect(() => actionFromData(new Constr(15, []))).toThrow(/out of range/);
    expect(() => actionFromData(new Constr(4, [0n]))).toThrow(/2 fields/);
  });
});
