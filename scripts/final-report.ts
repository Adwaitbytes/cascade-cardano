// Generates FINAL_REPORT.md (MASTER_PROMPT section 13) from the repo's own records:
// test-results.json, evidence/*/result.json, deployments/preprod.json, demo/out/cascade-demo.json
// and BLOCKERS.md. Reads public files only; never .env.
//
// Usage: npx tsx scripts/final-report.ts   (or pnpm report:final)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CARDANOSCAN_TX = "https://preprod.cardanoscan.io/transaction/";
const TX_HASH = /^[0-9a-f]{64}$/;

export const ACCEPTANCE_IDS = Array.from({ length: 20 }, (_, i) => `A${i + 1}`);

export class ReportInputError extends Error {
  override name = "ReportInputError";
}

export interface AcceptanceEntry {
  id: string;
  passes: boolean;
  evidence: string;
  commit: string;
}

export interface KeyTx {
  label: string;
  hash: string;
}

export interface EvidenceSummary {
  title: string | null;
  keyTx: KeyTx | null;
  transactionCount: number;
}

export interface AcceptanceRow extends AcceptanceEntry {
  evidenceSummary: EvidenceSummary | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Validates test-results.json and returns A1..A20 in order. Throws if any entry is absent or malformed. */
export function parseTestResults(raw: unknown): AcceptanceEntry[] {
  if (!isRecord(raw)) throw new ReportInputError("test-results.json is not a JSON object");
  const missing = ACCEPTANCE_IDS.filter((id) => !(id in raw));
  if (missing.length > 0) throw new ReportInputError(`test-results.json lacks ${missing.join(", ")}`);
  return ACCEPTANCE_IDS.map((id) => {
    const entry = raw[id];
    if (!isRecord(entry)) throw new ReportInputError(`test-results.json ${id} is not an object`);
    const evidence = stringField(entry, "evidence");
    const commit = stringField(entry, "commit");
    if (typeof entry.passes !== "boolean" || evidence === null || commit === null) {
      throw new ReportInputError(`test-results.json ${id} needs passes (boolean), evidence and commit (strings)`);
    }
    return { id, passes: entry.passes, evidence, commit };
  });
}

/**
 * Picks the transaction that best stands for the test: an explicit key or primary tx if the evidence
 * names one, else the first transaction that is not the tree's FundRoot (funding is common to every
 * test), else the first transaction.
 */
export function pickKeyTx(evidence: unknown): KeyTx | null {
  if (!isRecord(evidence)) return null;
  for (const key of ["key_tx", "primary_tx", "tx_hash", "txHash"]) {
    const hash = stringField(evidence, key);
    if (hash !== null && TX_HASH.test(hash)) return { label: key, hash };
  }
  const txs = Array.isArray(evidence.transactions) ? evidence.transactions : [];
  const candidates: KeyTx[] = txs.flatMap((tx) => {
    if (!isRecord(tx)) return [];
    const hash = stringField(tx, "tx_hash") ?? stringField(tx, "txHash");
    if (hash === null || !TX_HASH.test(hash)) return [];
    return [{ label: stringField(tx, "label") ?? "", hash }];
  });
  return candidates.find((tx) => !/^fundroot$/i.test(tx.label.trim())) ?? candidates[0] ?? null;
}

export function summariseEvidence(evidence: unknown): EvidenceSummary {
  const record = isRecord(evidence) ? evidence : {};
  return {
    title: stringField(record, "title"),
    keyTx: pickKeyTx(evidence),
    transactionCount: Array.isArray(record.transactions) ? record.transactions.length : 0,
  };
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

export function renderAcceptanceTable(rows: AcceptanceRow[]): string {
  const lines = [
    "| Test | Title | Result | Evidence | Key tx |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    const summary = row.evidenceSummary;
    const title = summary?.title ?? "";
    const evidence = summary === null ? `${row.evidence} (file missing)` : `[${row.evidence}](${row.evidence})`;
    const keyTx = summary?.keyTx;
    const tx = keyTx
      ? `[${shortHash(keyTx.hash)}](${CARDANOSCAN_TX}${keyTx.hash})${keyTx.label ? ` ${keyTx.label}` : ""}`
      : "none recorded";
    lines.push(`| ${row.id} | ${cell(title)} | ${row.passes ? "PASS" : "FAIL"} | ${cell(evidence)} | ${cell(tx)} |`);
  }
  return lines.join("\n");
}

export interface Blocker {
  id: string;
  title: string;
  status: "open" | "partly resolved";
  humanAction: string;
}

/** Returns blockers from BLOCKERS.md that no "resolved" note closes. Updates to one id are merged. */
export function parseOpenBlockers(markdown: string): Blocker[] {
  const sections = new Map<string, { title: string; body: string[] }>();
  let current: string | null = null;
  for (const line of markdown.split("\n")) {
    const heading = /^## (B\d+)\b\s*(.*)$/.exec(line);
    if (heading?.[1]) {
      current = heading[1];
      const existing = sections.get(current);
      if (existing) existing.body.push(line);
      else sections.set(current, { title: (heading[2] ?? "").replace(/^update\b.*$/i, "").trim(), body: [] });
      continue;
    }
    if (/^## /.test(line)) current = null;
    else if (current) sections.get(current)?.body.push(line);
  }
  const blockers: Blocker[] = [];
  for (const [id, { title, body }] of sections) {
    const text = body.join("\n");
    const partly = new RegExp(`\\b${id} partly resolved\\b`, "i").test(markdown);
    const resolved = new RegExp(`(^|\\s)${id} resolved\\b`, "im").test(markdown) || /^-?\s*Resolved\b/im.test(text);
    if (resolved && !partly) continue;
    const action = /^- Human action[^:]*:\s*(.+)$/im.exec(text)?.[1] ?? /\bFix:\s*(.+)$/im.exec(text)?.[1] ?? "none recorded";
    blockers.push({ id, title: title || id, status: partly ? "partly resolved" : "open", humanAction: action.trim() });
  }
  return blockers;
}

interface ScriptDeployment {
  hash: string;
  sizeBytes: number | null;
  referenceUtxo: string | null;
}

function parseScripts(deployment: Record<string, unknown>): Map<string, ScriptDeployment> {
  const scripts = deployment.scripts;
  if (!isRecord(scripts)) throw new ReportInputError("deployments/preprod.json has no scripts object");
  const out = new Map<string, ScriptDeployment>();
  for (const [name, value] of Object.entries(scripts)) {
    if (!isRecord(value)) continue;
    const hash = stringField(value, "hash");
    if (hash === null) throw new ReportInputError(`deployments/preprod.json script ${name} has no hash`);
    const ref = value.referenceUtxo;
    const refTx = isRecord(ref) ? stringField(ref, "txHash") : null;
    const refIndex = isRecord(ref) && typeof ref.outputIndex === "number" ? ref.outputIndex : null;
    out.set(name, {
      hash,
      sizeBytes: typeof value.sizeBytes === "number" ? value.sizeBytes : null,
      referenceUtxo: refTx !== null && refIndex !== null ? `${refTx}#${refIndex}` : null,
    });
  }
  return out;
}

function link(label: string, url: string | null): string {
  return url ? `- ${label}: ${url}` : `- ${label}: not recorded`;
}

const WHAT_SHIPPED = `Cascade is escrow trees for the agent supply chain on Cardano. A buyer locks one budget in a root escrow; a prime agent, the Conductor, splits it into child escrows for the agents it hires, and those agents can hire sub-agents the same way. Every node is its own UTxO with a thread token, budget, nested deadlines and an acceptance rule, enforced by Aiken validators (\`cascade_node\` with three logic withdraw scripts, \`cascade_config\`, \`cascade_bond\`, \`cascade_channel\`) deployed as reference scripts on preprod. Around them ship the TypeScript SDK and x402 Cardano buy and sell sides, an x402 facilitator, indexer, watchtower and policy signer, the Conductor orchestrator with reference agents, unmodified Masumi agents hired through a plan-bound purchase wallet, voucher channels for metered calls, an MCP server and CLI, and a Next.js web app with buyer console, live tree explorer, receipts and an agent directory.`;

// Curated from DECISIONS.md and docs/research/SUMMARY.md; each item names its source entry.
const PRD_DEVIATIONS: readonly string[] = [
  "Node logic is split into a `cascade_node` shell plus `cascade_logic_core`, `cascade_logic_draw` and `cascade_logic_ext` withdraw validators, because one script compiled to 23,286 bytes, above the 16,384 byte tx limit (PRD 7.1; DECISIONS, ADR 0001 1.3).",
  "The config token is minted under the node policy and `cascade_config` spends only when the token burns; a literal always-fails spend would make the PRD's own CloseRoot and Cancel impossible (PRD 7.1, 7.5).",
  "`challenge_until` is fixed at Draw, not at Submit, so every deadline is nested before money moves (PRD 7.5).",
  "Verifiers are siblings of the node they check, not its children, since a child would block Submit through invariant 5 (PRD 5.5, 11.1).",
  "`AddressPayment` leaf kind added so A5 can pay a plan-bound, non-operator key address from the tree; invariant 2 restated (PRD 7.6, 8.1).",
  "Audit and evaluator fixes changed datums: `NodeDatum.spent`, `TreeConfig.min_dispute_window`, `PlanLeaf.acceptance_hash`, `CloseRoot.protocol_lovelace`; receipts carry `external_ref = None` because a datum cannot name its own tx (PRD 7.4).",
  "Unmodified Masumi agents are hired through a plan-bound purchase wallet that makes a plain `vested_pay` lock, because the Masumi Payment Service ignores locks created in transactions with redeemers (B6). Their 24 to 36 h Masumi deadlines are not nested in the parent window (PRD 7.7, 8.5; ADR 0001 8.1).",
  "The x402 `masumi` method is used only on Cascade's sell side (A6); an x402 `masumi` lock signs terms the Masumi Payment Service rejects (PRD 3.3, 8.5; research #1).",
  "Metered leaves use Cascade's own `cascade_channel` instead of Subbit, which needs stdlib v3.1.0 and lets the deposit leave the tree on close (PRD 8.6; research #2).",
  "Cascade runs its own x402 facilitator: no hosted facilitator lists Cardano and third-party ones reject minting transactions (PRD 8.4; research #3).",
  "MIP-003 has 6 endpoints, not 5; all 6 are served and `input_hash` follows MIP-004 (PRD 9.1; research #4).",
  "Product LLM calls go through OpenRouter with a 3 USD spend guard and a labelled deterministic fallback, because no Anthropic key exists (PRD 10.1, 21.1; B2).",
  "Watchtower crank tips from structural ADA are deferred so reconciliation stays exact (PRD 11.5).",
  "Preprod services run on the operator machine with Neon Postgres; the public web app on Vercel reads Neon through `/api/v1/*` and polls when the live stream is unreachable (PRD 14, 18.1).",
  "Lisan (the unmodified CrewAI Masumi template) runs behind a disclosed payment-source shim and pinned Python dependencies; template code is untouched (PRD 21.1; research #6).",
  "A4 runs in two phases because Masumi forbids WithdrawRefund before `submit_result_time` (+24 h, fixed by the template); phase 1 is recorded ahead under evidence/A4/pending/ (PRD 19.2 A4).",
  "A16 rollback on Yaci uses snapshot rollback; the indexer treats a reconnect with a stale point as a rollback (research #12).",
  "Preprod trees are funded in lovelace because the treasury holds no preprod tUSDM; the 6-decimal token path is tested on Yaci (PRD 8.7).",
];

const SECURITY_SECTION = `Sources: \`security/audit-2026-10-01-21f7228.md\`, \`security/re-review-2026-10-01-814cc42.md\`, \`security/review-report.md\`, \`security/threat-model.md\`.

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| F1 | Critical | \`committed\` never returned to 0 after payouts below a node, so any tree deeper than one level locked for good | Fixed in 814cc42 (\`NodeDatum.spent\`, \`budget\` never decreases); re-review confirms |
| F2 | Critical | A forced reward balance on a logic credential made every zero-withdrawal tx fail | Fixed in 814cc42 (credential presence, any amount); re-review confirms |
| F3 | Medium | CloseRoot protocol-fee output had to carry zero lovelace, stuck under min-UTxO when the fee is on | Fixed in 814cc42 (\`protocol_lovelace\`, capped); re-review confirms |
| F4 | Medium | Receipt operator could close a Metered channel before \`timeout\` and erase unredeemed vouchers | Fixed in 814cc42 (provider signature or after \`timeout\`); re-review confirms |
| F5 | Medium | With no or silent arbiters a challenge cost nothing | Fixed in 814cc42 (arbiter threshold at least 1 with Native leaves; Disputed exit pays the worker its fee); re-review confirms |
| E1 | Critical | Cross-script double satisfaction: one Masumi-tagged output could satisfy a Cascade payout and a Masumi \`WithdrawRefund\` at once | Fixed in ddeab4b: every Cascade key-address payout must carry no datum and no reference script; Aiken \`e1_*\` tests and adversarial T2 cases |
| E6, E7, E8, E12, E14 | Medium and low | Dispute window floor, plan-bound acceptance keys, Masumi seller return to key address, Resolve deadline exit lovelace, fee addresses and channel timeout floor | Fixed in ddeab4b with regression tests |
| E13 | Low | Stake part of an AddressPayment payee not enforced | Accepted and documented |
| L1 | Low | An operator can re-hire itself through leaf reuse up to \`max_fee\` per hire | Accepted on chain: plan leaves bind tasks, not agents; off-chain signer plan-match and counterparty gates and buyer plan review (ADR 3), tested in \`packages/policy/test/gates.test.ts\` |
| L2 | Low | A slash share below min-UTxO can make SlashBond unbuildable | Accepted: ReturnBond always works, nothing is stuck; arbiters choose a buildable ruling |
| P1 to P3 | Off chain | Masumi purchase wallet: crash gap after Draw to P, scope of P's return path, refund liveness | Fixed in 3fb4142 (signer return rule), 1f3514e (SDK), 75a0739 (orchestrator), bac8601 (watchtower refund crank) |

Re-review low notes (accepted): a Disputed node whose arbiters miss \`dispute_until\` pays the worker its fee, since arbiters are trusted for liveness and the watchtower alerts them; Masumi locks are linked off chain by draw tx and output index.`;

export interface DemoRecording {
  treeId: string | null;
  explorer: string | null;
  receipt: string | null;
  recordedAt: string | null;
  failure: string | null;
}

export function parseDemo(raw: unknown): DemoRecording {
  const record = isRecord(raw) ? raw : {};
  return {
    treeId: stringField(record, "treeId"),
    explorer: stringField(record, "explorer"),
    receipt: stringField(record, "receipt"),
    recordedAt: stringField(record, "recordedAt"),
    failure: stringField(record, "failure"),
  };
}

export function loadAcceptanceRows(root: string): AcceptanceRow[] {
  const resultsPath = resolve(root, "test-results.json");
  if (!existsSync(resultsPath)) throw new ReportInputError("test-results.json is missing; run pnpm verify:all first");
  return parseTestResults(readJson(resultsPath)).map((entry) => {
    const evidencePath = resolve(root, entry.evidence);
    return { ...entry, evidenceSummary: existsSync(evidencePath) ? summariseEvidence(readJson(evidencePath)) : null };
  });
}

export function buildReport(root: string): { markdown: string; passed: number } {
  const rows = loadAcceptanceRows(root);
  const deployment = readJson(resolve(root, "deployments/preprod.json"));
  if (!isRecord(deployment)) throw new ReportInputError("deployments/preprod.json is not a JSON object");
  const urls = isRecord(deployment.urls) ? deployment.urls : {};
  const url = (key: string): string | null => stringField(urls, key);
  const demoPath = resolve(root, "demo/out/cascade-demo.json");
  const demo = parseDemo(existsSync(demoPath) ? readJson(demoPath) : null);
  const scripts = parseScripts(deployment);
  const blockers = parseOpenBlockers(readFileSync(resolve(root, "BLOCKERS.md"), "utf8"));

  const commits = [...new Set(rows.map((row) => row.commit))];
  const passed = rows.filter((row) => row.passes).length;

  const demoLines = demo.treeId
    ? [link("Explorer, demo tree", demo.explorer ?? url("explorer_demo_tree")), link("Receipt, demo tree", demo.receipt ?? url("receipt"))]
    : [
        `- Explorer and receipt for the demo tree: recording pending (demo/out/cascade-demo.json has no tree${
          demo.recordedAt ? `; last attempt ${demo.recordedAt} did not finish` : ""
        })`,
      ];

  const scriptRows = [...scripts].map(
    ([name, s]) => `| \`${name}\` | \`${s.hash}\` | ${s.sizeBytes ?? ""} | ${s.referenceUtxo ? `\`${s.referenceUtxo}\`` : "none"} |`,
  );

  const sections = [
    "# Cascade final report",
    "",
    "## 1. What shipped",
    "",
    WHAT_SHIPPED,
    "",
    "## 2. Public URLs",
    "",
    link("Console", url("console")),
    ...demoLines,
    link("Directory API", url("directory_api")),
    link("Ops status", url("ops_status")),
    link("Deployment record API", url("deployment_api")),
    link("Agents gateway", url("agents_base")),
    `- Web app commit deployed: ${url("commit") ?? "not recorded"}`,
    "",
    "## 3. Deployed script hashes and reference UTxOs (preprod)",
    "",
    `Aiken ${stringField(deployment, "aikenVersion") ?? "version not recorded"}, blueprint SHA-256 \`${
      stringField(deployment, "blueprintSha256") ?? "not recorded"
    }\`, deployed ${stringField(deployment, "deployedAt") ?? "at an unrecorded time"}.`,
    "",
    "| Script | Hash | Size (bytes) | Reference UTxO |",
    "| --- | --- | --- | --- |",
    ...scriptRows,
    "",
    "## 4. Acceptance tests",
    "",
    `${passed}/20 pass on preprod. Commit${commits.length > 1 ? "s" : ""} under test (from test-results.json): ${commits
      .map((c) => `\`${c}\``)
      .join(", ")}.`,
    "",
    renderAcceptanceTable(rows),
    "",
    "## 5. Security summary",
    "",
    SECURITY_SECTION,
    "",
    "## 6. Deviations from the PRD",
    "",
    "From `DECISIONS.md` and `docs/research/SUMMARY.md`.",
    "",
    ...PRD_DEVIATIONS.map((item) => `- ${item}`),
    "",
    "## 7. Open blockers",
    "",
    ...(blockers.length === 0
      ? ["None. Every entry in `BLOCKERS.md` is resolved."]
      : blockers.map((b) => `- ${b.id} ${b.title} (${b.status}). Human action: ${b.humanAction}`)),
    "",
    "## 8. How to rerun",
    "",
    "```sh",
    "pnpm install --frozen-lockfile",
    "scripts/long.sh pnpm verify:all          # build, aiken, unit, integration, adversarial, A1 to A20 on preprod, e2e; writes test-results.json",
    "pnpm local:up                            # Yaci DevKit, Postgres, Temporal, services, agents and web app on one machine",
    "scripts/preprod-up.sh                    # Masumi payment services, chain services, Conductor and agents, gateway for preprod",
    "scripts/heavy.sh pnpm --filter @cascade/demo record -- --stage   # PRD 21.2 recording on preprod -> demo/out/cascade-demo.mp4",
    "pnpm report:final                        # regenerate this file",
    "```",
    "",
  ];
  return { markdown: sections.join("\n"), passed };
}

function main(): void {
  const { markdown, passed } = buildReport(REPO_ROOT);
  writeFileSync(resolve(REPO_ROOT, "FINAL_REPORT.md"), markdown);
  process.stdout.write(`FINAL_REPORT.md written: ${passed}/20 acceptance passing\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`final-report: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
