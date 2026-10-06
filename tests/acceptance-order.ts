/**
 * Acceptance order for `pnpm verify:all`. Two vitest workers (the laptop rule) are two lanes, each
 * running up to ACCEPTANCE_CONCURRENCY tests at once inside a file (it.concurrent):
 *   lane 1: console-driven (hours of preprod deadlines; A17 last inside it, after A4's evidence)
 *   lane 2: A4 first, so A17 never waits on it; A20; sdk-driven (A10 to A13, A19, which waits for
 *           the adversarial stage); A16 last, once the devnet chain of stages has ended
 * Every test signs as its own buyer (lib/acceptance-wallets.ts), so lanes never share a wallet.
 */
export const ACCEPTANCE_WORKERS = 2;
export const ACCEPTANCE_CONCURRENCY = 4;

const LANE_ORDER = ["console-driven", "a04-", "a20-", "sdk-driven", "a16-"] as const;

export function rankAcceptanceFile(path: string): number {
  const i = LANE_ORDER.findIndex((key) => path.includes(key));
  return i === -1 ? LANE_ORDER.length : i;
}
