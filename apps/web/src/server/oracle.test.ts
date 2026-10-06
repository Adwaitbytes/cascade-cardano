// @vitest-environment node
import { bytesToHex, plutusAddressToBech32, utf8 } from "@cascade/shared/browser";
import { CML } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";
import { oracleFromSigningKey } from "./oracle";

function cmlKey() {
  const priv = CML.PrivateKey.generate_ed25519extended();
  const pub = priv.to_public();
  const hash = pub.hash().to_hex();
  const address = plutusAddressToBech32({ payment_credential: { type: "VerificationKey", hash }, stake_credential: null }, 0);
  return { priv, pub, hash, address, bech32: priv.to_bech32() };
}

describe("oracleFromSigningKey", () => {
  it("derives the same public key and key hash as CML", () => {
    const k = cmlKey();
    const signer = oracleFromSigningKey(k.bech32, k.address);
    expect(signer.publicKey).toBe(bytesToHex(k.pub.to_raw_bytes()));
    expect(signer.paymentKeyHash).toBe(k.hash);
  });

  it("signs byte for byte like CML for several keys and messages", () => {
    for (let i = 0; i < 5; i++) {
      const k = cmlKey();
      const signer = oracleFromSigningKey(k.bech32, k.address);
      for (const text of ["", "cascade receipt", "x".repeat(1000)]) {
        const message = utf8(text);
        expect(bytesToHex(signer.sign(message))).toBe(bytesToHex(k.priv.sign(message).to_raw_bytes()));
      }
    }
  });

  it("refuses a key that does not belong to the published address and a non-extended key", () => {
    const a = cmlKey();
    const b = cmlKey();
    expect(() => oracleFromSigningKey(a.bech32, b.address)).toThrow(/does not belong/);
    expect(() => oracleFromSigningKey(CML.PrivateKey.generate_ed25519().to_bech32(), a.address)).toThrow(/ed25519e_sk/);
  });
});
