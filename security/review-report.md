# Validator review report

Scope: `contracts/` (Aiken v1.1.24, Plutus V3).

- Audit `security/audit-2026-10-01-21f7228.md` (F1 to F5): fixed in
  `814cc42` per ADR 0001 section 1.5; re-reviewed in
  `security/re-review-2026-10-01-814cc42.md`.
- End-of-wave evaluator (E1 to E14): fixed in `ddeab4b` per ADR 0001
  section 1.6.

Result at `86cb9a1` (`demo/out/aiken-check.json`): `aiken check` runs 735
tests (672 unit, 63 property), 6,972 checks, 0 failures. At `ddeab4b` every
script compiled under 15,500 bytes with traces silent (largest:
`cascade_logic_core`, 14,874 bytes); current figures per action are in
`contracts/BUDGET.md`.

## Evaluator findings (ADR 1.6)

| ID | Fix in `ddeab4b` | Regression tests (`contracts/lib/cascade/tests/evaluator.ak` unless noted) |
| --- | --- | --- |
| E1 (critical, cross-script double satisfaction) | Every Cascade payout to a key address (payee, protocol, refund, bond return and slash, AddressPayment) must have `NoDatum` and no reference script, so an output tagged for Masumi's `WithdrawRefund` never satisfies a Cascade check. | `e1_cross_script_double_satisfaction_root_refund`, `_cancel`, `_close_root_refund`, `e1_close_root_payee_cannot_carry_a_datum`, `e1_settle_payee_cannot_carry_a_datum`, `e1_resolve_payee_cannot_carry_a_datum`, `e1_bond_return_cannot_carry_a_datum`, `e1_resolve_root_refund_cannot_carry_a_datum`, `e1_address_payment_cannot_carry_a_datum`, `e1_payout_cannot_carry_a_reference_script`, `e1_untagged_payouts_still_pass`, `prop_tagged_payout_never_counts` |
| E6 | `TreeConfig.min_dispute_window` (field 20) > 0; FundRoot and Draw require `dispute_until - challenge_until >= min_dispute_window`. | `e6_config_needs_positive_dispute_window`, `e6_root_dispute_window_below_minimum`, `e6_root_dispute_window_at_minimum`, `draw_rejects_dispute_window_below_minimum` (tests/draw.ak), `prop_dispute_window_below_minimum_fails` (tests/properties.ak) |
| E7 | `PlanLeaf.acceptance_hash` (field 6), appended to `leaf_bytes`; Draw requires `sha2_256(acceptance_bytes(child.acceptance)) == leaf.acceptance_hash`. | `draw_rejects_acceptance_not_in_plan`, `draw_rejects_quorum_keys_not_in_plan`, `draw_rejects_quorum_threshold_not_in_plan`, `draw_accepts_buyer_accept_for_buyer` (tests/draw.ak); `acceptance_bytes_encoding`, `acceptance_bytes_keep_key_order`, `leaf_binds_acceptance_hash` (lib/cascade/merkle.ak) |
| E8 | Masumi `seller_return_address`, when set, must be a key address. The four seller-signed fields are checked off chain (ADR 1.6). | `e8_seller_return_to_script_rejected`, `e8_seller_return_to_key_accepted` |
| E12 | Resolve deadline exit: `payee_lovelace == 0`, except a Disputed node's fee paid in a native asset, whose output needs min-UTxO lovelace (capped at 2 ADA). Without this exception a Disputed node in a token tree could never close; flagged to the lead. | `e12_challenged_exit_pays_no_lovelace`, `e12_disputed_exit_in_lovelace_tree_pays_no_lovelace`, `e12_disputed_exit_in_token_tree_carries_min_utxo` |
| E13 (low) | Accepted and documented (stake part of an AddressPayment payee not enforced). | n/a |
| E14 | `arbiter_fee_address` and `protocol_fee_address` are key addresses; a Metered channel's `timeout >= receipt.submit_by`. | `e14_arbiter_fee_to_script_rejected`, `e14_protocol_fee_to_script_rejected`, `e14_channel_timeout_before_receipt_submit_by`, `e14_channel_timeout_at_receipt_submit_by` |
| Item 11 | Property tests per redeemer and for invariants 1, 4, 6, 8 across paths. | tests/evaluator.ak: `prop_fund_root_*`, `prop_top_up_*`, `prop_challenge_*`, `prop_escalate_*`, `prop_resolve_*`, `prop_close_metered_*`, `prop_close_masumi_after_deadline`, `prop_cancel_*`, `prop_freeze_*`, `prop_unfreeze_needs_the_buyer`, `invariant_1_conservation_on_every_path`, `prop_receipt_deadline_past_margin_fails`, `prop_channel_timeout_past_receipt_deadline_fails`, `prop_deadline_exits_need_nobody`, `prop_bond_payouts_never_share`; validators/cascade_bond.ak `prop_bond_*`; validators/cascade_config.ak `prop_config_wrong_burn_fails`; validators/cascade_channel.ak `prop_channel_*` |

Interface changes for codecs (W2): `TreeConfig` field 20
`min_dispute_window: Int`; `PlanLeaf` field 6 `acceptance_hash: ByteArray`
(32 bytes), appended to `leaf_bytes`. Until `packages/shared/test/vectors.json`
carries them, `contracts/scripts/gen_vectors.py` leaves out the plan leaf,
Merkle, `tree_config` and Draw-bearing redeemer vectors with a warning; the
token-name, node, bond and other redeemer vectors still run.

## Audit findings (ADR 1.5)

| ID | Severity | Fix in `814cc42` | Regression tests (all in `contracts/`) |
| --- | --- | --- | --- |
| F1 | Critical | `NodeDatum` field 25 `spent`. `budget` never decreases; `committed` counts only open children; a node holds `budget - committed - spent`. Closing child `d`: `p.committed -= d.budget`, `p.spent += d.spent + paid_out`. Draw and AddressPayment use `spent` (`lib/cascade/node.ak`, `lib/cascade/value.ak`). | `lib/cascade/tests/audit.ak`: `prop_depth_three_tree_closes_with_exact_conservation` (root, child, grandchild, vendor payment, two settlements and CloseRoot; every step validates, conserves value, and the deposit equals all payouts plus the refund exactly), `audit_f1_settle_returns_commitment_to_zero`, `audit_f1_phantom_commitment_is_rejected`; `settle_rejects_budget_lowered_instead_of_spent`, `payment_rejects_budget_lowered_instead_of_spent` |
| F2 | Critical | The node shell accepts exactly one of the three logic credentials by presence, any amount; logic scripts check only presence of their own credential. | `audit_f2_reward_balance_no_longer_halts`, `audit_f2_logic_credential_still_required`, `prop_any_withdrawal_amount_is_accepted`, `accepts_nonzero_withdrawal`, `fund_root_accepts_forced_reward_withdrawal`, `validators/cascade_node.ak` `node_spend_accepts_forced_reward_withdrawal` |
| F3 | Medium | `CloseRoot.protocol_lovelace` (after `payee_lovelace`), capped at 2,000,000 and by the structural left after the payee; the protocol output is `asset(fee) + lovelace(protocol_lovelace)`; both must be 0 when there is no protocol output. | `audit_f3_protocol_output_with_lovelace_passes`, `audit_f3_protocol_close_conserves_value`, `audit_f3_protocol_lovelace_capped`, `audit_f3_protocol_lovelace_without_protocol_fee_rejected`, `audit_f3_protocol_output_short_of_its_lovelace` |
| F4 | Medium | A Metered CloseReceipt needs the channel provider's signature or a validity range after the channel `timeout`, in addition to the receipt rule. | `audit_f4_operator_cannot_close_channel_before_timeout`, `audit_f4_provider_may_close_early`, `audit_f4_operator_closes_after_timeout`, `audit_f4_anyone_closes_after_timeout_and_deadline` |
| F5 | Medium | FundRoot requires `arbiter_threshold >= 1` when `Native` is an allowed leaf kind. The Resolve deadline exit gives the parent everything when the node is Challenged and pays the worker exactly its `fee` when Disputed; bonds are untouched. | `fund_root_rejects_no_arbitration_with_native_leaves`, `fund_root_accepts_no_arbitration_without_native_leaves`, `audit_f5_silent_arbiters_pay_the_worker_its_fee`, `audit_f5_disputed_exit_conserves_value`, `audit_f5_disputed_exit_cannot_starve_the_worker`, `audit_f5_disputed_exit_cannot_overpay_the_worker`, `audit_f5_unescalated_challenge_still_goes_to_parent`, `audit_f5_unescalated_challenge_pays_worker_nothing` |
| L1 | Low | Not changed on chain; off-chain signer plan-match gates (ADR 3). | n/a |
| L2 | Low | Accepted; arbiters choose a buildable ruling, ReturnBond always works. | n/a |

## Fixed in the same commit, found by W2

Receipt Draw required the receipt datum's `external_ref` to name an output of
the same transaction, which no transaction can satisfy (its id depends on the
datum). ADR 8 is amended: receipts carry `external_ref = None`; the Metered
channel is identified by its thread token (ADR 1.4), Masumi locks off chain.
Tests: `masumi_draw_ok`, `metered_draw_ok`, `masumi_rejects_any_external_ref`.

## Interface changes for codecs

- `NodeDatum` gains field 25 `spent: Int` (starts at 0 for every new node).
- `Action.CloseRoot` gains `protocol_lovelace: Int` between `payee_lovelace`
  and `protocol_out`.
- The protocol fee is `floor((budget - spent - fee) * protocol_fee_bps / 10000)`.

The cross-language vector tests (`contracts/lib/cascade/tests/vectors.ak`)
were regenerated from W2's working copy of `packages/shared/test/vectors.json`
that already carries these changes, and pass. They must be regenerated
(`python3 contracts/scripts/gen_vectors.py`) once W2 commits that file.

## Earlier findings by W1 (before the audit)

- Bond and channel authority is the node policy with a forced mint or burn
  (ADR 1.3): `bond_rejects_logic_withdrawal_alone`,
  `channel_close_rejects_logic_withdrawal_alone`.
- Channel thread token (ADR 1.4): `metered_close_rejects_look_alike_channel`.
- Payee lovelace cap of 2,000,000 so a cranker cannot move the structural
  reserve: `settle_rejects_payee_lovelace_above_cap`,
  `close_root_rejects_payee_lovelace_above_cap`.

## Pre-final evaluator findings on the Masumi purchase-wallet path (ADR 8.1)

These are off-chain findings: the purchase wallet `P` is a key held by the signer, so the controls are the signer's `masumi-purchaser` fence and the watchtower, not validators. Design decision: `a266f65` (ADR 8.1 items 4a and 4b, trust assumption). Threat model: `security/threat-model.md` section 4.

| Finding | Severity | Risk | Resolution | Fix commits | Tests |
| --- | --- | --- | --- | --- | --- |
| Draw-to-P crash gap | Medium | The orchestrator crashes after the Draw pays `P` and before `P` locks; the payment sits at `P` with no owner action (stuck, not stolen) | Fixed. The fence's return rule (`packages/policy/src/purchaser.ts` `evaluateReturn`) lets `P` send a never-locked payment back to `buyer_refund` once `purchaserReturnDueAt` (Draw time plus the plan's longest Masumi work window plus `min_safety_margin`) has passed, or at once after `POST /v1/masumi/failed`. Two independent runners: the hire workflow starts `masumiReturnWorkflow` when the lock fails (Temporal resumes it after a crash), and the watchtower's `MasumiReturn` crank (`services/watchtower/src/selection.ts` `selectPurchaserCranks`) needs neither the Conductor nor the orchestrator. | `3fb4142` (fence), `1f3514e` (SDK `returnUnlockedToBuyer`), `75a0739` (orchestrator), `bac8601` (watchtower) | `packages/policy/test/purchaser.test.ts` (return describe block), `services/signer/test/purchaser.test.ts`, `services/watchtower/test/purchaser.test.ts`, Yaci A3 return path (`agents/conductor/test/yaci.integration.test.ts`) |
| `P` return path scope | High | A return action that could pay anywhere would make `P` a general wallet | Fixed. The return rule refuses any mint, withdrawal, certificate, unresolved input or non-`P` input; needs at least one input the indexer saw a Cascade Draw pay to `P`, all from one tree; allows exactly one non-change output, to the tree's `buyer_refund`, carrying exactly the received value; change to `P` may not exceed `P`'s other inputs net of the fee. `POST /v1/masumi/failed` is bearer-authenticated and only accepts indexed AddressPayment out refs; a mark only shortens the timeout, it never changes the destination. Residual, not exploitable for funds: `paysTo` matches `buyer_refund` by payment credential only, so a caller holding the signer token could choose the stake part of the returned output. | `3fb4142` | `packages/policy/test/purchaser.test.ts`, `services/signer/test/purchaser.test.ts` |
| Refund liveness | Medium | A failed Masumi leaf refunds only if the Conductor is alive (stuck, not stolen) | Fixed. The watchtower selects `MasumiRefund` for every unspent `P` lock with no result in FundsLocked or RefundRequested after `submit_result_time` plus grace, or in RefundAuthorized, and submits `WithdrawRefund` through the signer's `masumi-purchaser` role (`withdrawMasumiRefundViaPurchaser`), checking that `buyer_refund` received the whole lock. `vested_pay` lets the buyer withdraw from FundsLocked once `submit_result_time` has passed, so the crank skips `SetRefundRequested`. The fence signs a refund only for a lock whose creating transaction it approved, with every non-change output paying `buyer_refund`; `vested_pay` enforces the full value to `buyer_return_address`. Enabled only when `deployments/wallets.<network>.json` lists the purchaser and `CASCADE_SIGNER_URL` and `CASCADE_SIGNER_TOKEN` are set (`services/run/src/services.ts` sets both). | `bac8601` (watchtower), `1f3514e` (SDK drivers) | `services/watchtower/test/purchaser.test.ts`, `packages/policy/test/purchaser.test.ts` (refund cases), A4 on preprod |

Verified against the code at the commit that records these verdicts: each fix commit exists and the fence, orchestrator and watchtower code it added is still in place.

