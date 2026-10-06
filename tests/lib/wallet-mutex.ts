/**
 * Console-driven tests run concurrently in one worker and share the buyer role's wallet. Building
 * two transactions from one wallet at once would select the same UTxOs, so every build, sign,
 * submit and wallet-sync for a wallet runs under that wallet's lock.
 */
const tails = new Map<string, Promise<void>>();

export async function withWallet<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(name) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  tails.set(name, previous.then(() => mine));
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}
