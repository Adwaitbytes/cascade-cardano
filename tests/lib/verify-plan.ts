/**
 * Stage scheduling for scripts/verify-all.ts, kept pure so it is unit-tested. After build,
 * acceptance runs beside the devnet chain (aiken to e2e, one at a time under the heavy lock); urls
 * runs last. With --only, just that stage runs.
 */
export const VERIFY_STAGES = ["build", "aiken", "unit", "integration", "adversarial", "acceptance", "e2e", "urls"] as const;
export type VerifyStage = (typeof VERIFY_STAGES)[number];

/** The CPU-heavy, devnet-bound chain that runs beside acceptance, in this order. */
export const VERIFY_CHAIN: readonly VerifyStage[] = ["aiken", "unit", "integration", "adversarial", "e2e"];

export async function runVerifyPlan(only: VerifyStage | null, runStage: (stage: VerifyStage) => Promise<void>): Promise<void> {
  if (only !== null) {
    await runStage(only);
    return;
  }
  await runStage("build");
  await Promise.all([
    runStage("acceptance"),
    (async () => {
      for (const stage of VERIFY_CHAIN) await runStage(stage);
    })(),
  ]);
  await runStage("urls");
}

/**
 * Stages that must have ended before A16 forces its Yaci rollback. The rollback restarts
 * cardano-node inside the devnet container, which drops Yaci Store's connection and fails any local
 * suite reading through it, so A16 waits for the whole local chain, not just its last stage.
 */
export const A16_WAITS_FOR: readonly VerifyStage[] = VERIFY_CHAIN;
