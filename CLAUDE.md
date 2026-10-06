# Cascade: standing rules for every session

Read `docs/MASTER_PROMPT.md` in full before any work, and again after any compaction or restart. The product spec is `docs/PRD.md`.

## Every turn
1. If `AGENT_STOP` exists at the repo root, stop immediately and do nothing else.
2. If `STEER.md` is non-empty, follow it, log what you did in `DECISIONS.md`, then empty it.
3. Re-read `PROGRESS.md` if you do not remember the current wave.
4. End the turn with the STATUS block from `docs/MASTER_PROMPT.md` section 12.

## Never
- Ask the human a question or wait for approval. Decide, log in `DECISIONS.md`, continue.
- Touch mainnet, print or commit secrets, `cat` any `.env` file, force-push.
- Hand-edit `test-results.json`. Only `pnpm verify:all` writes it.
- Mock chain calls in acceptance or integration tests, weaken assertions, or skip tests to get green.
- Write outside your workstream's owned directories (MASTER_PROMPT section 5.2) unless you are the lead.
- Copy application code from other hackathon projects. Import libraries and record them in `THIRD_PARTY.md`.

## Always
- Networks: Yaci DevKit locally, Cardano preprod for acceptance. Nothing else.
- Commit small, tested changes often, with clear messages.
- Keep `PROGRESS.md` current: wave, per-workstream status, next tasks, known issues.
- Log outside blockers in `BLOCKERS.md` with the workaround you applied, then keep building.
- Run the `evaluator` subagent after each wave and before claiming done.
- Human-facing text (README, UI, deck, docs): plain, specific, no em dashes, no filler words.

## Done means
`pnpm verify:all` exits 0 with 20/20 acceptance on preprod, the evaluator returns PASS on the final commit, public URLs return 200, demo video and deck exist, `FINAL_REPORT.md` is written, and git is clean and pushed. Full list: MASTER_PROMPT section 1.

## Machine load (operator's laptop)
- Run every heavy job through `scripts/heavy.sh <command>` (test suites, builds, `aiken check`, Playwright, devnet runs). It allows three heavy jobs at a time across all agents, at lowered priority. Vitest with at most 2 workers (`--maxWorkers=2`).
- Stop any dev server, watcher or Playwright browser you started as soon as you are done with it.
- Do not leave polling loops running faster than once every 30 s.

## Lockfile
- Commit `pnpm-lock.yaml` only in the same commit as the `package.json` change that produced it. Never commit lockfile entries for another agent's uncommitted package changes. Vercel installs with a frozen lockfile from HEAD.
- Long, mostly idle jobs (preprod suites that wait on chain deadlines, `pnpm verify:all`) run through `scripts/long.sh <command>` instead: one at a time, lowered priority, no heavy slot held. CPU-heavy steps inside them stay modest (vitest at most 2 workers).
- Never restart shared preprod processes (services runner, preprod agents, Lisan, Lisan-B, Masumi payment services) without the lead's go-ahead, and never while a demo or acceptance tree is live: a restart lost Scout's job mid-rehearsal on 2026-10-01.
