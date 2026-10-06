/** PRD section 19.2, verbatim. `lib/catalog.test.ts` fails if this drifts from docs/PRD.md. */
export const ACCEPTANCE_IDS = [
  "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10",
  "A11", "A12", "A13", "A14", "A15", "A16", "A17", "A18", "A19", "A20",
] as const;

export type AcceptanceId = (typeof ACCEPTANCE_IDS)[number];
export type Network = "preprod" | "yaci";

export interface AcceptanceSpec {
  readonly title: string;
  readonly criterion: string;
  readonly network: Network;
}

export const ACCEPTANCE: Readonly<Record<AcceptanceId, AcceptanceSpec>> = {
  A1: {
    title: "Happy path",
    criterion:
      "A buyer funds a 3-level tree with 7 nodes; all accept; every payee is paid its fee; the buyer receives unused reserve and structural ADA; reconciliation is exact.",
    network: "preprod",
  },
  A2: {
    title: "Refund and re-hire",
    criterion:
      "A native child misses `submit_by`; the watchtower cranks `Refund`; value returns into the parent in one transaction; the orchestrator hires the fallback from the same budget; the tree completes.",
    network: "preprod",
  },
  A3: {
    title: "Masumi leaf",
    criterion:
      "An unmodified Masumi agent, registered on the V2 registry, completes a leaf; its `blockchainIdentifier` and lock transaction appear on the receipt.",
    network: "preprod",
  },
  A4: {
    title: "Masumi refund routing",
    criterion:
      "A Masumi leaf fails; the refund lands at the tree buyer's `buyer_refund` address, never at the orchestrator; the receipt closes.",
    network: "preprod",
  },
  A5: {
    title: "x402 buy",
    criterion:
      "The orchestrator pays a third-party x402 Cardano endpoint with `default` method from a tree budget; `PAYMENT-RESPONSE` recorded.",
    network: "preprod",
  },
  A6: {
    title: "x402 sell",
    criterion:
      "A Cascade agent answers a 402 with `script` and `masumi` options; a plain x402 client pays via `masumi`; the job runs.",
    network: "preprod",
  },
  A7: {
    title: "Metered leaf",
    criterion:
      "At least 200 tool calls paid through vouchers with at most 3 L1 transactions; unspent deposit returns.",
    network: "preprod",
  },
  A8: {
    title: "Verification reject",
    criterion:
      "A result that fails its output schema is rejected at L0; the challenge resolves in the parent's favour after the window.",
    network: "preprod",
  },
  A9: {
    title: "Quorum and arbitration",
    criterion:
      "Two of three verifiers accept, one rejects; the node accepts. In a second run a challenge escalates to arbiters, who sign a split; bonds move as specified.",
    network: "preprod",
  },
  A10: {
    title: "Self-draw blocked",
    criterion: "A Draw that pays the orchestrator's key directly fails on chain.",
    network: "preprod",
  },
  A11: {
    title: "Plan membership",
    criterion: "A Draw for a child spec outside `plan_root` fails on chain.",
    network: "preprod",
  },
  A12: {
    title: "Deadline nesting",
    criterion: "A child whose `dispute_until` breaks the parent's window fails on chain.",
    network: "preprod",
  },
  A13: {
    title: "Freeze",
    criterion: "After Freeze, any new Draw in the tree fails; existing children still reach terminal states.",
    network: "preprod",
  },
  A14: {
    title: "Liveness without operator",
    criterion:
      "With the orchestrator offline, every node still reaches a terminal state through permissionless cranks.",
    network: "preprod",
  },
  A15: {
    title: "Crash recovery",
    criterion:
      "Killing the orchestrator between signing and submission causes no duplicate Draw and no lost node.",
    network: "preprod",
  },
  A16: {
    title: "Rollback",
    criterion:
      "A forced rollback on Yaci is reflected in the indexer and UI within one block, with no phantom states.",
    network: "yaci",
  },
  A17: {
    title: "Reputation",
    criterion: "After A1 to A9, recomputing reputation from chain matches the published snapshot root.",
    network: "preprod",
  },
  A18: {
    title: "MCP",
    criterion:
      "From an MCP client, a user plans, funds (via returned unsigned tx) and tracks a job to receipt.",
    network: "preprod",
  },
  A19: {
    title: "Security suite",
    criterion: "All adversarial transactions fail; zero critical or high findings open.",
    network: "preprod",
  },
  A20: {
    title: "Stage recording",
    criterion:
      "The demo flow in section 21 runs clean on preprod and is recorded without cuts in any money movement.",
    network: "preprod",
  },
};

export function isAcceptanceId(value: string): value is AcceptanceId {
  return (ACCEPTANCE_IDS as readonly string[]).includes(value);
}
