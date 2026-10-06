/**
 * Console-driven acceptance tests on preprod (and A6, an x402 purchase beside them). Each waits on
 * real chain deadlines for one to three hours, so they run concurrently in one worker
 * (it.concurrent, at most ACCEPTANCE_CONCURRENCY at once); every one still writes its own
 * evidence/A#/result.json and signs as its own buyer (lib/acceptance-wallets.ts). vitest.config.ts
 * starts this file in its own lane; the other files share the second worker (acceptance-order.ts).
 */
import { describe, it } from "vitest";
import { runAcceptance, type AcceptanceRun } from "../lib/acceptance.js";
import { ACCEPTANCE, type AcceptanceId } from "../lib/catalog.js";
import { a01 } from "./console/a01-happy-path.js";
import { a02 } from "./console/a02-refund-and-rehire.js";
import { a03 } from "./console/a03-masumi-leaf.js";
import { a05 } from "./console/a05-x402-buy.js";
import { a06 } from "./console/a06-x402-sell.js";
import { a07 } from "./console/a07-metered-leaf.js";
import { a08 } from "./console/a08-verification-reject.js";
import { a09 } from "./console/a09-quorum-and-arbitration.js";
import { a14 } from "./console/a14-liveness-without-operator.js";
import { a15 } from "./console/a15-crash-recovery.js";
import { a17 } from "./console/a17-reputation.js";
import { a18 } from "./console/a18-mcp.js";

const HOUR = 3_600_000;
const suiteStart = Date.now();

const CASES: [AcceptanceId, (run: AcceptanceRun) => Promise<void>][] = [
  ["A1", a01],
  ["A2", a02],
  ["A3", a03],
  ["A5", a05],
  ["A6", a06],
  ["A7", a07],
  ["A8", a08],
  ["A9", a09],
  ["A14", a14],
  ["A15", a15],
  ["A18", a18],
];

describe("console-driven acceptance on preprod", () => {
  for (const [id, body] of CASES) {
    it.concurrent(`${id} ${ACCEPTANCE[id].title}`, () => runAcceptance(id, body), 5 * HOUR);
  }
  // "After A1 to A9": sequential, so it starts only when every concurrent case above has finished;
  // A4 runs in the other worker, and A17 waits for its evidence from this run.
  it(`A17 ${ACCEPTANCE.A17.title}`, () => runAcceptance("A17", (run) => a17(run, suiteStart)), 8 * HOUR);
});
