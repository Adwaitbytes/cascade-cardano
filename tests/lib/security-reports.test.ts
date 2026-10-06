import { describe, expect, it } from "vitest";
import { openCriticalOrHigh, reviewReportFindings, securityFindings } from "./security-reports.js";

const REPORT = `
| ID | Fix in \`abc1234\` | Tests |
| --- | --- | --- |
| E1 (critical, double satisfaction) | Payouts carry no datum. | \`e1_test\` |
| E2 (high) | pending | n/a |
| E13 (low) | Accepted and documented. | n/a |
| Item 11 | Property tests. | \`prop_x\` |

| ID | Severity | Fix in \`0000000\` | Tests |
| --- | --- | --- | --- |
| F9 | High | Rewritten. | \`f9\` |

| Finding | Risk | Resolution | Fix commits | Tests |
| --- | --- | --- | --- | --- |
| \`P\` return path | broad wallet | fence | pending (W2) | pending |
`;

describe("review report parsing", () => {
  const found = reviewReportFindings(REPORT, "test", (sha) => sha === "abc1234");
  const byId = new Map(found.map((f) => [f.id, f]));

  it("reads every finding row and skips non-finding rows", () => {
    expect([...byId.keys()].sort()).toEqual(["E1", "E13", "E2", "F9", "P return path"]);
  });

  it("takes severity from the ID parenthesis or the Severity column", () => {
    expect(byId.get("E1")?.severity).toBe("critical");
    expect(byId.get("F9")?.severity).toBe("high");
    expect(byId.get("P return path")?.severity).toBe("unrated");
  });

  it("marks a row Fixed only when its commit exists, and keeps pending rows open", () => {
    expect(byId.get("E1")?.verdict).toBe("Fixed");
    expect(byId.get("E2")?.verdict).toBe("Open");
    expect(byId.get("E13")?.verdict).toBe("Accepted");
    expect(byId.get("F9")?.verdict).toBe("Open");
  });

  it("flags open critical or high findings", () => {
    expect(openCriticalOrHigh(found).map((f) => f.id).sort()).toEqual(["E2", "F9"]);
  });
});

describe("security/ in this repository", () => {
  const findings = securityFindings();

  it("counts the evaluator's E1 from security/review-report.md as a fixed critical", () => {
    const e1 = findings.find((f) => f.id === "E1");
    expect(e1).toMatchObject({ severity: "critical", source: "security/review-report.md", verdict: "Fixed" });
  });

  it("keeps the audit's severity and the re-review's verdict for F1", () => {
    expect(findings.find((f) => f.id === "F1")).toMatchObject({ severity: "Critical", verdict: "Fixed" });
  });
});
