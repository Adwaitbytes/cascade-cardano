import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCEPTANCE, ACCEPTANCE_IDS } from "./catalog.js";
import { repoPath } from "./repo.js";

describe("acceptance catalog", () => {
  it("matches PRD section 19.2 word for word", () => {
    const prd = readFileSync(repoPath("docs", "PRD.md"), "utf8");
    const rows = [...prd.matchAll(/^- \[[ x]\] \*\*(A\d+) ([^*]+)\.\*\* (.+)$/gm)].map((m) => ({
      id: m[1],
      title: m[2],
      criterion: m[3],
    }));
    expect(rows.map((r) => r.id)).toEqual([...ACCEPTANCE_IDS]);
    for (const row of rows) {
      const spec = ACCEPTANCE[row.id as keyof typeof ACCEPTANCE];
      expect({ id: row.id, title: spec.title, criterion: spec.criterion }).toEqual(row);
    }
  });
});
