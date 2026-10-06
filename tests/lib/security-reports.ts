/**
 * Reads the security reports in security/ and counts open critical and high findings (A19).
 *
 * Sources, in order:
 * - security/audit-*.md: rows `| ID | Severity | ...` give each finding and its severity.
 * - security/review-report.md: every finding table (first header cell `ID` or `Finding`, with a
 *   `Fix ...` column). Severity comes from a `Severity` column or the ID cell's parenthesis
 *   (`E1 (critical, ...)`); a row is Fixed when its fix cell or the column header names a commit
 *   that exists in this repository and the cell is not pending, Accepted when the cell says so,
 *   and Open otherwise. This is where the evaluator findings (E1 to E14) live.
 * - security/re-review-*.md: rows `| ID | Verdict | ...`; later files (by name, which is dated)
 *   override earlier ones, and a re-review verdict overrides the review report's.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { REPO_ROOT, repoPath } from "./repo.js";

export interface Finding {
  id: string;
  severity: string;
  source: string;
  verdict: string | null;
}

const ROW = /^\|\s*([A-Z]+\d+)\s*\|\s*([A-Za-z ]+?)\s*\|/gm;
const SEVERITY = /^(critical|high|medium|low|info)/i;
const SHA = /`([0-9a-f]{7,40})`/;

function rows(text: string): [string, string][] {
  return [...text.matchAll(ROW)].map((m) => [m[1]!, m[2]!]);
}

const cells = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** True when `sha` names a commit in this repository. */
export function commitExists(sha: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: REPO_ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Findings from the tables of a review report (format in the module comment). */
export function reviewReportFindings(text: string, source: string, hasCommit: (sha: string) => boolean = commitExists): Finding[] {
  const out: Finding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim().startsWith("|") || !/^\|\s*-/.test(lines[i + 1]?.trim() ?? "")) continue;
    const header = cells(line);
    const kind = header[0]?.toLowerCase();
    const fixCol = header.findIndex((h) => /^fix/i.test(h));
    if ((kind !== "id" && kind !== "finding") || fixCol === -1) continue;
    const severityCol = header.findIndex((h) => /^severity$/i.test(h));
    const headerSha = SHA.exec(header[fixCol]!)?.[1] ?? null;
    let j = i + 2;
    for (; j < lines.length && lines[j]!.trim().startsWith("|"); j++) {
      const row = cells(lines[j]!);
      const idCell = row[0] ?? "";
      const id = kind === "id" ? /^([A-Z]+\d+)\b/.exec(idCell)?.[1] : idCell.replace(/`/g, "");
      if (id === undefined || id === "") continue;
      const inline = /\(([^)]*)\)/.exec(idCell)?.[1]?.split(",")[0]?.trim() ?? "";
      const stated = severityCol === -1 ? inline : (row[severityCol] ?? "");
      const severity = SEVERITY.test(stated) ? SEVERITY.exec(stated)![1]!.toLowerCase() : "unrated";
      const fix = row[fixCol] ?? "";
      const sha = SHA.exec(fix)?.[1] ?? headerSha;
      let verdict: string;
      if (/pending/i.test(fix) || fix === "") verdict = "Open";
      else if (/^accepted/i.test(fix)) verdict = "Accepted";
      else if (/^not changed/i.test(fix)) verdict = "Not fixed";
      else verdict = sha !== null && hasCommit(sha) ? "Fixed" : "Open";
      out.push({ id, severity, source, verdict });
    }
    i = j - 1;
  }
  return out;
}

export function securityFindings(): Finding[] {
  const dir = repoPath("security");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).sort();
  const findings = new Map<string, Finding>();
  for (const f of files.filter((n) => /^audit-.*\.md$/.test(n))) {
    for (const [id, severity] of rows(readFileSync(repoPath("security", f), "utf8"))) {
      if (SEVERITY.test(severity)) findings.set(id, { id, severity, source: `security/${f}`, verdict: null });
    }
  }
  if (files.includes("review-report.md")) {
    for (const r of reviewReportFindings(readFileSync(repoPath("security", "review-report.md"), "utf8"), "security/review-report.md")) {
      const known = findings.get(r.id);
      if (known === undefined) findings.set(r.id, r);
      else if (known.verdict === null) known.verdict = r.verdict;
    }
  }
  for (const f of files.filter((n) => /^re-review-.*\.md$/.test(n))) {
    for (const [id, verdict] of rows(readFileSync(repoPath("security", f), "utf8"))) {
      const finding = findings.get(id);
      if (finding !== undefined) finding.verdict = verdict;
    }
  }
  return [...findings.values()];
}

export function openCriticalOrHigh(findings: Finding[]): Finding[] {
  return findings.filter((f) => /^(critical|high)$/i.test(f.severity) && f.verdict?.toLowerCase() !== "fixed");
}
