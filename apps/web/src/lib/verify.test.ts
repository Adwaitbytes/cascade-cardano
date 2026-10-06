import { bytesToHex, jcsSha256, jcsSha256Hex, plutusAddressToBech32, blake2b_224, signCose1 } from "@cascade/shared/browser";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { FIXTURE_CLOSED } from "@/lib/fixtures/tree";
import { FIXTURE_PLAN } from "@/lib/fixtures/plan";
import { specHash } from "@cascade/shared/browser";
import type { Receipt } from "@/lib/api/schemas";
import { checkReceiptSignature, checkResultText, checkSpecHash } from "./verify";

describe("checkSpecHash", () => {
  const spec = FIXTURE_PLAN.root.spec;
  it("matches the hash of the canonical spec", () => expect(checkSpecHash(spec, specHash(spec)).status).toBe("match"));
  it("flags a spec that does not hash to the datum value", () => expect(checkSpecHash({ ...spec, task: "changed" }, specHash(spec)).status).toBe("mismatch"));
  it("is unavailable for a private spec", () => expect(checkSpecHash(null, "00").status).toBe("unavailable"));
});

describe("checkResultText", () => {
  const result = { summary: "Dubai juice market", prices: [1, 2, 3] };
  it("matches regardless of key order and whitespace", () => {
    expect(checkResultText('{ "prices": [1,2,3], "summary": "Dubai juice market" }', jcsSha256Hex(result)).status).toBe("match");
  });
  it("flags a different result and rejects non-JSON", () => {
    expect(checkResultText('{"summary":"other"}', jcsSha256Hex(result)).status).toBe("mismatch");
    expect(checkResultText("not json", jcsSha256Hex(result)).status).toBe("unavailable");
  });
});

describe("checkReceiptSignature", () => {
  const secretKey = ed25519.utils.randomSecretKey();
  const hash = bytesToHex(blake2b_224(ed25519.getPublicKey(secretKey)));
  const address = plutusAddressToBech32({ payment_credential: { type: "VerificationKey", hash }, stake_credential: null }, 0);
  const base = FIXTURE_CLOSED.receipt as Receipt;
  const signed = (() => {
    const { signature: _s, key: _k, ...rest } = base;
    const { key } = signCose1({ payload: new Uint8Array(32), secretKey, address });
    const body = { ...rest, key };
    return { ...body, signature: signCose1({ payload: jcsSha256(body), secretKey, address }).signature } as Receipt;
  })();
  it("accepts a receipt signed by the published oracle", () => expect(checkReceiptSignature(signed, address).status).toBe("match"));
  it("rejects a tampered receipt", () => expect(checkReceiptSignature({ ...signed, balanced: !signed.balanced }, address).status).toBe("mismatch"));
  it("is unavailable without a published oracle address", () => expect(checkReceiptSignature(signed, null).status).toBe("unavailable"));
});
