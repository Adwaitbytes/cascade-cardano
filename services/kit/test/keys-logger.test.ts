import { Writable } from "node:stream";
import { hexToBytes, sha256, utf8, verifyCose1 } from "@cascade/shared";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { REDACT_PATHS, coseSign1, deriveRoleKey, parseWalletsFile, safeUrl } from "../src/index.js";

// Yaci DevKit's public default mnemonic (docs/research/yaci-devkit.md); not a secret.
const YACI_MNEMONIC = "test test test test test test test test test test test test test test test test test test test test test test test sauce";

describe("role keys", () => {
  it("derives the Yaci default wallet #0 at account index 0", () => {
    const k = deriveRoleKey(YACI_MNEMONIC, 0, "local");
    expect(k.address).toBe("addr_test1qryvgass5dsrf2kxl3vgfz76uhp83kv5lagzcp29tcana68ca5aqa6swlq6llfamln09tal7n5kvt4275ckwedpt4v7q48uhex");
    expect(k.paymentKeyHash).toMatch(/^[0-9a-f]{56}$/);
    expect(JSON.stringify(k)).not.toMatch(/sk|mnemonic|test test/);
  });

  it("signs COSE_Sign1 that the shared verifier accepts, including the key-to-address check", () => {
    const k = deriveRoleKey(YACI_MNEMONIC, 15, "local");
    const payload = sha256(utf8("receipt"));
    const sig = coseSign1(payload, k);
    expect(verifyCose1(sig, { payload, address: k.address })).toEqual({ ok: true, publicKey: k.publicKey });
    const other = deriveRoleKey(YACI_MNEMONIC, 16, "local");
    expect(verifyCose1(sig, { payload, address: other.address }).ok).toBe(false);
    expect(verifyCose1(sig, { payload: hexToBytes("00".repeat(32)), address: k.address }).ok).toBe(false);
  });

  it("parses the wallets file in list or map form", () => {
    expect(parseWalletsFile({ wallets: [{ role: "scout", accountIndex: 3, address: "addr_test1x" }] })).toEqual([
      { role: "scout", accountIndex: 3, address: "addr_test1x" },
    ]);
    expect(parseWalletsFile({ scout: { accountIndex: 3 } })).toEqual([{ role: "scout", accountIndex: 3 }]);
  });
});

describe("logger redaction", () => {
  it("never writes secrets or payment headers", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: "[redacted]" } }, sink);
    log.info({ mnemonic: "abandon abandon", headers: { "payment-signature": "eyJ4" }, nested: { privateKey: "ed25519_sk1" }, ok: 1 }, "x");
    const out = lines.join("");
    expect(out).not.toContain("abandon");
    expect(out).not.toContain("eyJ4");
    expect(out).not.toContain("ed25519_sk1");
    expect(out).toContain('"ok":1');
  });

  it("masks database passwords", () => {
    expect(safeUrl("postgres://cascade:hunter2@localhost:55432/cascade")).toBe("postgres://cascade:***@localhost:55432/cascade");
  });
});
