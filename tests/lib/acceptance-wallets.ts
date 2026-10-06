/**
 * Every acceptance test signs as its own buyer: A1 as role buyer-a01, through A20 as buyer-a20
 * (scripts/lib/wallets.ts, funded by scripts/fund-wallets.ts). Tests then run in parallel without
 * two of them building from the same UTxOs, and a test's evidence shows only its own spends.
 * Other roles (agents, arbiters, the purchase wallet P, the cranker) stay shared; tests only sign
 * with them or read their balances.
 */
import type { AcceptanceRun } from "./acceptance.js";
import type { AcceptanceId } from "./catalog.js";
import type { Party } from "./devnet.js";
import { preprodRole } from "./preprod.js";

export type AcceptanceBuyerRole = `buyer-a${string}`;

export function acceptanceBuyerRole(id: AcceptanceId): AcceptanceBuyerRole {
  const n = Number(id.slice(1));
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error(`no acceptance buyer for ${id}`);
  return `buyer-a${String(n).padStart(2, "0")}`;
}

/** The buyer wallet of the test that `run` records. */
export function buyerOf(run: Pick<AcceptanceRun, "id">): Party {
  return preprodRole(acceptanceBuyerRole(run.id));
}
