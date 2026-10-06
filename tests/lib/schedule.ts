import { optionalEnv } from "./repo.js";

/**
 * The latest moment A4 waits for a Masumi refund window (submit_result_time) to open and the refund
 * to be withdrawn. Lisan-B's fixed template deadline puts job 2's window at about 10:19 UTC on
 * 2026-10-02; CASCADE_A4_WAIT_UNTIL (ISO time) overrides it.
 */
export const A4_WAIT_UNTIL = Date.parse(optionalEnv("CASCADE_A4_WAIT_UNTIL") ?? "2026-10-02T10:30:00Z");
