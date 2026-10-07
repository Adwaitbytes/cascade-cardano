interface Ranked {
  name: string;
  reputation: { score: number; confidence: number };
}

/** An agent with no settled work has only the prior score; it is not ranked against agents with a record. */
export const isUnscored = (a: Ranked): boolean => a.reputation.confidence === 0;

/** Agents with a record first, by score; then agents with no settled work yet, by name. */
export function rankAgents<T extends Ranked>(agents: readonly T[]): T[] {
  return [...agents].sort((a, b) => {
    const ua = isUnscored(a);
    const ub = isUnscored(b);
    if (ua !== ub) return ua ? 1 : -1;
    if (ua) return a.name.localeCompare(b.name);
    return b.reputation.score - a.reputation.score;
  });
}
