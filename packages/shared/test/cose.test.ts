import { CML, signData, verifyData } from "@lucid-evolution/lucid";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { addressBytesFromBech32, plutusAddressToBech32 } from "../src/address.js";
import { blake2b_224, bytesToHex, sha256, utf8 } from "../src/bytes.js";
import { signCose1, verifyCose1 } from "../src/cose.js";

function wallet(base = false) {
  const secretKey = ed25519.utils.randomSecretKey();
  const vkh = bytesToHex(blake2b_224(ed25519.getPublicKey(secretKey)));
  const address = plutusAddressToBech32(
    { payment_credential: { type: "VerificationKey", hash: vkh }, stake_credential: base ? { type: "Inline", credential: { type: "VerificationKey", hash: "ee".repeat(28) } } : null },
    0,
  );
  return { secretKey, vkh, address };
}

const payload = sha256(utf8("terms"));

describe("CIP-8 COSE_Sign1", () => {
  it("signs and verifies over a 32-byte hash for enterprise and base addresses", () => {
    for (const base of [false, true]) {
      const w = wallet(base);
      const sig = signCose1({ payload, secretKey: w.secretKey, address: w.address });
      const res = verifyCose1(sig, { payload, address: w.address });
      expect(res).toEqual({ ok: true, publicKey: bytesToHex(ed25519.getPublicKey(w.secretKey)) });
    }
  });

  it("refuses to sign for an address the key does not control", () => {
    const a = wallet();
    const b = wallet();
    expect(() => signCose1({ payload, secretKey: a.secretKey, address: b.address })).toThrow(/blake2b_224/);
    expect(() => signCose1({ payload: new Uint8Array(31), secretKey: a.secretKey, address: a.address })).toThrow(/32-byte/);
  });

  it("rejects wrong payload, wrong address, swapped key and script addresses", () => {
    const a = wallet();
    const b = wallet();
    const sig = signCose1({ payload, secretKey: a.secretKey, address: a.address });
    expect(verifyCose1(sig, { payload: sha256(utf8("other")), address: a.address })).toMatchObject({ ok: false, reason: /payload/ });
    expect(verifyCose1(sig, { payload, address: b.address })).toMatchObject({ ok: false, reason: /address/ });
    const sigB = signCose1({ payload, secretKey: b.secretKey, address: b.address });
    expect(verifyCose1({ signature: sig.signature, key: sigB.key }, { payload, address: a.address })).toMatchObject({ ok: false, reason: /blake2b_224/ });
    const script = plutusAddressToBech32({ payment_credential: { type: "Script", hash: a.vkh }, stake_credential: null }, 0);
    expect(verifyCose1(sig, { payload, address: script })).toMatchObject({ ok: false });
  });

  it("rejects a forged signature and malformed CBOR", () => {
    const a = wallet();
    const sig = signCose1({ payload, secretKey: a.secretKey, address: a.address });
    const forged = sig.signature.slice(0, -2) + (sig.signature.endsWith("00") ? "01" : "00");
    expect(verifyCose1({ ...sig, signature: forged }, { payload, address: a.address })).toMatchObject({ ok: false, reason: /invalid Ed25519/ });
    expect(verifyCose1({ ...sig, signature: "ff" }, { payload, address: a.address })).toMatchObject({ ok: false });
    expect(verifyCose1({ ...sig, key: "zz" }, { payload, address: a.address })).toMatchObject({ ok: false });
  });

  it("interoperates with Lucid Evolution signData / verifyData (CIP-30 shape) in both directions", () => {
    const w = wallet(true);
    const privateKey = CML.PrivateKey.from_normal_bytes(w.secretKey).to_bech32();
    const addressHex = bytesToHex(addressBytesFromBech32(w.address));
    const payloadHex = bytesToHex(payload);

    const fromLucid = signData(addressHex, payloadHex, privateKey);
    expect(verifyCose1(fromLucid, { payload, address: w.address })).toMatchObject({ ok: true });

    const ours = signCose1({ payload, secretKey: w.secretKey, address: w.address });
    expect(verifyData(addressHex, w.vkh, payloadHex, ours)).toBe(true);
  });
});

describe("coseSignedAddress", () => {
  it("returns the signed address and checks the key binds to it", async () => {
    const { coseSignedAddress } = await import("../src/cose.js");
    const a = wallet(true);
    const b = wallet();
    const sig = signCose1({ payload, secretKey: a.secretKey, address: a.address });
    expect(coseSignedAddress(sig)).toBe(a.address);
    const other = signCose1({ payload, secretKey: b.secretKey, address: b.address });
    expect(() => coseSignedAddress({ signature: sig.signature, key: other.key })).toThrow(/blake2b_224/);
  });
});
