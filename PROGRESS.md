# PROGRESS

wave: final (release)
last verify: none on HEAD; the 2026-10-04 run reached build, aiken, unit, integration, adversarial pass and A4, A10 to A13 pass before the Mac rebooted
last evaluator: NEEDS_WORK at d004e0d (stale test-results, stale FINAL_REPORT, dirty tree); rerun after the final verify

## State on 2026-10-06
- Three full audits (acceptance paths, PRD coverage, live site) produced one fix list; every item is fixed and pushed: 837085b (Conductor policy, A2 and A9 scenarios, A5 and A8 indexer calls, A7 pricing), 62368fe (indexer results, challenges, rolled-back filter), bbf2554 (A3, A8, A14, A17, A18, A19 harness), 83f9d26 (Masumi P findings closed), 93a8a44 and later (web audit fixes), 804c9d9 (watchtower crank cause).
- Earlier root-cause fixes this wave: 1a85f8b, 320e2ae, aa3fcb0 (signer policy, wallet contention, Neon DNS retries), eda35ad, c14e858 (local stack network and ports), ec6ded7 (A19 T8), 3e96f7d (local dev origin).
- Waiting on the operator: approval to restart the preprod indexer, watchtower and agent group (only 2 of 11 preprod agents run; the live console cannot plan until then). After that: full `scripts/long.sh pnpm verify:all`, commit results, `pnpm report:final`, fresh evaluator, clean tree, push.
- Operator decisions: demo video and deck recorded by the operator later (A20 and goal item 5 open until then). Discarding the uncommitted debug hook in agents/conductor/test/yaci.integration.test.ts and agents/conductor/test/fixtures/ needs operator approval.
- Accepted residual (security): Masumi purchase-wallet return matches buyer_refund by payment key only; the stake part is chosen by the signer-token holder. No funds at risk.

## Operator instruction (2026-10-01)
- Keep working until only time-gated items remain (A4 refunds after 2026-10-02 09:52 and 10:19 UTC = 15:22 and 15:49 IST; final verify:all after that). Then: move every long-running preprod process to detached processes that survive a closed terminal, write a full checkpoint, and tell the operator it is safe to close. The operator reopens with `claude --continue` before 15:00 IST.
- UI must be excellent: competitive UX research in docs/design/competitive-ux.md feeds W5's redesign; design-critic review before shipping.

## Timed actions on 2026-10-02 UTC (nothing runs these automatically)
| After (UTC) | Action | Owner |
| --- | --- | --- |
| 03:05 | Refund stranded A3 MasumiReceipt locks 20ca8126, 52435f03 to buyer_refund | W2 |
| 09:47 | Extra A3 lock 74ec702d (tree d919b786) refunded by the watchtower purchaser crank (bac8601) once live; W2 only verifies | W3 crank |
| 15:55 to 16:08 | Refund orphaned Lisan test locks (deployments/masumi-orphaned-locks.preprod.json) via orchestrator payment service | W6 |
| 09:52, 10:20 | A4 locks 8f7de6f8, cecf03b9 refunded by the watchtower crank (A4 phase 2 verifies from chain, or withdraws if still unspent) | W3 crank, W7 |
| before 09:00 | Batched preprod restart (supervisor with signer fence 3fb4142 and crank bac8601, Conductor with cd4b195) | lead go, W3 and W4 |
| 06:00 (11:30 IST) | Start final `pnpm verify:all` with A4 ordered last (waits in-test for the refunds) | W7 via scripts/long.sh |
| ~11:00 (16:30 IST) | verify:all done; fresh evaluator; FINAL_REPORT.md; push | lead |

## Web redesign (2026-10-04)
- c7d4bcd: treg.to-style redesign of apps/web (tokens, fonts, header, landing, footer). Typecheck, 114/114 web unit tests and next build pass. Not pushed yet; Playwright e2e and design-critic pass not run.

## Remaining before final verify
- W4: restart preprod TS agents and Conductor on fee3889; planner structural sizing for metered leaves; commit a3-preprod.ts.
- W8: signed rehearsal, final recording, deck.
- W7: console suite rerun (A1, A2, A5, A7, A8, A9, A14, A15, A18, A3).
- Then: final verify:all, fresh evaluator, FINAL_REPORT.md, push.

## Evaluator findings and owners (17d7fe8)
| # | Sev | Finding | Owner | Status |
| --- | --- | --- | --- | --- |
| 1 | critical | Cross-script double satisfaction with Masumi WithdrawRefund (ADR 1.6 E1) | W1, W2 regression test | in progress |
| 2 | high | One-command local stack must include services, agents, web | W6 | in progress |
| 3 | high | Masumi lock and refund locally: deploy vested_pay on Yaci (DECISIONS) | W2 | in progress |
| 4 | high | Metered 200 calls in at most 3 L1 txs on Yaci | W4 | in progress |
| 5 | high | Live explorer e2e against local indexer | W7 | in progress |
| 6 | medium | min_dispute_window (ADR 1.6 E6) | W1, W2 | in progress |
| 7 | medium | Verifier keys bound to plan via acceptance_hash (E7) | W1, W2, W4 | in progress |
| 8 | medium | Masumi field scope stated; seller_return_address key (E8) | W1, W7 threat model | in progress |
| 9 | medium | Tip lag breaks wave1-tree | W2, W7 | in progress |
| 10 | medium | Adversarial case per redeemer | W7 | in progress |
| 11 | medium | Property tests per redeemer and invariant | W1 | in progress |
| 12-14 | low | Deadline-exit payee lovelace, address stake scope, fee address checks | W1 | in progress |
| 15 | low | PROGRESS stale | lead | done |
| 16 | low | verify:all at wave-closing commit | W7 | pending |
| 17 | low | Poller test silent skip | W3 | in progress |

## Done
- Contracts: audit F1 to F5 fixed and re-reviewed (security/), 669 aiken tests; deployed on preprod at 814cc42 (redeployed after ADR 1.6 (blueprint 34390174, node 5f58ba03)).
- SDK and x402 complete; services live on preprod (services/run); watchtower cranks on preprod; web live on Vercel with /api/v1 on Neon; 9 agents on Masumi V2 registry; MCP and CLI.
- Orchestrator: native tree, on-chain 2-of-3 quorum, 2-of-2 arbiter resolve, durable Postgres state, all on Yaci.

## Workstreams
| ID | Status | Next three tasks |
| --- | --- | --- |
| W1 | evaluator fixes | ADR 1.6; property tests; review report |
| W2 | evaluator fixes | ADR 1.6 shared/SDK; local vested_pay lock+refund; tip lag |
| W3 | preprod services live | poller test; runner committed; gate 4 min_dispute_window |
| W4 | leaves | metered 200 calls; Masumi start_job flow; full demo flow |
| W5 | idle | live demo tree id once a preprod tree exists |
| W6 | local stack | one-command full stack; ngrok when provided |
| W7 | acceptance | preprod acceptance harness, A10-A13, A17, A19; per-redeemer adversarial; live explorer e2e |
| W8 | not started | Wave 6 |

## Known issues
- B5 stable agent URL (ngrok account would fix).
