import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { awaitVerifyStage, awaitVerifyStages, stageDoneFile, VERIFY_SIGNAL_DIR_ENV } from "./verify-signals.js";

describe("verify:all stage signals", () => {
  const dir = mkdtempSync(join(tmpdir(), "cascade-signals-test-"));
  afterEach(() => {
    delete process.env[VERIFY_SIGNAL_DIR_ENV];
  });

  it("returns at once outside verify:all", async () => {
    delete process.env[VERIFY_SIGNAL_DIR_ENV];
    await expect(awaitVerifyStage("adversarial", { timeoutMs: 0 })).resolves.toBeUndefined();
  });

  it("waits until the stage's done file appears", async () => {
    process.env[VERIFY_SIGNAL_DIR_ENV] = dir;
    let done = false;
    const waiting = awaitVerifyStage("e2e", { pollMs: 5, timeoutMs: 5_000 }).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    writeFileSync(stageDoneFile(dir, "e2e"), "fail\n");
    await waiting;
    expect(done).toBe(true);
  });

  it("waits for every named stage, whatever order they end in", async () => {
    process.env[VERIFY_SIGNAL_DIR_ENV] = dir;
    let done = false;
    const waiting = awaitVerifyStages(["s-unit", "s-e2e"], { pollMs: 5, timeoutMs: 5_000 }).then(() => (done = true));
    writeFileSync(stageDoneFile(dir, "s-e2e"), "pass\n");
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    writeFileSync(stageDoneFile(dir, "s-unit"), "pass\n");
    await waiting;
    expect(done).toBe(true);
  });

  it("fails when the stage never ends within the bound", async () => {
    process.env[VERIFY_SIGNAL_DIR_ENV] = dir;
    await expect(awaitVerifyStage("never", { pollMs: 5, timeoutMs: 20 })).rejects.toThrow("verify:all stage never did not finish in time");
    rmSync(dir, { recursive: true, force: true });
  });
});
