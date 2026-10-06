import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FUNDING_TARGETS_ADA } from "../../scripts/lib/funding.js";
import { ACCEPTANCE_CONCURRENCY, ACCEPTANCE_WORKERS, rankAcceptanceFile } from "../acceptance-order.js";
import { acceptanceBuyerRole } from "./acceptance-wallets.js";
import { ACCEPTANCE_IDS, type AcceptanceId } from "./catalog.js";
import { repoPath } from "./repo.js";

const ACCEPTANCE_DIR = repoPath("tests", "acceptance");

function sourcesUnder(dir: string): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourcesUnder(path);
    return e.name.endsWith(".ts") ? [{ path, text: readFileSync(path, "utf8") }] : [];
  });
}

/** Ids each entry file runs: `runAcceptance("A#"` calls and `["A#", ...]` case tables. */
function idsRunBy(text: string): string[] {
  return [...text.matchAll(/runAcceptance\("(A\d+)"|^\s*\["(A\d+)",/gm)].map((m) => m[1] ?? m[2]!);
}

/** Dispatches files in rank order to `workers` lanes, each taking the next file when it frees. */
function lanes(files: readonly string[], workers: number): string[][] {
  const sorted = [...files].sort((a, b) => rankAcceptanceFile(a) - rankAcceptanceFile(b));
  const out: string[][] = Array.from({ length: workers }, () => []);
  // The console-driven lane stays busy for hours; every later file queues in the other lane.
  sorted.forEach((f, i) => out[i === 0 ? 0 : Math.min(1, workers - 1)]!.push(f));
  return out;
}

describe("acceptance order", () => {
  const entryFiles = readdirSync(ACCEPTANCE_DIR).filter((f) => f.endsWith(".test.ts"));

  it("runs every acceptance test A1 to A20 from exactly one entry file", () => {
    const runs = entryFiles.flatMap((f) => idsRunBy(readFileSync(join(ACCEPTANCE_DIR, f), "utf8")));
    expect([...runs].sort()).toEqual([...ACCEPTANCE_IDS].sort());
  });

  it("gives console-driven a lane of its own and runs A4, A20, sdk-driven, then A16 in the other", () => {
    const [lane1, lane2] = lanes(entryFiles, ACCEPTANCE_WORKERS);
    expect(lane1).toEqual(["console-driven.test.ts"]);
    expect(lane2).toEqual(["a04-masumi-refund-routing.test.ts", "a20-stage-recording.test.ts", "sdk-driven.test.ts", "a16-rollback.test.ts"]);
  });

  it("ranks an unknown entry file after the known ones", () => {
    expect(rankAcceptanceFile("acceptance/a99-new.test.ts")).toBeGreaterThan(rankAcceptanceFile("acceptance/a16-rollback.test.ts"));
  });

  it("holds A16's devnet rollback until verify:all's devnet chain has ended", () => {
    const text = readFileSync(join(ACCEPTANCE_DIR, "a16-rollback.test.ts"), "utf8");
    const wait = text.indexOf("await awaitVerifyStages(A16_WAITS_FOR)");
    expect(wait).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(text.indexOf("withHeavyLock("));
  });

  it("has A16 heal Yaci Store after its rollback, still under the heavy lock, pass or fail", () => {
    const text = readFileSync(join(ACCEPTANCE_DIR, "a16-rollback.test.ts"), "utf8");
    const rollback = text.indexOf("rollback-to-db-snapshot");
    const heal = text.indexOf("await healYaciStore(");
    expect(rollback).toBeGreaterThan(-1);
    expect(heal).toBeGreaterThan(rollback);
    expect(text.lastIndexOf("} finally {", heal)).toBeGreaterThan(rollback);
    expect(heal).toBeGreaterThan(text.indexOf("withHeavyLock("));
  });

  it("keeps A17 after A4: A17 is the last, sequential case of the console-driven file and waits for A4's evidence", () => {
    const text = readFileSync(join(ACCEPTANCE_DIR, "console-driven.test.ts"), "utf8");
    expect(idsRunBy(text).at(-1)).toBe("A17");
    expect(text).toMatch(/\n  it\(`A17 /);
    expect(readFileSync(join(ACCEPTANCE_DIR, "console", "a17-reputation.ts"), "utf8")).toMatch(/A4/);
  });

  it("caps tests in flight at two workers (laptop rule) times ACCEPTANCE_CONCURRENCY", () => {
    expect(ACCEPTANCE_WORKERS).toBe(2);
    expect(ACCEPTANCE_CONCURRENCY).toBe(4);
    const pkg = JSON.parse(readFileSync(repoPath("tests", "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["acceptance"]).toContain(`--maxWorkers=${ACCEPTANCE_WORKERS}`);
  });
});

describe("acceptance buyer wallets", () => {
  const wallets = (JSON.parse(readFileSync(repoPath("deployments", "wallets.preprod.json"), "utf8")) as { wallets: { role: string; accountIndex: number; address: string }[] }).wallets;
  /** Tests that never sign with a buyer on preprod (A16 is on Yaci; A17 and A20 only read). */
  const UNFUNDED: readonly AcceptanceId[] = ["A16", "A17", "A20"];

  it("maps A1 to buyer-a01 through A20 to buyer-a20, one role each", () => {
    const roles = ACCEPTANCE_IDS.map(acceptanceBuyerRole);
    expect(roles[0]).toBe("buyer-a01");
    expect(roles[19]).toBe("buyer-a20");
    expect(new Set(roles).size).toBe(20);
  });

  it("derives each buyer at its own account index and address, shared with no other role", () => {
    for (const id of ACCEPTANCE_IDS) {
      const w = wallets.find((x) => x.role === acceptanceBuyerRole(id));
      expect(w, `${id} buyer in deployments/wallets.preprod.json`).toBeDefined();
      expect(wallets.filter((x) => x.accountIndex === w!.accountIndex || x.address === w!.address)).toHaveLength(1);
    }
  });

  it("funds the buyer of every test that signs on preprod, and only those", () => {
    for (const id of ACCEPTANCE_IDS) {
      const target = FUNDING_TARGETS_ADA[acceptanceBuyerRole(id) as keyof typeof FUNDING_TARGETS_ADA];
      if (UNFUNDED.includes(id)) expect(target, id).toBe(0);
      else expect(target, id).toBeGreaterThanOrEqual(20);
    }
  });

  it("leaves no acceptance test signing with the shared buyer or qa-buyer roles", () => {
    const shared = sourcesUnder(ACCEPTANCE_DIR)
      .concat(["console-scenario.ts", "tree-fixture.ts", "preprod-tree.ts"].map((f) => ({ path: f, text: readFileSync(repoPath("tests", "lib", f), "utf8") })))
      .filter((s) => /preprodRole\("(buyer|qa-buyer)"\)|CASCADE_QA_BUYER_ROLE/.test(s.text))
      .map((s) => s.path);
    expect(shared).toEqual([]);
  });
});
