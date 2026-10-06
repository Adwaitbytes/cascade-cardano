import { describe, expect, it } from "vitest";
import { parseProcEnviron, YACI_STORE_FALLBACK_ENV, YACI_STORE_MAX_LAG_SLOTS, yaciStoreLagProblem, yaciStoreStartArgs } from "../src/testing/devnet.js";

describe("Yaci Store freshness prerequisite", () => {
  it("accepts a store trailing the node by a few blocks", () => {
    expect(yaciStoreLagProblem(7_311, 7_309)).toBeNull();
    expect(yaciStoreLagProblem(1_000, 1_000 - YACI_STORE_MAX_LAG_SLOTS)).toBeNull();
  });

  it("names a wedged store, as on 2026-10-05 when it stopped at slot 7097 while the node went on", () => {
    const problem = yaciStoreLagProblem(7_311, 7_097);
    expect(problem).toMatch(/^prerequisite: Yaci Store is 214 slots behind the node \(store at slot 7097, node at 7311\)/);
    expect(problem).toContain("Restart the yaci-store process");
  });
});

describe("Yaci Store restart", () => {
  it("copies the live store's settings from /proc environ, minus per-process variables", () => {
    const raw = "STORE_CARDANO_N2C_ERA=Conway\0PWD=/app\0_=/app/yaci-cli\0SHLVL=1\0JAVA_HOME=/opt/java/openjdk\0EMPTY=\0junk\0";
    expect(parseProcEnviron(raw)).toEqual({ STORE_CARDANO_N2C_ERA: "Conway", JAVA_HOME: "/opt/java/openjdk", EMPTY: "" });
  });

  it("starts ./yaci-store-n2c detached from /app/store with that environment, logging under ./logs", () => {
    expect(yaciStoreStartArgs("c1", { B: "2", A: "x=y" })).toEqual([
      "exec", "-d", "-w", "/app/store", "-e", "A=x=y", "-e", "B=2", "c1",
      "sh", "-c", "exec ./yaci-store-n2c >>logs/restart-stdout.log 2>&1 </dev/null",
    ]);
  });

  it("falls back to the settings yaci-cli exports when no store process is left", () => {
    expect(YACI_STORE_FALLBACK_ENV).toEqual({ STORE_CARDANO_N2C_ERA: "Conway", STORE_CARDANO_PROTOCOL_MAGIC: "42", STORE_SUBMIT_TX_EVALUATOR_MODE: "ogmios" });
  });
});
