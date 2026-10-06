import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { A16_WAITS_FOR, runVerifyPlan, VERIFY_CHAIN, VERIFY_STAGES, type VerifyStage } from "./verify-plan.js";
import { awaitVerifyStages, stageDoneFile, VERIFY_SIGNAL_DIR_ENV } from "./verify-signals.js";

/** Records start and end of each stage; each stage takes `ms[stage]` (default 1) of fake time. */
async function trace(only: VerifyStage | null, ms: Partial<Record<VerifyStage, number>> = {}) {
  const events: string[] = [];
  await runVerifyPlan(only, async (stage) => {
    events.push(`start ${stage}`);
    await new Promise((r) => setTimeout(r, ms[stage] ?? 1));
    events.push(`end ${stage}`);
  });
  return events;
}

describe("verify:all stage plan", () => {
  it("runs every stage exactly once", async () => {
    const events = await trace(null);
    expect(events.filter((e) => e.startsWith("start")).map((e) => e.slice(6)).sort()).toEqual([...VERIFY_STAGES].sort());
  });

  it("runs build first and urls last", async () => {
    const events = await trace(null);
    expect(events.slice(0, 2)).toEqual(["start build", "end build"]);
    expect(events.slice(-2)).toEqual(["start urls", "end urls"]);
  });

  it("starts acceptance with aiken, beside the chain, and keeps the chain strictly sequential in order", async () => {
    const events = await trace(null, { acceptance: 40 });
    expect(events.slice(2, 4).sort()).toEqual(["start acceptance", "start aiken"]);
    const chain = events.filter((e) => VERIFY_CHAIN.some((s) => e.endsWith(` ${s}`)));
    expect(chain).toEqual(VERIFY_CHAIN.flatMap((s) => [`start ${s}`, `end ${s}`]));
    // Acceptance outlasts the chain here, and urls still waits for it.
    expect(events.indexOf("end e2e")).toBeLessThan(events.indexOf("end acceptance"));
    expect(events.indexOf("end acceptance")).toBeLessThan(events.indexOf("start urls"));
  });

  it("waits for a long chain before urls when acceptance ends first", async () => {
    const events = await trace(null, { adversarial: 30 });
    expect(events.indexOf("end acceptance")).toBeLessThan(events.indexOf("end adversarial"));
    expect(events.indexOf("end e2e")).toBeLessThan(events.indexOf("start urls"));
  });

  it("runs only the named stage with --only", async () => {
    expect(await trace("acceptance")).toEqual(["start acceptance", "end acceptance"]);
  });

  it("has A16 wait for every local devnet stage, so its rollback never restarts the node under one", () => {
    expect([...A16_WAITS_FOR].sort()).toEqual(["adversarial", "aiken", "e2e", "integration", "unit"]);
    expect([...A16_WAITS_FOR].sort()).toEqual([...VERIFY_CHAIN].sort());
  });

  it("releases A16 only after the last local stage signals, under the real plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cascade-a16-order-"));
    process.env[VERIFY_SIGNAL_DIR_ENV] = dir;
    try {
      const events: string[] = [];
      await runVerifyPlan(null, async (stage) => {
        events.push(`start ${stage}`);
        if (stage === "acceptance") {
          await awaitVerifyStages(A16_WAITS_FOR, { pollMs: 2, timeoutMs: 5_000 });
          events.push("A16 rollback");
        } else {
          await new Promise((r) => setTimeout(r, 5));
        }
        events.push(`end ${stage}`);
        writeFileSync(stageDoneFile(dir, stage), "pass\n");
      });
      const rollback = events.indexOf("A16 rollback");
      for (const stage of VERIFY_CHAIN) expect(events.indexOf(`end ${stage}`)).toBeLessThan(rollback);
      for (const stage of VERIFY_CHAIN) expect(events.lastIndexOf(`start ${stage}`)).toBeLessThan(rollback);
    } finally {
      delete process.env[VERIFY_SIGNAL_DIR_ENV];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
