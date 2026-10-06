/**
 * Direct-SDK acceptance tests on preprod: small trees built through the SDK and adversarial
 * transactions the node must reject. Each signs as its own buyer (lib/acceptance-wallets.ts), so
 * they run concurrently (it.concurrent, at most ACCEPTANCE_CONCURRENCY at once) in one worker while
 * the console-driven suite runs in the other; each still writes its own evidence/A#/result.json.
 */
import { describe, it } from "vitest";
import { runAcceptance, type AcceptanceRun } from "../lib/acceptance.js";
import { ACCEPTANCE, type AcceptanceId } from "../lib/catalog.js";
import { a10 } from "./sdk/a10-self-draw-blocked.js";
import { a11 } from "./sdk/a11-plan-membership.js";
import { a12 } from "./sdk/a12-deadline-nesting.js";
import { a13 } from "./sdk/a13-freeze.js";
import { a19 } from "./sdk/a19-security-suite.js";

const HOUR = 3_600_000;

const SDK_CASES: readonly [AcceptanceId, string, (run: AcceptanceRun) => Promise<void>][] = [
  ["A10", "rejects on chain a Draw that pays the operator key directly", a10],
  ["A11", "rejects on chain a Draw whose child spec is outside plan_root", a11],
  ["A12", "rejects on chain a child whose dispute_until breaks the parent's window", a12],
  ["A13", "fails every new Draw after Freeze while an existing child still settles", a13],
  // A19 reads the adversarial report, so under verify:all it waits for that stage (up to 6 h).
  ["A19", "fails every adversarial transaction, on Yaci and in a preprod sample, with no open critical or high finding", a19],
];

describe("direct-SDK acceptance on preprod", () => {
  for (const [id, behaviour, body] of SDK_CASES) {
    it.concurrent(`${id} ${ACCEPTANCE[id].title} > ${behaviour}`, () => runAcceptance(id, body), 7 * HOUR);
  }
});
