import { describe, expect, it } from "vitest";
import { DEVNET_MARKER_TABLE, devnetId, localDbIsStale, READ_MARKER_SQL, resetSql } from "../lib/local-devnet.js";

const HASH_A = "b354e195d254c7b5d1ce92838be8ec3d6209307aabe45877e4d3c6e5afeb5eae";
const HASH_B = "81301ac3af57fbc9e59f9e8883a81a4ace11b9c2b9bb65e46a8d6997aefba79b";

describe("local devnet identity", () => {
  it("combines start time and block 1 hash", () => {
    expect(devnetId(1791248184, HASH_A)).toBe(`1791248184:${HASH_A}`);
    expect(() => devnetId(0, HASH_A)).toThrow();
    expect(() => devnetId(1791248184, "undefined")).toThrow();
  });

  it("flags the database stale after a reset with a new start time", () => {
    expect(localDbIsStale(devnetId(1791248184, HASH_A), devnetId(1791250000, HASH_B))).toBe(true);
  });

  it("flags the database stale when only block 1 differs (same start time, replayed genesis)", () => {
    expect(localDbIsStale(devnetId(1791248184, HASH_A), devnetId(1791248184, HASH_B))).toBe(true);
  });

  it("flags a database with no recorded devnet as stale", () => {
    expect(localDbIsStale(undefined, devnetId(1791248184, HASH_A))).toBe(true);
  });

  it("keeps the database on the same devnet", () => {
    expect(localDbIsStale(devnetId(1791248184, HASH_A), devnetId(1791248184, HASH_A))).toBe(false);
  });

  it("reset SQL truncates public tables but keeps the migration ledger and the marker", () => {
    const sql = resetSql(devnetId(1791248184, HASH_A));
    expect(sql).toContain("TRUNCATE");
    expect(sql).toContain("schemaname = 'public'");
    expect(sql).toContain(`NOT IN ('schema_migrations', '${DEVNET_MARKER_TABLE}')`);
    expect(sql).toContain(`VALUES (1, '1791248184:${HASH_A}')`);
    expect(sql).not.toMatch(/DROP|temporal/i);
    expect(READ_MARKER_SQL).toContain(`SELECT devnet FROM ${DEVNET_MARKER_TABLE}`);
  });
});
