# Cascade threat model

Owner: W7. Sources: PRD 16.1 and 16.2, `security/audit-2026-10-01-21f7228.md`, `security/re-review-2026-10-01-814cc42.md`, `docs/adr/0001-onchain-design.md` (ADR, including amendments 1.3 to 1.6, 5.2 and 8.1), `contracts/README.md` deviations. Review this file whenever an `Action`, datum field, script parameter or signer fence changes (PRD 16.3 item 6).

Rule: validators assume every off-chain party is hostile, including Cascade's own services. Off-chain components are trusted for liveness only, never for the safety of funds, with one stated exception: the purchase wallet `P` (section 4).

Every test path below exists in the repo. Chain cases are named by their report id (`tests/adversarial/report.json`, `id` field); the Yaci suite builds each from a real SDK transaction, changes one field, submits it to the node and requires a script failure, with an unmutated positive control (`tests/adversarial/README.md`).

## 1. Trust assumptions

| Component | Trusted for | Not trusted for | How the tests hold it to that |
| --- | --- | --- | --- |
| `cascade_node` shell, `cascade_logic_core`, `cascade_logic_draw`, `cascade_logic_ext`, `cascade_config`, `cascade_bond`, `cascade_channel` (ADR 1.3, 1.4) | Safety of every native node, receipt, bond and channel | Nothing beyond their code | `tests/adversarial/*.test.ts` on Yaci; preprod samples in `tests/acceptance/a10-self-draw-blocked.test.ts` to `tests/acceptance/a13-freeze.test.ts` and `tests/acceptance/a19-security-suite.test.ts` |
| Masumi `vested_pay` V2 (applied hash `a15ce9d8...14ad`) | Safety of locked Masumi payments: release only to the seller on delivery or to `buyer_return_address` on refund, per its admin model | Refund initiation (the lock's buyer key must act); disputes (Masumi admins, not Cascade arbiters) | `tests/acceptance/a04-masumi-refund-routing.test.ts` (refund lands at `buyer_refund`), `tests/adversarial/coverage-extra.test.ts` (`e1.shared_tagged_refund_output`) |
| Purchase wallet `P` and the signer that holds it (ADR 8.1) | Moving a Masumi payment from the tree into a `vested_pay` lock, and refund actions on it | Anything else: the signer's `masumi-purchaser` fence allows only lock, refund and return-to-`buyer_refund` | `packages/policy/test/purchaser.test.ts`, `services/signer/test/purchaser.test.ts`, A4 (P signs through the signer, never with a raw key) |
| Orchestrator | Liveness, hiring choices | Custody; it cannot pay itself outside settlement | A10, `tests/adversarial/draw.test.ts`; A14 runs with the orchestrator stopped |
| Signer (Cedar gates) | Blocking policy-breaking txs before signing | Anything the validators must enforce | `packages/policy/test/gates.test.ts`, `services/signer/test/signer.test.ts`; the adversarial suite builds txs with no signer in the path |
| Indexer, Directory, Explorer | Convenience views | Any balance or state without a chain link | Acceptance tests confirm every tx through Blockfrost or Koios (`tests/lib/chain.ts`), never the SDK or indexer |
| Facilitator | Broadcasting and confirmation evidence | Funds; it holds none | `services/facilitator/test/phase1.test.ts`, `services/facilitator/test/facilitator.integration.test.ts` |
| Arbiters | Rulings within threshold on Challenged or Disputed native nodes | Any other state, any node outside the dispute | `tests/adversarial/lifecycle.test.ts` (`resolve.below_arbiter_threshold`, `resolve.bond_returned_to_stranger`) |
| LLMs | Drafting plans and composing results | Signing, pricing limits, policy decisions | `packages/orchestrator/test/llm.test.ts`, `packages/orchestrator/test/agent-client.test.ts` |
| Blockfrost and Koios | Reporting what is on chain | Nothing else; the two are cross-checked | `tests/lib/chain.test.ts` (same block, fee, inputs and outputs from both) |
| Logic script stake credentials (core, draw, ext) | Registered once at deploy | Any other certificate | `contracts/validators/*.ak` publish handler tests (the chain suite cannot submit certificates without the deployer key) |

Assumptions the design relies on and that the tests cannot prove:

1. Cardano ledger rules hold: phase 1 rejects wrong signatures, validity ranges and fees; phase 2 runs every script present.
2. Blake2b-224 and SHA-256 are collision resistant (thread token names, plan leaves).
3. The buyer's key and `buyer_refund` address are under the buyer's control.
4. At least `arbiter_threshold` of the tree's arbiters are honest and live, or disputes fall back to the `dispute_until` crank.
5. The preprod chain is not rolled back deeper than the confirmation depth used for settlement views.
6. The signer and watchtower are Cascade services; a compromised signer can take in-flight Masumi payments held by `P` (section 4).

## 2. Script split and the trust it moves (ADR 1.3, 1.4)

The single `cascade_node` validator exceeded the 16,384-byte transaction limit, so its logic moved into three withdraw-zero scripts: `cascade_logic_core`, `cascade_logic_draw` and `cascade_logic_ext`. The `cascade_node` shell keeps the thread-token policy and the node address.

| Check | Where it runs | Why it holds |
| --- | --- | --- |
| The logic run belongs to this deployment | `cascade_node` `spend` and `mint`: exactly one of the three logic credentials in `withdrawals` (any amount, ADR 1.5 F2), whose `LogicRedeemer.node_hash` equals the shell's own hash | The shell is parameterised by all three logic hashes |
| Every action rule (ADR 5.1, 5.2) | The logic script named by the action set | Each logic script rejects actions outside its set and enforces full input coverage |
| Node inputs are real | Shell runs on every node input and every mint or burn | A node UTxO can only be spent through the shell |
| Bonds and channels move only inside a real node run | `cascade_bond` and `cascade_channel` authority path: `datum.authority` is the node hash and the tx mints or burns under that policy | See the fake `node_hash` attack |

**Fake `node_hash` attack (W1, Aiken test `bond_rejects_logic_withdrawal_alone`).** A logic script trusts the `node_hash` in its own redeemer; only the shell checks it. If a bond moved on a logic withdrawal alone, an attacker could run `cascade_logic_ext` with a fake `node_hash`, a fake node and a fake config naming its own arbiters, and slash a real bond. Mitigation: bond and channel authority requires a mint or burn under the node policy, which forces the shell to run. Chain test: `tests/adversarial/bond.test.ts` (`bond.slash_with_fake_node_hash`), also sampled on preprod by A19.

**Channel look-alike (ADR 1.4).** A Metered Draw mints a channel token `#"6b" ++ receipt_node_id`; every Redeem keeps it and `CloseReceipt` requires and burns it, so a look-alike UTxO cannot be closed against the receipt.

## 3. AddressPayment children (ADR 5.2)

A Draw child with `leaf.kind = AddressPayment` may pay a key address only when the payment credential is `VerificationKey(leaf.payee_hash)` bound in the buyer-signed `plan_root`, `leaf.payee_hash != parent.operator`, the output holds only the tree asset and lovelace with `0 < amount <= leaf.max_budget`, there is no external output and no mint, and `allowed_leaf_kinds` and the share cap apply. Since ADR 1.6 E1 the output must also carry no datum and no reference script.

Invariant 2 reads: no Draw output pays a key address except a plan-bound, non-operator AddressPayment payee. Residual risk: a buyer who approves a leaf paying a sock puppet (T3) pays it; the plan review and the signer's plan-match gate are the controls. Chain tests: `tests/adversarial/draw.test.ts` (`draw.address_payment_to_operator`, `draw.child_output_to_operator_key`), preprod A10.

## 4. Masumi leaves through the purchase wallet P (ADR 8.1)

The Masumi Payment Service skips any `vested_pay` lock created in a transaction with redeemers, and every Cascade Draw has redeemers. So a Masumi hire is an AddressPayment Draw to a dedicated key `P` (role `masumi-purchaser`, bound in the plan leaf as `payee_hash`), followed by a plain key-signed lock from `P` with `buyer_return_address = Some(buyer_refund)`.

| Property | Enforced by | Test |
| --- | --- | --- |
| The tree pays `P` only what the plan approved | Validators (AddressPayment rules, section 3) | `tests/adversarial/draw.test.ts`, A3 (`lock value equals the AddressPayment to P`) |
| `P` locks exactly what it received, into the approved script, for a plan-approved seller, refunding to `buyer_refund` | Signer fence (`masumi-purchaser` role) | `packages/policy/test/purchaser.test.ts`, `services/signer/test/purchaser.test.ts`, A3 (`lock buyer_return_address is the tree's buyer_refund`) |
| Locked funds go only to the seller on delivery or to `buyer_refund` on refund | `vested_pay` | A3 (Lisan's SubmitResult), A4 (WithdrawRefund lands at `buyer_refund`, nothing to the orchestrator, `P` keeps nothing) |
| Refund actions go only to `buyer_refund` | `vested_pay` (`buyer_return_address`) and the signer's refund fence | A4 signs `P`'s WithdrawRefund through the signer service only, never with `P`'s raw key |
| A payment `P` cannot lock returns to `buyer_refund` | Signer fence (return path, ADR 8.1 4a) | `packages/policy/test/purchaser.test.ts` |
| Failed leaves refund without the Conductor | Watchtower crank through the signer's `P` role (ADR 8.1 4b) | `services/watchtower/test/selection.test.ts` |

**Custody window and the stated trust.** Between the Draw that pays `P` and the lock (normally one block), or until the return action, the payment sits at a key the signer holds. A compromised signer could take in-flight Masumi payments held by `P`. It cannot take a locked payment (`vested_pay` releases only to the seller or `buyer_return_address`), cannot redirect a refund, and cannot touch any tree escrow (the validators ignore the signer). This is the one place where an off-chain Cascade service is trusted with funds, bounded to the in-flight amount of open Masumi hires.

**The tree may close before the Masumi escrow resolves.** The AddressPayment is final for the tree; the seller's withdrawal or the refund happens later on Masumi's schedule. The receipt's Masumi line carries the outcome (`withdrawn` or `refunded`) and its transaction, so A4's "the receipt closes" means that line reaches `refunded`.

**Masumi datum fields constrained on chain (ADR 1.6 E8).** When Cascade writes a lock through a `MasumiReceipt` Draw (`contracts/lib/cascade/node.ak`, Masumi lock check), 14 of the 19 `vested_pay` V2 fields are constrained: `buyer` (the parent operator key), `buyer_return_address` (`Some(buyer_refund)`), `seller` (the receipt payee), `seller_return_address` (none, or a key address), `collateral_return_lovelace` (0 or at least the Masumi minimum, and within `external_lovelace`), `input_hash`, `result_hash` (empty), the four deadlines (ordered and inside the receipt's `dispute_until`), both cooldowns (0) and `state` (`FundsLocked`); the output value and script hash are checked too. `reference_signature` is checked only for length (at least 16 bytes). `reference_key`, `seller_nonce`, `buyer_nonce` and `agent_identifier` are not constrained: they come from the seller's signed terms, which a validator cannot verify without the seller's signature, so the SDK and the signer check them off chain before signing (T5). On the ADR 8.1 path `P` writes the lock with no script, so the signer's `masumi-purchaser` fence enforces the same mapping, and A3 checks the resulting datum on chain (seller agent is Lisan's V2 registry asset, `buyer_return_address`, value).

## 5. Validator tightenings beyond the ADR text (contracts/README.md)

| Tightening | Threat closed |
| --- | --- |
| Payee lovelace capped at 2,000,000 on SettleChild, Resolve, CloseRoot and AddressPayment extra lovelace; the Resolve deadline exit pays none (E12) | A cranker routing the structural reserve to a payee (invariant 1, T4) |
| `child.refund_after + min_safety_margin <= parent.submit_by` on Draw | A child whose refund lands after the parent must submit (invariant 4, T6) |
| Refund raises the parent's `structural` by the child's | Lovelace unaccounted in the parent datum (invariant 1) |
| TopUp and SettleChild locate the config by its token in reference inputs | A forged config supplied by index (T1) |
| Resolve at the root requires `config_ref == config_in` | Config read from a different UTxO than the one spent (T2) |
| Every key-address payout carries no datum and no reference script (E1) | One Masumi-tagged output satisfying a Cascade exit and a Masumi refund at once (T2) |
| `min_dispute_window > 0` and `dispute_until - challenge_until >= min_dispute_window` (E6) | A worker with no time to escalate (T7) |
| Plan leaf binds `acceptance_hash` (E7) | Verifier keys not approved by the buyer (T8) |
| Metered channel datum fixed at Draw; `timeout >= receipt.submit_by` (E14) | Deposit leaving the tree (T5) |

## 6. Audit findings F1 to F5 (fixes in ADR 1.5; re-review confirms all fixed)

| ID | Severity | Threat | Fix | Tests |
| --- | --- | --- | --- | --- |
| F1 | Critical | Liveness: `committed` never returned to 0 after payouts below a node | `NodeDatum.spent`; `budget` never decreases | `tests/integration/f1-deep-payout.test.ts`, `tests/integration/wave1-tree.test.ts`, Aiken `contracts/lib/cascade/tests/audit.ak` |
| F2 | Critical | Liveness, T18: a forced reward balance on a logic credential halted every tx | Logic credential presence only, any amount | `tests/integration/f2-withdrawal-amount.test.ts` (evaluation with a 1 ADA withdrawal; submission needs a real reward balance the devnet cannot create), Aiken `contracts/lib/cascade/tests/audit.ak` |
| F3 | Medium | Stuck root when `protocol_fee_bps > 0` | `CloseRoot.protocol_lovelace` from `structural`, capped | Aiken `contracts/lib/cascade/tests/audit.ak` (`audit_f3_*`); no chain case yet, because the deployed trees use `protocol_fee_bps = 0` |
| F4 | Medium | Early Metered close erasing unredeemed vouchers | Close only after `timeout` or with the provider's signature | `tests/adversarial/close-receipt.test.ts` (`close_receipt.metered_early_close_by_operator`), preprod A19 |
| F5 | Medium | T7: a challenge cost nothing with silent arbiters | `arbiter_threshold >= 1` with Native leaves; Disputed exit pays the worker its fee | `tests/adversarial/fund-root.test.ts` (`fund_root.no_arbiters_with_native_leaves`), preprod A19 |
| L1 | Low | Self-hire through leaf reuse | Signer plan-match and counterparty gates | `packages/policy/test/gates.test.ts` |
| L2 | Low | Sub-min-UTxO slash share makes SlashBond unbuildable | Accepted; ReturnBond always works | none |

## 7. Threats, on-chain checks and tests

| # | Threat | Concrete checks | Tests |
| --- | --- | --- | --- |
| T1 | Fake child or token | Every node input and output holds exactly one node-policy token named `node_id` (ADR 1.2); child names derived from `next_child`; config spend needs its token burned | `tests/adversarial/draw.test.ts` (`draw.child_output_without_thread_token`, `draw.child_token_to_wallet`); `tests/adversarial/lifecycle.test.ts` (`settle_child.token_not_burned`, `refund.token_not_burned`, `cancel.config_token_not_burned`, `global.extra_mint`); `tests/adversarial/coverage-extra.test.ts` (`draw.parent_next_child_unchanged`, `fund_root.root_depth_not_zero`, `fund_root.seed_not_spent`) |
| T2 | Double satisfaction | Input coverage, unique output indices, mint exactness, one logic withdrawal per tx (ADR 1.2, 1.3); NoDatum payouts (E1) | `tests/adversarial/draw.test.ts` (`draw.two_children_name_one_output`); `tests/adversarial/lifecycle.test.ts` (`global.unclaimed_cascade_input`, `global.extra_mint`, `settle_child.payee_carries_datum`, `cancel.refund_carries_datum`, `close_root.refund_carries_datum`); `tests/adversarial/coverage-extra.test.ts` (`e1.shared_tagged_refund_output`, `draw.parent_children_open_off_by_one`, `close_receipt.masumi_parent_counters_off`) |
| T3 | Orchestrator self-dealing | Plan membership (ADR 3); AddressPayment payee plan-bound and not the operator (ADR 5.2) | `tests/adversarial/draw.test.ts` (`draw.leaf_outside_plan_root`, `draw.address_payment_to_operator`, `draw.child_output_to_operator_key`); preprod A10, A11; `packages/policy/test/gates.test.ts` |
| T4 | Over-pricing or skimming | Leaf `max_budget`, `max_fee`, share cap, totals; exact value checks | `tests/adversarial/coverage-extra.test.ts` (`draw.child_budget_above_leaf_max`, `draw.child_fee_above_leaf_max`, `draw.child_share_above_cap`, `fund_root.root_value_short`, `fund_root.bps_above_10000`); `tests/adversarial/lifecycle.test.ts` (`top_up.budget_grows_more_than_paid`, `settle_child.payee_short`, `refund.parent_short`, `cancel.refund_short`, `close_root.payee_overpaid`, `accept.raises_fee`, `freeze.changes_more_than_frozen`) |
| T5 | Stranded or redirected external funds | Masumi lock fields (E8, section 4); channel datum fixed at Draw; F4 close rule; voucher signature | `tests/adversarial/close-receipt.test.ts`; `tests/adversarial/coverage-extra.test.ts` (`close_receipt.masumi_without_operator_early`, `fund_root.buyer_refund_is_script`); `tests/adversarial/lifecycle.test.ts` (`channel.redeem_above_voucher`, `channel.payout_above_claim`); A3, A4 |
| T6 | Deadline games | Validity range normalisation; deadline nesting; time-gated actions | `tests/adversarial/draw.test.ts` (`draw.dispute_until_breaks_parent_window`); `tests/adversarial/lifecycle.test.ts` (`submit.state_skips_to_accepted`, `close_root.early_without_buyer`); `tests/adversarial/coverage-extra.test.ts` (`close_receipt.deadline_close_too_early`, `bond.reclaim_before_release`, `fund_root.root_state_submitted`); preprod A12 |
| T7 | Challenge griefing | Challenger is buyer or parent operator; bond at least `challenge_bond`; F5; E6 | `tests/adversarial/lifecycle.test.ts` (`challenge.not_signed_by_challenger`, `challenge.bond_below_minimum`, `escalate.not_signed_by_operator`, `escalate.state_accepted`); `tests/adversarial/fund-root.test.ts`; `tests/adversarial/coverage-extra.test.ts` (`fund_root.min_dispute_window_zero`, `bond.reclaim_without_owner`) |
| T8 | Verifier collusion | `VerifierQuorum` k distinct signatures from leaf-approved keys (E7) | `tests/adversarial/lifecycle.test.ts` (`accept.signed_by_stranger`); A9 run 1 (two of three verifier signatures on the Accept, from chain) |
| T9 | Arbiter collusion | Arbiter threshold at FundRoot; Resolve needs `t` signatures; bonds move only with a node burn | `tests/adversarial/fund-root.test.ts` (`fund_root.threshold_above_arbiters`); `tests/adversarial/lifecycle.test.ts` (`resolve.below_arbiter_threshold`, `resolve.bond_returned_to_stranger`); `tests/adversarial/bond.test.ts`; A9 run 2 |
| T10 | Prompt injection from results | Results schema-parsed before any LLM; LLM has no fund-moving tools; signer re-checks | `packages/orchestrator/test/agent-client.test.ts`, `packages/orchestrator/test/llm.test.ts`, `packages/policy/test/gates.test.ts` |
| T11 | Malicious payloads in results | Sandboxed rendering, size caps, CSP (`apps/web/next.config.ts`) | `apps/web/src/lib/api/schemas.test.ts`, `apps/web/src/server/routes.test.ts`; Playwright `tests/e2e/public.readonly.spec.ts` (no console errors on public routes) |
| T12 | Replay of quotes or x402 terms | `termsDigest` and commitment parts; nonces; spec hash on chain | `packages/x402/test/conformance.test.ts`, `packages/x402/test/sell.test.ts`; A6 (PAYMENT-RESPONSE bound to the lock tx) |
| T13 | Duplicate settlement at the facilitator | Canonical tx-id cache plus `termsDigest` binding | `services/facilitator/test/facilitator.integration.test.ts`, `services/facilitator/test/phase1.test.ts` |
| T14 | Rollbacks | Indexer re-intersects on a stale point | `services/indexer/test/follower.test.ts`; A16 |
| T15 | Execution-unit exhaustion | `max_fanout` on Draw; every action under 14M memory | `contracts/BUDGET.md`; depth and fan-out caps in the Aiken property tests (`contracts/lib/cascade/tests/properties.ak`); the chain load suite `tests/load/fanout.test.ts` still fails as not yet implemented |
| T16 | Orchestrator key theft | A stolen operator key cannot pay itself, exceed leaves or skip deadlines; buyer Freeze blocks new Draws | `tests/adversarial/draw.test.ts` (`draw.at_frozen_root`, `draw.below_frozen_root`); `tests/adversarial/lifecycle.test.ts` (`freeze.not_signed_by_buyer`, `unfreeze.not_signed_by_buyer`, `top_up.not_signed_by_buyer`, `submit.not_signed_by_operator`); `tests/adversarial/coverage-extra.test.ts` (`draw.not_signed_by_operator`); preprod A13 |
| T17 | Indexer shows a false state | Explorer links every state to a tx; tests read the chain directly | `tests/lib/chain.test.ts`; `apps/web/e2e/flows.spec.ts` (every state badge links to Cardanoscan); `tests/e2e/local.live-tree.spec.ts` |
| T18 | Stake credential attack | Logic credential presence (F2); `publish` accepts only registration | `tests/adversarial/lifecycle.test.ts` (`global.no_logic_withdrawal`); `tests/adversarial/bond.test.ts`; `tests/integration/f2-withdrawal-amount.test.ts`; publish handlers in Aiken `contracts/validators/*.ak` |
| T19 | Supply chain | Frozen lockfile with pnpm supply-chain policy checks, pinned Aiken and stdlib in `contracts/aiken.lock`, exact versions in manifests | No test file; the build stage of `pnpm verify:all` installs from the frozen lockfile |

## 8. Invariants (PRD 7.6) to tests

| Invariant | Aiken property tests (W1) | Chain tests (W7) |
| --- | --- | --- |
| 1 Conservation | per Action value rules, `spent` accounting | `tests/integration/wave1-tree.test.ts`; A1, A2 (escrow in equals escrow out, to the lovelace) |
| 2 No self-draw (restated by ADR 5.2) | Draw key-address rule, AddressPayment payee rules | A10, `tests/adversarial/draw.test.ts` |
| 3 Containment | Draw totals, share cap | `tests/adversarial/coverage-extra.test.ts` (cap cases) |
| 4 Deadline nesting | Draw deadline rules | A12, `tests/adversarial/draw.test.ts` |
| 5 Completion before payment | Submit and SettleChild `children_open == 0` | `tests/integration/wave1-tree.test.ts` (parents submit only after children settle) |
| 6 Liveness | deadline paths for every state; F1, F2 | A14, `tests/integration/f1-deep-payout.test.ts`, `tests/integration/f2-withdrawal-amount.test.ts` |
| 7 Uniqueness | token checks, mint exactness, channel token | T1 cases above |
| 8 No double satisfaction | index pairing, NoDatum payouts | T2 cases above |
