import { resetCases, writeReport } from "./report.js";

export function setup(): void {
  resetCases();
}

export function teardown(): void {
  writeReport();
}
