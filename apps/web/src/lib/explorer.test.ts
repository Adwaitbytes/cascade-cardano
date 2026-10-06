import { describe, expect, it } from "vitest";
import { shortHash, txUrl, utxoUrl } from "./explorer";

const TX = "ab".repeat(32);

describe("explorer links", () => {
  it("builds Cardanoscan preprod transaction links", () => expect(txUrl(TX)).toBe(`https://preprod.cardanoscan.io/transaction/${TX}`));
  it("refuses anything that is not a transaction id", () => {
    expect(() => txUrl("../../evil")).toThrow();
    expect(() => txUrl(TX.toUpperCase())).toThrow();
  });
  it("links an output reference to its transaction", () => expect(utxoUrl(`${TX}#3`)).toContain(TX));
  it("shortens hashes", () => expect(shortHash(TX)).toBe("abababab…ababab"));
});
