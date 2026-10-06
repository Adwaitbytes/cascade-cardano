import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_IDS,
  parseOpenBlockers,
  parseTestResults,
  pickKeyTx,
  renderAcceptanceTable,
  ReportInputError,
  summariseEvidence,
  type AcceptanceRow,
} from "../final-report.js";

const COMMIT = "dcac7f3df35d9ee74cd7aaf924dbe434deec9339";
const FUND = "a".repeat(64);
const DRAW = "b".repeat(64);

function results(passing: ReadonlySet<string> = new Set()): Record<string, unknown> {
  return Object.fromEntries(
    ACCEPTANCE_IDS.map((id) => [id, { passes: passing.has(id), evidence: `evidence/${id}/result.json`, commit: COMMIT }]),
  );
}

describe("parseTestResults", () => {
  it("returns A1 to A20 in order, keeping failures", () => {
    const entries = parseTestResults(results(new Set(["A2"])));
    expect(entries.map((e) => e.id)).toEqual(ACCEPTANCE_IDS);
    expect(entries[0]?.passes).toBe(false);
    expect(entries[1]?.passes).toBe(true);
  });

  it("fails loudly when an entry is absent or malformed", () => {
    const missing = results();
    delete missing.A7;
    expect(() => parseTestResults(missing)).toThrow(ReportInputError);
    expect(() => parseTestResults(missing)).toThrow("A7");
    expect(() => parseTestResults({ ...results(), A3: { passes: "yes" } })).toThrow(ReportInputError);
    expect(() => parseTestResults(null)).toThrow(ReportInputError);
  });
});

describe("pickKeyTx", () => {
  it("prefers the first transaction that is not FundRoot", () => {
    const evidence = {
      transactions: [
        { label: "FundRoot", tx_hash: FUND },
        { label: "Draw | child", tx_hash: DRAW },
      ],
    };
    expect(pickKeyTx(evidence)).toEqual({ label: "Draw | child", hash: DRAW });
  });

  it("falls back to FundRoot, and to null when nothing is recorded", () => {
    expect(pickKeyTx({ transactions: [{ label: "FundRoot", tx_hash: FUND }] })?.hash).toBe(FUND);
    expect(pickKeyTx({ transactions: [] })).toBeNull();
    expect(pickKeyTx({ transactions: [{ tx_hash: "not-a-hash" }] })).toBeNull();
  });
});

describe("renderAcceptanceTable", () => {
  const rows: AcceptanceRow[] = [
    {
      id: "A1",
      passes: true,
      evidence: "evidence/A1/result.json",
      commit: COMMIT,
      evidenceSummary: summariseEvidence({
        title: "Happy path",
        transactions: [
          { label: "FundRoot", tx_hash: FUND },
          { label: "Draw | child", tx_hash: DRAW },
        ],
      }),
    },
    { id: "A2", passes: false, evidence: "evidence/A2/result.json", commit: COMMIT, evidenceSummary: null },
    {
      id: "A3",
      passes: false,
      evidence: "evidence/A3/result.json",
      commit: COMMIT,
      evidenceSummary: summariseEvidence({ title: "Masumi leaf", transactions: [] }),
    },
  ];
  const lines = renderAcceptanceTable(rows).split("\n");

  it("renders one row per test with header", () => {
    expect(lines).toHaveLength(2 + rows.length);
    expect(lines[0]).toBe("| Test | Title | Result | Evidence | Key tx |");
  });

  it("links evidence and the key tx on Cardanoscan, escaping pipes", () => {
    expect(lines[2]).toBe(
      `| A1 | Happy path | PASS | [evidence/A1/result.json](evidence/A1/result.json) | ` +
        `[bbbbbbbbbb...bbbbbb](https://preprod.cardanoscan.io/transaction/${DRAW}) Draw \\| child |`,
    );
  });

  it("renders failures and missing evidence honestly", () => {
    expect(lines[3]).toBe("| A2 |  | FAIL | evidence/A2/result.json (file missing) | none recorded |");
    expect(lines[4]).toContain("| FAIL |");
    expect(lines[4]).toContain("none recorded");
  });
});

describe("parseOpenBlockers", () => {
  const markdown = [
    "# BLOCKERS",
    "## B1 Test ADA",
    "- Human action: use the faucet.",
    "## B2 Key missing",
    "- Human action: add the key.",
    "## B6 Upstream bug",
    "- Human action (optional): report upstream.",
    "## B7 Vercel access",
    "Fix: log in. Resolved 2026-10-02: deployed.",
    "Resolved 2026-10-02: deployed.",
    "## Resolved (2026-10-01)",
    "- B1 resolved: funded.",
    "- B2 partly resolved: fallback provider.",
  ].join("\n");

  it("keeps unresolved and partly resolved blockers with their human action", () => {
    expect(parseOpenBlockers(markdown)).toEqual([
      { id: "B2", title: "Key missing", status: "partly resolved", humanAction: "add the key." },
      { id: "B6", title: "Upstream bug", status: "open", humanAction: "report upstream." },
    ]);
  });
});
