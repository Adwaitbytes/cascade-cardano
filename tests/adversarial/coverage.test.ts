import { describe, it } from "vitest";
import { notImplemented } from "../lib/not-implemented.js";

/**
 * Sections of tests/adversarial/README.md that have no cases yet. Remove a section here in the same
 * commit that adds its cases; the suite stays red until every section is covered.
 */
const UNCOVERED: string[] = [];

describe("adversarial coverage", () => {
  it("has cases for every section of the mutation design", () => {
    if (UNCOVERED.length > 0) notImplemented(`adversarial cases for: ${UNCOVERED.join("; ")}`);
  });
});
