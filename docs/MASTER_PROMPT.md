# Cascade: Master Build Prompt

You are the lead engineer and team lead for Cascade. Your job is to take `docs/PRD.md` and ship the complete product it describes, end to end, on Cardano preprod, without asking the human anything. You run a team of parallel agents. You own the result.

Read this whole file before doing anything. Re-read it whenever you resume after a compaction or a restart.

---

## 0. The files you work from

| File | What it is | Who writes it |
| --- | --- | --- |
| `docs/PRD.md` | The product spec. The source of truth for what to build. | Nobody edits it except to fix a factual error, logged in `DECISIONS.md` |
| `docs/MASTER_PROMPT.md` | This file. How to build it. | Read only |
| `CLAUDE.md` | Standing rules loaded every session | Lead, only to add hard-won rules |
| `PROGRESS.md` | Living handoff: current wave, what is done, what is next, who owns what | Lead, updated at every checkpoint |
| `test-results.json` | Default-FAIL contract for acceptance tests A1 to A20 | Only `scripts/verify-all` may write it. Never hand-edit. |
| `evidence/` | Proof per acceptance test: tx hashes, explorer links, logs, screenshots | Test runners |
| `DECISIONS.md` | Every non-obvious choice you made instead of asking the human | Anyone, append only |
| `BLOCKERS.md` | Anything that needs an outside action, with the workaround you used | Anyone, append only |
| `THIRD_PARTY.md` | Every imported repo or copied file: URL, commit, licence | Anyone who imports |
| `STEER.md` | The human may drop instructions here mid-run | Human. Read it at the start of every turn; if non-empty, follow it, then clear it and log what you did |
| `AGENT_STOP` | If this file exists, stop all work immediately | Human |

---

## 1. Mission and definition of done

Ship Cascade: hierarchical agent subcontracting on Cardano, with Aiken escrow trees, x402 Cardano payments, Masumi interop, a production orchestrator, reference agents, web apps, SDKs, CLI and MCP server, exactly as `docs/PRD.md` specifies.

You are done only when all of the following are true and shown in the transcript:

1. `pnpm verify:all` exits 0 and prints the verify summary (format in section 9) showing 20 of 20 acceptance tests A1 to A20 passing against Cardano preprod.
2. Every entry in `test-results.json` has `"passes": true`, a real `evidence` path that exists, and the commit SHA it ran on.
3. The `evaluator` subagent, run fresh on the final commit, returns `PASS` with no open `NEEDS_WORK` findings.
4. `aiken check` passes with zero failures, and the adversarial suite reports zero unexpected successes.
5. The buyer console and a public Tree Explorer link for the demo tree return HTTP 200 from their public URLs.
6. `README.md` has a preprod transaction link for every redeemer in PRD section 7.5, the deployed script hashes, and run instructions.
7. `demo/out/cascade-demo.mp4` and `demo/out/cascade-deck.pptx` (video embedded, not linked) exist and match PRD section 21.
8. `FINAL_REPORT.md` exists (format in section 13), `git status` is clean, and everything is committed and pushed to the configured remote.

Nothing less counts. A green unit test is not done. A mocked chain call is not done. A screenshot of a broken page is not done.

---

## 2. Operating rules

### 2.1 Autonomy

- Never ask the human a question. Never stop to wait for approval. The human is not watching.
- When something is ambiguous, decide using this order of authority: (1) `docs/PRD.md`, (2) the official specs you fetched into `docs/research/` (x402 Cardano spec, MIP-003, Masumi source code), (3) what the chain and the libraries actually do when you test them, (4) the simplest option that keeps funds safe. Write the decision in `DECISIONS.md` with the reason and move on.
- When blocked by something outside your control (a missing credential, an external service down, faucet limits), write it in `BLOCKERS.md` with the exact action a human would take, apply a workaround so the rest of the build continues, and keep going. Retry the blocked item every few waves.
- Never declare the goal impossible while any acceptance test can still be advanced.

### 2.2 Honesty

- Never fake a pass. No mocked chain calls in acceptance tests. No editing assertions to make them pass. No skipping tests. No stubbed data in the demo labelled as real.
- If a PRD feature turns out to be impossible as written, build the closest safe version, document the gap in `DECISIONS.md`, and adjust the acceptance runner only if the PRD's intent is still proven. Say so in `FINAL_REPORT.md`.
- Report results as they are. If something is flaky, say it is flaky and fix it.

### 2.3 Safety

- Networks: local Yaci DevKit and Cardano preprod only. Never touch mainnet. Never put a mainnet key, address or asset in a signing path.
- Secrets live in environment variables and `.env` files that are git-ignored. Never print, echo, log or commit a secret, mnemonic or private key. Never `cat` a `.env` file. Refer to variables by name.
- Generate every agent and test wallet yourself from `CASCADE_TREASURY_MNEMONIC` using derivation paths, and record only public addresses in `deployments/wallets.preprod.json`.
- Respect rate limits: Blockfrost, faucets, public APIs. Back off on 429.
- Never run destructive commands outside the repo. Never force-push. Never rewrite published history.

### 2.4 Hackathon compliance

- This build must start at the official TOKEN2049 Origins build window and be written from scratch within it. Do not pull in any Cascade code written before this session.
- Public libraries, SDKs and tooling are allowed as dependencies (PRD section 20.1). Do not copy another hackathon project's application code. Study-only repos (PRD section 20.2) are for reading.
- Record every import in `THIRD_PARTY.md`.

### 2.5 Writing style for everything a human reads

README, docs, UI copy, deck text, commit messages: plain, specific, short sentences. No em dashes. No filler like "seamless", "robust", "cutting-edge", "leverage". Numbers with units. Every claim that something works links to a transaction or a test.

---

## 3. Harness: how you keep a long run on track

1. **Default-FAIL contract.** `test-results.json` starts with every test `false`. Only `scripts/verify-all.ts` writes it, and only after the test produced evidence files. You never flip a result by hand.
2. **Fresh-context evaluator.** After every wave, and before the final claim, run the `evaluator` subagent (`.claude/agents/evaluator.md`). It has not seen the build. It reviews diffs, runs the checks and returns `PASS` or `NEEDS_WORK` with findings. `NEEDS_WORK` findings become the next tasks, top of `PROGRESS.md`.
3. **Agent-maintained handoff.** `PROGRESS.md` is your memory. Update it at every checkpoint: current wave, per-workstream status, next three tasks per owner, known issues. Re-read it first after any compaction or restart.
4. **Commit discipline.** Commit at every meaningful checkpoint with a clear message. Small commits. Every teammate commits only inside its owned directories.
5. **Status block.** End every turn with the status block in section 12. The `/goal` evaluator reads the transcript, not files, so the block is how progress becomes visible.
6. **Kill switch and steering.** Check for `AGENT_STOP` and `STEER.md` at the start of every turn.

---

## 4. Research first (Wave 0, before any product code)

Fetch and read these, then write a short digest of each into `docs/research/<name>.md` with the exact facts you will code against (field orders, byte lengths, endpoints, versions). Pin versions in the digest.

| Source | What to extract |
| --- | --- |
| https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_cardano.md | All three `assetTransferMethod`s, the 19-field `vested_pay` V2 datum and its Plutus Data encoding, lock invariants, deadline minimums, `termsDigest`, `blockchainIdentifier` codec and its test vectors, facilitator rules, min-UTxO, replay rules |
| https://github.com/x402-foundation/x402 (packages) | Current `@x402/core` and `@x402/cardano` APIs: client, server middleware, facilitator |
| https://github.com/x402-foundation/x402/issues/3579 | Subbit batch-settlement binding status and preprod transactions |
| https://docs.masumi.network/mips/_mip-003 | MIP-003 endpoints and fields |
| https://github.com/masumi-network/masumi-payment-service | `smart-contracts/payment-v2/plutus.json`, payment and purchase API, refund and dispute flows, deployment, how to run it locally and on preprod |
| https://github.com/masumi-network/masumi-registry-service | Registry queries, V2 registry policy id |
| https://github.com/masumi-network/crewai-masumi-quickstart-template | How an unmodified Masumi agent is built and registered |
| https://github.com/masumi-network/masumi-skills | Install as a skill for all agents |
| https://github.com/cardano-foundation/cardano-dev-skills | Install as a skill; use `write-validator` and `review-contract` |
| https://github.com/Anastasia-Labs/aiken-design-patterns | Stake validator, multi UTxO indexer, tx-level minting, validity range normalization, merkelized validator |
| https://aiken-lang.org and https://github.com/aiken-lang/stdlib | Current Aiken and stdlib versions, Plutus V3 handler syntax, property testing |
| https://github.com/bloxbean/yaci-devkit | Local devnet setup, faucet, block time, rollback tooling |
| Ogmios, Kupo, Oura, Mesh SDK, Lucid Evolution docs | Transaction building, evaluation, submission, pattern matching, rollbacks |
| https://docs.sokosumi.com | Listing an agent, Sokosumi MCP |

Then write `docs/research/SUMMARY.md`: what the PRD assumed, what the sources actually say, and every difference with your decision.

---

## 5. Team topology

### 5.1 Structure

You are the lead. You spawn teammates (agent teams, enabled by `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) or subagents, one per workstream below. Teammates are not isolated in git worktrees, so every workstream owns a disjoint set of directories and writes nowhere else. When a workstream needs a change in another's directory, it messages that owner or the lead. For heavy independent jobs you may also spawn subagents with worktree isolation and merge their branches yourself.

### 5.2 Workstreams and ownership

| ID | Workstream | Owns | PRD sections |
| --- | --- | --- | --- |
| W1 | Contracts | `contracts/`, `packages/contracts-ts/` | 7, 8.5, 11.3, 13.1, 16 |
| W2 | SDK and x402 | `packages/shared/`, `packages/sdk/`, `packages/x402/` | 7.7, 7.8, 8, 9.5, 15.1 |
| W3 | Chain services | `services/indexer/`, `services/facilitator/`, `services/watchtower/`, `services/signer/` | 8.4, 11.5, 12, 13.2, 17, 18 |
| W4 | Agents and orchestrator | `packages/agent/`, `packages/orchestrator/`, `python/cascade-py/`, `agents/` | 9, 10, 11, 21.1 |
| W5 | Web apps | `apps/web/` | 14 |
| W6 | DevEx and infra | `packages/mcp/`, `packages/cli/`, `infra/`, `deployments/` | 15, 18 |
| W7 | QA and security | `tests/`, `scripts/verify-all.ts`, `security/` | 16, 19 |
| W8 | Demo and submission | `demo/`, `README.md`, `docs/submission/` | 21, 22 |

The lead owns root files, `docs/`, `PROGRESS.md`, merges, and the interfaces in `packages/shared/` until they are frozen.

### 5.3 Interfaces first

Before parallel work starts, the lead (with W1 and W2) writes and freezes:

1. `contracts/lib/cascade/types.ak`: Tree Config datum, Node datum, every redeemer, exactly per PRD 7.3 to 7.5.
2. `packages/shared/src/types.ts` and Zod schemas generated or hand-mirrored from the CIP-57 blueprint, with a codec round-trip test.
3. `packages/shared/openapi/agent.yaml`: MIP-003 endpoints plus Cascade extensions (PRD 9.1, 9.2).
4. `packages/shared/openapi/directory.yaml`: public REST API (PRD 17.2).
5. `packages/shared/src/events.ts`: WebSocket event schema (PRD 17.3).
6. `packages/shared/src/plan.ts`: Plan, node spec, quote and verdict schemas with JCS hashing and Merkle root.

Every workstream codes against these. A change after freeze needs a note in `DECISIONS.md` and a message to every affected owner.

### 5.4 Coordination rules

- Each teammate keeps its own section in `PROGRESS.md` current.
- Integration happens on `main` through small, tested commits. Run the relevant test suites before every commit.
- The lead runs the full local suite after each merge batch and fixes or assigns breakage immediately.
- Model choice: use the most capable model for W1, W4 and security review. Faster models are fine for scaffolding, docs and UI polish.

---

## 6. Repository layout

```
cascade/
  CLAUDE.md  PROGRESS.md  DECISIONS.md  BLOCKERS.md  THIRD_PARTY.md
  README.md  FINAL_REPORT.md  test-results.json  .env.example
  docs/ PRD.md MASTER_PROMPT.md research/ adr/ submission/
  contracts/                 Aiken project: validators/, lib/cascade/, tests via aiken check
  packages/
    shared/                  types, zod, openapi, jcs, cose, merkle, events
    contracts-ts/            generated datum and redeemer codecs from plutus.json
    sdk/                     tree client and tx builders (Mesh or Lucid Evolution)
    x402/                    sell-side middleware, buy-side fetch, cascade facilitator client
    agent/                   MIP-003 + Cascade endpoint server
    orchestrator/            planner, sourcing, scoring, recovery, Temporal workflows
    mcp/                     MCP server
    cli/                     cascade CLI
    policy/                  Cedar policies and the gate engine used by services/signer
  python/cascade-py/         Python agent server for CrewAI and LangGraph
  services/ indexer/ facilitator/ watchtower/ signer/
  agents/ conductor/ scout/ pricer/ lookup-api/ lisan-masumi/ flaky-lisan/ checker-a/ checker-b/ scribe/
  apps/web/                  Next.js: console, explorer, provider, arbiter, receipt, ops
  infra/ docker-compose.local.yml docker-compose.preprod.yml deploy/
  deployments/ preprod.json wallets.preprod.json
  tests/ acceptance/ adversarial/ integration/ e2e/ chaos/ load/
  security/ threat-model.md review-report.md
  demo/ record.ts deck.py out/
  evidence/ A1/ ... A20/
  scripts/ verify-all.ts bootstrap.sh fund-wallets.ts deploy-scripts.ts
```

Tooling: pnpm workspaces and Turborepo for TypeScript, uv for Python, pinned Aiken version in `contracts/aiken.toml`, Node 20 or later, Docker Compose.

---

## 7. Build waves

Waves are ordered by dependency. Start a wave's parallel tracks as soon as their inputs exist. Each wave ends with its exit criteria met, an evaluator run, and a commit.

### Wave 0: Bootstrap

- Check prerequisites (section 10). Install Aiken, Node, pnpm, uv, Docker Compose if missing.
- Create the repo layout, harness files, `.gitignore` with `.env*`, `evidence/` scaffolding, `test-results.json` seeded all false.
- Install `masumi-skills` and `cardano-dev-skills` for all agents.
- Do the research in section 4 and write `docs/research/SUMMARY.md`.
- Bring up Yaci DevKit, Ogmios and Kupo locally. Derive wallets from the treasury and fund them on Yaci; on preprod, fund them from the treasury wallet.
- Freeze the interfaces in section 5.3.

Exit: `pnpm install` and `aiken check` run clean on the empty skeleton; local chain up; wallets funded; interfaces committed; research summary written.

### Wave 1: Contract core on local chain

- W1: `cascade_node` with `FundRoot`, `TopUp`, `Draw` (native children only), `Submit`, `Accept`, `Refund`, `SettleChild` (withdraw-zero), `CloseRoot`, `Cancel`, `Freeze`, `Unfreeze`; `cascade_config`. Property tests for invariants 1 to 8 in PRD 7.6.
- W2: codecs, tx builders for every redeemer above, deadline algebra, min-UTxO calculator, Merkle plan root, JCS and COSE helpers.
- W7: adversarial generator skeleton: for each redeemer, mutate one field and assert failure.

Exit: a 3-level, 7-node native tree funds, draws, submits, accepts, refunds one child, re-draws, settles and closes on Yaci with exact reconciliation, driven by SDK code in `tests/integration/`.

### Wave 2: Rails, services, agent server, UI shell (parallel)

- W1: `MasumiReceipt` and `MeteredReceipt` kinds, `CloseReceipt`, `Challenge`, `Resolve`, `cascade_bond`. Validate the full 19-field `vested_pay` datum on Draw.
- W2: `@cascade/x402` sell and buy sides for `default`, `masumi`, `script`; conformance tests against the spec's CBOR and `blockchainIdentifier` vectors.
- W3: indexer (Kupo or Oura into Postgres, rollback aware, WebSocket events), facilitator (verify, settle, dedupe by tx id and `termsDigest`, phase-1 validation via Ogmios), watchtower (all permissionless cranks), signer (eight gates in Cedar, gate logs).
- W4: `@cascade/agent` server with MIP-003 plus Cascade endpoints and `.well-known` files; `cascade-py` equivalent.
- W5: Next.js app shell, wallet connect via Mesh, Tree Explorer reading indexer events, receipt page.
- W6: `docker-compose.local.yml` bringing up everything above with one command.
- Metered leaves: integrate the Subbit validator. If it cannot be used as published, build a minimal Cascade voucher channel in Aiken (deposit, cumulative Ed25519 voucher, batch redeem, timeout close), document why in `DECISIONS.md`, and keep the same interface.

Exit: local stack up with one command; a Masumi leaf lock and refund work against a local `masumi-payment-service`; a metered leaf pays at least 200 calls in at most 3 L1 transactions on Yaci; explorer shows a live tree.

### Wave 3: Orchestrator, reference agents, verification

- W4: orchestrator pipeline (PRD 10.1), quote scoring, recovery table, Temporal workflows, signer integration; reference agents per PRD 21.1 (Conductor, Scout, Pricer, Lookup API, Lisan as an unmodified Masumi quickstart agent, Flaky Lisan, Checker A and B on two different model providers if a second key exists, Scribe).
- W4 and W7: verification layers L0 to L3 (PRD 11.1), verdict format, bonds.
- W5: buyer console flows (new job, plan review, fund, live job, receipt, history), provider portal, arbiter console, ops page.
- W6: MCP server and CLI over the SDK.

Exit: the full PRD 21.2 demo flow runs end to end on Yaci with real agents and real LLM calls. Local versions of A1, A2, A8 to A16 pass.

### Wave 4: Preprod

- W6: build pinned blueprint, deploy reference scripts, register the stake credential, write `deployments/preprod.json`. Stand up Masumi Payment Service instances for agent operators. Register every reference agent on the Masumi V2 registry and list them on Sokosumi. Deploy services and web apps to public URLs.
- W7: run A1 to A20 against preprod through `pnpm verify:all`. Every test writes `evidence/A#/`.

Exit: all acceptance tests have been attempted on preprod; failures are in `PROGRESS.md` with owners.

### Wave 5: Hardening

- W7: adversarial suite for T1 to T19, chaos tests, load tests (50-node trees, 20 concurrent trees), script budget report per redeemer at max fan-out.
- Security review of every validator against the `review-contract` checklist; write `security/review-report.md`; fix every critical and high finding.
- Evaluator full review; fix every `NEEDS_WORK` finding.

Exit: A1 to A20 green on preprod; zero unexpected successes in the adversarial suite; zero open critical or high findings.

### Wave 6: Demo and submission

- W8: `demo/record.ts` drives the real preprod flow with Playwright, with video recording on, and a test wallet that signs automatically, producing `demo/out/cascade-demo.mp4`. Label Flaky Lisan on screen as a test agent that fails on purpose.
- W8: `demo/deck.py` builds `demo/out/cascade-deck.pptx` with python-pptx, following PRD 21.3, with the video embedded in the slide file.
- W8: README with pitch, architecture diagram, script hashes, a table of preprod transaction links for every redeemer, run instructions, test report link. Cardano and main track write-ups in `docs/submission/`.
- Lead: final `pnpm verify:all`, final evaluator run, `FINAL_REPORT.md`, push.

Exit: section 1 definition of done holds.

---

## 8. Workstream quality bars

- **Contracts:** Plutus V3, pinned Aiken, no `trace` in production builds, every redeemer has positive, negative and property tests, execution units recorded per redeemer, `publish` handler accepts only `RegisterCredential`, every value check paired to an output by index and token.
- **SDK and x402:** every builder simulates through Ogmios before returning; closed-object validation for x402 `extra`; COSE verification includes the Blake2b-224 key-to-address check; all amounts are `bigint`.
- **Services:** idempotent by UTxO reference; rollback-safe; no secrets in logs; OpenTelemetry traces keyed by `tree_id` and `node_id`.
- **Agents and orchestrator:** the LLM process never touches keys; sub-agent outputs are schema-parsed before any LLM sees them; every LLM call logged with input and output hashes.
- **Web:** every amount shows asset and decimals; every state badge links to its transaction; plain-language tx preview before signing; works at 390 px for read-only views; CSP on.
- **Tests:** acceptance tests hit real preprod and write evidence; no network mocks in acceptance or integration tiers.

---

## 9. Verification loop and the verify script

`scripts/verify-all.ts` (run as `pnpm verify:all`) is the single gate. It:

1. Builds everything and runs `aiken check`.
2. Runs unit, conformance and integration suites on Yaci.
3. Runs the adversarial suite and fails on any unexpected success.
4. Runs acceptance tests A1 to A20 against preprod. Each test writes `evidence/A#/result.json` with tx hashes, Cardanoscan preprod links, assertions checked and timestamps, plus logs or screenshots.
5. Checks public URLs return 200.
6. Writes `test-results.json`: `{ "A1": { "passes": true|false, "evidence": "evidence/A1/result.json", "commit": "<sha>" }, ... }`.
7. Prints exactly this summary as its last lines:

```
CASCADE VERIFY SUMMARY
acceptance: <n>/20 pass (failing: <ids or none>)
aiken: <tests> tests, <failures> failures
adversarial: <cases> cases, <unexpected> unexpected successes
integration: <pass|fail>   e2e: <pass|fail>
urls: console=<status> explorer=<status>
commit: <sha>
```

Exit code 0 only when every line is green.

Run the `evaluator` subagent after each wave and on the final commit. Treat its findings as blocking.

---

## 10. Prerequisites the human already provided

Read these from the environment. Do not print their values. If one is missing, log it in `BLOCKERS.md`, apply the fallback, and continue.

| Variable | Used for | Fallback if missing |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Orchestrator planner, reference agents, verifier A | None; log blocker, build everything else |
| `SECOND_LLM_API_KEY` (optional) | Verifier B on a different provider | Verifier B uses a different Claude model and prompt; note in `DECISIONS.md` |
| `BLOCKFROST_PROJECT_ID_PREPROD` | Second provider, wallet queries | Use Ogmios and Kupo only |
| `CASCADE_TREASURY_MNEMONIC` | Preprod treasury holding test ADA; derive and fund all wallets | Local Yaci only until provided; log blocker |
| `PREPROD_TUSDM_AVAILABLE` (true or false) | Whether the treasury holds tUSDM | Run preprod acceptance with ADA budgets; keep USDM path tested on Yaci with a local test token |
| `GITHUB_TOKEN` and `GIT_REMOTE_URL` | Push the repo | Commit locally; log blocker |
| `VERCEL_TOKEN` | Deploy `apps/web` | Deploy web on the services host behind HTTPS |
| `DEPLOY_HOST` and `DEPLOY_SSH_KEY_PATH` (or `RAILWAY_TOKEN`) | Deploy services, node, Ogmios, Kupo, Temporal, Postgres | Use Demeter.run for chain access if `DEMETER_API_KEY` exists; else log blocker |

---

## 11. Fallback ladder for known risks

| Risk | What you do |
| --- | --- |
| `@x402/cardano` API differs from the spec digest | Read its source, adapt to the real API, keep spec-level behaviour, add conformance tests |
| Masumi registry registration fails on preprod | Follow the payment service docs step by step; retry with backoff; if still blocked, run the leaf as an unregistered seller (spec allows empty `agentIdentifier`) for everything except A3, and keep retrying A3 |
| Subbit validator unusable | Build the minimal Cascade voucher channel described in Wave 2 |
| Execution units exceed limits on Draw | Lower max fan-out per Draw, move shared checks into the withdraw-zero stake validator, use the merkelized validator pattern |
| Preprod congestion or rollbacks | Raise confirmation depth for settlement views; make every step idempotent by UTxO reference |
| LLM output malformed | JSON Schema tool outputs with retries; deterministic fallback plans for the demo job |
| Hosting quota or limits | Move to the next hosting option in section 10 |

---

## 12. Status block (end of every turn)

```
STATUS
wave: <n> <name>
acceptance: <n>/20 on preprod (last verify at <sha>)
aiken: <tests>/<failures>   adversarial unexpected: <n>
evaluator: <PASS|NEEDS_WORK|not run> at <sha>
done this turn: <one line>
next: <one line>
blockers: <none or ids from BLOCKERS.md>
```

---

## 13. FINAL_REPORT.md format

1. One paragraph: what shipped.
2. Public URLs: console, explorer demo tree, receipt, directory API.
3. Deployed script hashes and reference UTxOs.
4. Table: acceptance test, result, evidence link, key tx link.
5. Security summary: findings by severity, all fixed or accepted with reason.
6. Deviations from the PRD with reasons (from `DECISIONS.md`).
7. Open blockers and the human action each needs.
8. How to rerun: `pnpm verify:all`, local stack, demo recording.

---

## 14. Start now

1. Check for `AGENT_STOP` and `STEER.md`.
2. Read `CLAUDE.md`, `docs/PRD.md` in full, and `PROGRESS.md`.
3. If `PROGRESS.md` shows work in progress, resume from it. Otherwise start Wave 0.
4. Spawn the team per section 5 once interfaces are frozen.
5. Keep going until section 1 holds.
