/**
 * Reference agents from PRD 21.1. Account indices match scripts/lib/wallets.ts (W6), so each agent
 * signs with the key behind its address in deployments/wallets.<network>.json.
 */
export const AGENT_ROLES = {
  conductor: { accountIndex: 2, port: 24001 },
  scout: { accountIndex: 3, port: 24002 },
  pricer: { accountIndex: 4, port: 24003 },
  "lookup-api": { accountIndex: 5, port: 24004 },
  "flaky-lisan": { accountIndex: 7, port: 24005 },
  "checker-a": { accountIndex: 8, port: 24006 },
  "checker-b": { accountIndex: 9, port: 24007 },
  "checker-c": { accountIndex: 18, port: 24010 },
  scribe: { accountIndex: 10, port: 24008 },
} as const;

export type AgentRoleName = keyof typeof AGENT_ROLES;

/** The label Flaky Lisan carries in every response, discovery file and log line (PRD 21.1, 22.3). */
export const FLAKY_NOTICE = "Test agent: fails on purpose to demonstrate refunds.";
