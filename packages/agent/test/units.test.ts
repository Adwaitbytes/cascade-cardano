import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inputSchemaHash, validateInputData, assertInputSchema } from "../src/input-schema.js";
import { inputHash, mip004OutputHash, pipMasumiOutputHash, resultHash } from "../src/mip004.js";
import { assertTransition, canTransition, isTerminal, JOB_STATUSES } from "../src/status.js";
import { localKeySigner } from "../src/signer.js";
import { MasumiPaymentServiceBackend, isMasumiPurchaserId } from "../src/start-job-payments.js";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("MIP-004 hashing", () => {
  it("input_hash is SHA-256 of identifier ; JCS(input)", () => {
    expect(inputHash("abc", { b: 1, a: "x", c: { z: [1, 2], y: null } })).toBe(sha256('abc;{"a":"x","b":1,"c":{"y":null,"z":[1,2]}}'));
    expect(inputHash("abc", {})).toBe(sha256("abc;{}"));
  });

  it("output hashes: MIP-004 raw text and the pip-masumi escaped variant", () => {
    expect(mip004OutputHash("id", 'say "hi"\n')).toBe(sha256('id;say "hi"\n'));
    expect(pipMasumiOutputHash("id", 'say "hi"\n')).toBe(sha256('id;say \\"hi\\"\\n'));
    expect(pipMasumiOutputHash("id", "plain")).toBe(mip004OutputHash("id", "plain"));
  });

  it("result_hash is SHA-256 of JCS(result)", () => {
    expect(resultHash({ b: 2, a: 1 })).toBe(sha256('{"a":1,"b":2}'));
  });
});

describe("MIP-003 input validation", () => {
  const schema = {
    input_data: [
      { id: "text", type: "string", name: "Text", validations: [{ validation: "format" as const, value: "nonempty" }] },
      { id: "count", type: "number", name: "Count", validations: [{ validation: "format" as const, value: "integer" }, { validation: "min" as const, value: "1" }] },
      { id: "lang", type: "option", name: "Language", data: { values: ["ar", "en"] }, validations: [{ validation: "max" as const, value: "1" }] },
      { id: "site", type: "url", name: "Site", validations: [{ validation: "optional" as const, value: "true" }] },
      { id: "note", type: "none", name: "Note" },
    ],
  };

  it("accepts valid input", () => {
    expect(validateInputData(schema, { text: "hello", count: 2, lang: ["ar"] })).toEqual([]);
    expect(validateInputData(schema, { text: "hello", count: "3", lang: "en", site: "https://x.org" })).toEqual([]);
  });

  it("reports every problem", () => {
    const errors = validateInputData(schema, { text: " ", count: 1.5, lang: ["fr"], site: "ftp://x", junk: 1 });
    expect(errors).toEqual(
      expect.arrayContaining([
        "input_data.junk is not in the input schema",
        "input_data.text must not be empty",
        "input_data.count must be an integer",
        "input_data.lang must be one of ar, en",
        "input_data.site must be an http(s) URL",
      ]),
    );
    expect(validateInputData(schema, [])).toEqual(["input_data must be an object"]);
    expect(validateInputData(schema, {})).toContain("input_data.text is required");
  });

  it("rejects malformed schemas and hashes canonically", () => {
    expect(() => assertInputSchema({ input_data: [{ id: "a", type: "string", name: "A" }, { id: "a", type: "string", name: "B" }] })).toThrow(/duplicated/);
    expect(inputSchemaHash({ input_data: [{ name: "A", id: "a", type: "string" }] })).toBe(sha256('{"input_data":[{"id":"a","name":"A","type":"string"}]}'));
  });
});

describe("status machine", () => {
  it("allows exactly the MIP-003 lifecycle", () => {
    expect(canTransition("awaiting_payment", "running")).toBe(true);
    expect(canTransition("running", "awaiting_input")).toBe(true);
    expect(canTransition("awaiting_input", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("awaiting_payment", "completed")).toBe(false);
    expect(canTransition("completed", "failed")).toBe(false);
    expect(() => assertTransition("failed", "running")).toThrow(/cannot move/);
    expect(JOB_STATUSES.filter(isTerminal)).toEqual(["completed", "failed"]);
  });
});

describe("signer", () => {
  it("derives an enterprise preprod address and refuses a key that does not control the address", () => {
    const s = localKeySigner(new Uint8Array(32).fill(1));
    expect(s.address.startsWith("addr_test1v")).toBe(true);
    expect(s.keyHash).toMatch(/^[0-9a-f]{56}$/);
    expect(() => localKeySigner(new Uint8Array(32).fill(2), s.address)).toThrow(/does not control/);
  });
});

describe("Masumi Payment Service backend", () => {
  it("requires the V2 payment source index and hex purchaser ids", async () => {
    const base = { baseUrl: "http://pay", apiKey: "k", agentIdentifier: "aa", sellerVKey: "bb", network: "Preprod" as const, workMs: 60_000 };
    expect(() => new MasumiPaymentServiceBackend({ ...base, paymentSourceType: "Web3CardanoV2" })).toThrow(/supportedPaymentSourceIndex/);
    expect(isMasumiPurchaserId("resume-job-123")).toBe(false);
    expect(isMasumiPurchaserId("abcdef0123456789")).toBe(true);
  });

  it("sends POST /payment with the token header and Masumi deadline minimums", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      return new Response(JSON.stringify({ data: { ...body, blockchainIdentifier: "bid" } }));
    };
    const now = 1_800_000_000_000;
    const backend = new MasumiPaymentServiceBackend({
      baseUrl: "http://pay/api/v1",
      apiKey: "secret-token",
      agentIdentifier: "aa",
      sellerVKey: "bb",
      network: "Preprod",
      paymentSourceType: "Web3CardanoV2",
      supportedPaymentSourceIndex: 0,
      workMs: 60_000,
      fetch: fakeFetch,
      now: () => now,
    });
    const terms = await backend.create({ job_id: "j", identifier_from_purchaser: "abcdef0123456789", input_hash: "cc".repeat(32) });
    expect(calls[0]?.url).toBe("http://pay/api/v1/payment");
    expect((calls[0]?.init.headers as Record<string, string>)["token"]).toBe("secret-token");
    expect(terms.submitResultTime - terms.payByTime).toBeGreaterThanOrEqual(5 * 60_000);
    expect(terms.submitResultTime - now).toBeGreaterThanOrEqual(15 * 60_000);
    expect(terms.unlockTime - terms.submitResultTime).toBeGreaterThanOrEqual(15 * 60_000);
    expect(terms.externalDisputeUnlockTime - terms.unlockTime).toBeGreaterThanOrEqual(15 * 60_000);
    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({ paymentSourceType: "Web3CardanoV2", supportedPaymentSourceIndex: 0, network: "Preprod" });
  });
});

describe("coseSigner", () => {
  it("produces exactly the bytes of the seed signer and refuses a mismatched key", async () => {
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    const { coseSigner } = await import("../src/cose-signer.js");
    const seed = new Uint8Array(32).fill(7);
    const local = localKeySigner(seed);
    const raw = coseSigner({ address: local.address, publicKey: ed25519.getPublicKey(seed), sign: (m) => ed25519.sign(m, seed) });
    const payload = new Uint8Array(32).fill(3);
    expect(await raw.signHash(payload)).toBe(await local.signHash(payload));
    expect(raw.coseKey).toBe(local.coseKey);
    expect(() => coseSigner({ address: local.address, publicKey: ed25519.getPublicKey(new Uint8Array(32).fill(8)), sign: () => new Uint8Array(64) })).toThrow(/does not control/);
  });
});
