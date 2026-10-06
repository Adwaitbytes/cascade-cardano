# Research summary

What the PRD assumed, what the sources say, and the decision taken. Details and pinned commits are in the per-source digests in this folder. Decisions are also logged in `DECISIONS.md`.

## Pinned versions

| Component | Version |
| --- | --- |
| Aiken compiler | v1.1.24 |
| aiken-lang/stdlib | v4.0.0 (`dfdf5ffc`) |
| aiken-lang/fuzz | v3.0.0 (`96b6ecea`) |
| Anastasia-Labs/aiken-design-patterns | v1.9.0 (`0594253c`), needs keyan-m/aiken-scott-utils v1.5.0 added explicitly |
| @lucid-evolution/lucid | 0.6.5 |
| @cardano-ogmios/client | 7.0.0 |
| @meshsdk/core, @meshsdk/react | 1.9.1, 1.9.0-beta.98 |
| @x402/core, @x402/cardano | 2.28.0 |
| Yaci DevKit | v0.12.0-beta5 (cardano-node 11.0.1, protocol 11, network magic 42, 1 s slots) |
| Ogmios and Kupo for preprod | v7.0.0 and v2.12.0 (Yaci bundles Ogmios 6.14 and Kupo 2.11; method names match) |
| Masumi V2 registry policy | `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b` (confirmed on preprod) |
| Masumi `vested_pay` V2 applied hash (preprod) | `a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad`, address `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g` |

## Differences and decisions

| # | PRD assumed | Sources say | Decision |
| --- | --- | --- | --- |
| 1 | Any Masumi agent can be paid through the x402 `masumi` method and stay unmodified | An x402 `masumi` lock signs x402 terms the Masumi payment service rejects, so the agent cannot submit or refund with its own tooling (x402-cardano-spec.md) | Pay unmodified Masumi agents through their native `/start_job` purchase flow; use x402 `masumi` only on Cascade's sell side (A6) |
| 2 | Subbit validator used as an Aiken dependency | Aiken project sits in a subfolder, needs stdlib v3.1.0, channel owner must be a key, close path does not constrain outputs (subbit.md) | Build `cascade_channel` with the same cumulative-voucher model and tree-safe close (ADR 0001 section 9) |
| 3 | A standard facilitator could settle Cascade payments | Hosted facilitators list no Cardano network; the spec requires rejecting mint txs without full phase-1 validation | Cascade runs its own facilitator with Ogmios evaluation and Postgres dedupe |
| 4 | MIP-003 has 5 endpoints | 6 endpoints: 4 required, `/provide_input` and `/demo` optional; `input_hash` per MIP-004 is SHA-256 of `identifier_from_purchaser ; canonical JSON` (mip-003.md) | Serve all 6; follow MIP-004 hashing |
| 5 | Registry metadata is CIP-68 | CIP-25 label 721, strings chunked to 60 bytes, V2 schema needs `metadata_version: 2` and `supported_payment_sources` (masumi-registry.md) | Write V2 metadata exactly; trust chain entries only after a Directory allowlist check (anyone can mint under the policy) |
| 6 | Unmodified CrewAI quickstart agent works as a V2 leaf | Template's `masumi` 1.2.0 Python package creates V1 payments and omits the V2 payment-source index (crewai-quickstart.md) | W4 verifies against a running payment service; if V1-only, run the template unmodified against a payment service configured with the source it supports, record the gap in DECISIONS.md, keep retrying V2 |
| 7 | Masumi services can run on any provider | Payment Service and Registry Service support only Blockfrost | Blockfrost preprod key obtained (B3 resolved) |
| 8 | Sokosumi listing by API at docs.sokosumi.com | Docs live at masumi.network/dev/sokosumi; preprod listing is automatic after registration with tUSDM pricing (unverified); no listing API; mainnet needs a human form | Register with tUSDM pricing on preprod and verify listing; log a blocker if it does not appear |
| 9 | `aiken add anastasia-labs/aiken-design-patterns` is enough | Aiken does not fetch transitive dependencies | Add aiken-scott-utils v1.5.0 explicitly |
| 10 | stdlib `Value` API | stdlib v4 renamed `Value` to `Assets`; redeemer order Spend < Mint < Publish < Withdraw | Code against v4; SDK computes withdraw redeemer indices in that order |
| 11 | Ogmios and Kupo run as separate Compose services locally | Yaci bundles Ogmios and Kupo; Kupo does not index genesis UTxOs | Use Yaci's bundled Ogmios and Kupo; fund local wallets by topup, not genesis |
| 12 | A16 forced rollback on Yaci | `rollback N` needs yano-primary mode; snapshot rollback restarts the node (clients see a dropped connection, not RollBackward); multi-node consensus rollback is unreliable in Docker (yaci-devkit.md) | Indexer treats reconnect-with-stale-point as a rollback: re-intersect from its last confirmed points and mark rolled-back events. A16 uses Yaci snapshot rollback and checks the indexer and UI converge within one block with no phantom states |
| 13 | Blockfrost as the only second provider | Koios public tier: 100 req per 10 s, `/ogmios` proxy supports evaluate and submit; Koios cannot report confirmation depth | Koios is a fallback provider; Blockfrost is primary for preprod queries and confirmations |
| 14 | Mesh React 1.9 stable | Only `1.9.0-beta.98` or `2.0.0-beta` | Pin `@meshsdk/react@1.9.0-beta.98` with `@meshsdk/core@1.9.1` |
| 15 | Yaci and preprod budgets identical | Yaci per-tx memory 16.5M, preprod 17.5M | Budget every action under 14M memory so both networks accept it; differential tests compare balances, not units |
| 16 | Validity ranges can be long | Yaci evaluation fails when `validTo` is more than about 300 s ahead of the tip (PastHorizon) | SDK caps validity windows at 240 s ahead on local and preprod |
| 17 | Masumi disputes settled by Cascade arbiters | Masumi leaf disputes need Masumi admin keys (2-of-3 multisig, 7 minute cooldown) | Cascade arbiters rule only on native nodes (as PRD 11.4 item 4 already says); Masumi disputes are out of Cascade's hands and shown as such |
