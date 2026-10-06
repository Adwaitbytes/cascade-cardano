import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeVectors } from "./vectors.js";

describe("vectors.json", () => {
  it("matches the vectors computed by this package (run `pnpm vectors` after an intended change)", () => {
    const stored: unknown = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
    expect(stored).toEqual(JSON.parse(JSON.stringify(computeVectors())));
  });
});
