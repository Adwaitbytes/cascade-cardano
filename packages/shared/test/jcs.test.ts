import { describe, expect, it } from "vitest";
import { jcs, jcsSha256Hex } from "../src/jcs.js";

describe("RFC 8785 JCS", () => {
  // Escapes are assembled from parts so the RFC text survives any tooling byte for byte.
  const bs = String.fromCharCode(92);
  const u = (hex: string) => `${bs}u${hex}`;
  const ch = (code: number) => String.fromCharCode(code);

  it("section 3.2.2 example", () => {
    const str = `${u("20ac")}$${u("000F")}${u("000a")}A'${u("0042")}${u("0022")}${u("005c")}${bs}${bs}${bs}"${bs}/`;
    const input = `{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], "string": "${str}", "literals": [null, true, false]}`;
    const expectedString = `${ch(0x20ac)}$${u("000f")}${bs}nA'B${bs}"${bs}${bs}${bs}${bs}${bs}"/`;
    const expected = `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"${expectedString}"}`;
    expect(jcs(JSON.parse(input))).toBe(expected);
  });

  it("section 3.2.3 property sorting by UTF-16 code units", () => {
    const entries: [string, string][] = [
      [u("20ac"), "Euro Sign"],
      [`${bs}r`, "Carriage Return"],
      [u("fb33"), "Hebrew Letter Dalet With Dagesh"],
      ["1", "One"],
      [`${u("d83d")}${u("de00")}`, "Emoji: Grinning Face"],
      [u("0080"), "Control"],
      [u("00f6"), "Latin Small Letter O With Diaeresis"],
    ];
    const input = `{${entries.map(([k, v]) => `"${k}":"${v}"`).join(",")}}`;
    const expected =
      `{"${bs}r":"Carriage Return","1":"One","${ch(0x80)}":"Control","${ch(0xf6)}":"Latin Small Letter O With Diaeresis",` +
      `"${ch(0x20ac)}":"Euro Sign","${ch(0xd83d)}${ch(0xde00)}":"Emoji: Grinning Face","${ch(0xfb33)}":"Hebrew Letter Dalet With Dagesh"}`;
    expect(jcs(JSON.parse(input))).toBe(expected);
  });

  it("appendix B number serialization", () => {
    const cases: [number, string][] = [
      [0, "0"],
      [-0, "0"],
      [5e-324, "5e-324"],
      [1.7976931348623157e308, "1.7976931348623157e+308"],
      [9007199254740992, "9007199254740992"],
      [295147905179352830000, "295147905179352830000"],
      [1e21, "1e+21"],
      [1e-7, "1e-7"],
      [0.000001, "0.000001"],
    ];
    for (const [n, s] of cases) expect(jcs(n)).toBe(s);
  });

  it("rejects values JSON cannot carry", () => {
    expect(() => jcs(1n)).toThrow(TypeError);
    expect(() => jcs({ a: Number.NaN })).toThrow(TypeError);
    expect(() => jcs([Infinity])).toThrow(TypeError);
    expect(() => jcs(new Date(0))).toThrow(TypeError);
  });

  it("hash is independent of key order", () => {
    expect(jcsSha256Hex({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(jcsSha256Hex({ a: [2, { c: 4, d: 3 }], b: 1 }));
  });

  it("matches the x402 raw-part digest vector style: sha256 of UTF-8(JCS)", () => {
    expect(jcsSha256Hex({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  });
});
