# Adversarial transaction suite

PRD 16.3 item 2 and 19.1: for each redeemer, generated transactions that change one field must fail on chain. Threat mapping: `security/threat-model.md`.

## Method

Code: `lib/raw-tx.ts`, `lib/verdict.ts`, `lib/runner.ts`. The SDK is used only to build the honest transaction; it is never in the mutated path, so SDK-side checks cannot hide a validator gap.

1. Build the honest transaction for an `Action` with `@cascade/sdk` against the scripts deployed by `pnpm local:up` (refs from `deployments/local.runtime.json`, checked against `contracts/plutus.json`).
2. Lift it into a raw plan: script inputs, pinned wallet inputs, reference inputs, outputs, mint, the decoded `LogicRedeemer`, signers, validity range, withdrawal amount.
3. Positive control: rebuild the unchanged plan with Lucid and Ogmios evaluation. It must pass, so a later rejection comes from the mutation and not from the lift.
4. Apply exactly one mutation (a datum field, a redeemer field, an output, the mint, an input or reference input, plus only the index fix-ups that mutation forces).
5. Build the mutated plan with Lucid and a `VerdictRecorder` evaluator: it records Ogmios's verdict and, when scripts fail, still returns generous execution units so the transaction can be finished, signed and submitted.
6. Submit to the Yaci node through Ogmios and classify:
   - `rejected_by_script`: Ogmios evaluation named the failing validators (3010) and the node refused the tx because its scripts failed while it was declared valid (3136 ValidationTagMismatch). The only outcome that proves a mitigation.
   - `accepted`: the node took the tx, or every script passed and the node refused it for another reason. An unexpected success; the suite fails.
   - `harness_error`: the control failed or the mutated tx never reached the scripts. Proves nothing; the suite fails.
7. `harness.test.ts` runs an empty mutation and requires `accepted`, so the classifier is known not to be blind. It is not counted in the report.
8. A sample of cases (at least one per `Action`, plus every case behind A10, A11, A12 and A13) is replayed on preprod through the submit API with evaluation, per ADR section 10.

When an accepted mutation lands, the runner waits for the chain to index it before the next case builds.

## Report

`globalSetup` clears old fragments, each test calls `recordCase()` from `report.ts`, and teardown writes `tests/adversarial/report.json`:

```json
{
  "generated_at": "ISO time",
  "commit": "git sha",
  "cases": 0,
  "unexpected_successes": 0,
  "harness_errors": 0,
  "results": [
    { "id": "draw.child_payee_key_address", "action": "Draw", "mutation": "child output sent to operator key address",
      "threats": ["T3", "T16"], "network": "yaci", "outcome": "rejected_by_script", "tx_body_hash": "...", "detail": "script error text" }
  ]
}
```

`pnpm verify:all` reads this file, requires it to be from the current run and commit, and prints `adversarial: <cases> cases, <unexpected> unexpected successes`. It passes only with `cases > 0`, zero unexpected successes and zero harness errors.

## Coverage notes

- Depth and fan-out caps are not mutated on chain: a single-field mutation cannot raise a child's depth or a Draw's child count without also breaking the token-name and counter checks, so a rejection would not isolate the cap. They are covered by the contracts' Aiken property tests (`contracts/lib/cascade/tests/properties.ak`, `draw.ak`).
- `cascade_config` spend without a burn is `cancel.config_token_not_burned` (the config input is spent and its token is not burned).

## Mutations per Action

Index references follow ADR section 5. "Signer" means `extra_signatories`. Each bullet is one case, or one case per listed variant.

### Global checks (`global.test.ts`, T1, T2, T18, invariants 7 and 8)
- Node input carrying no Cascade token, two Cascade tokens, or a token whose name differs from `node_id`.
- Node output with an extra foreign token, or an extra Cascade token.
- A Cascade input not claimed by any action; one input claimed by two actions; claimed indices not strictly increasing.
- Two actions naming the same output index.
- Mint of one extra thread token, or one fewer burn, than the actions declare.
- Spend of a node without any logic withdrawal; mint without one; two logic withdrawals in one tx. (A non-zero amount must be accepted, ADR 1.5 F2; covered positively in `integration/f2-withdrawal-amount.test.ts`.)
- Publish with `UnregisterCredential`, `DelegateCredential` or any certificate other than `RegisterCredential`.

### FundRoot (`fund-root.test.ts`)
- No arbiters and `arbiter_threshold` 0 while Native leaves are allowed (ADR 1.5 F5).
- Seed not spent; root token name not `blake2b_224(seed ++ be16(index))`.
- Root datum: `parent_id` Some, `depth` 1, `committed` non-zero, `children_open` non-zero, `state` Submitted, `frozen` True, `result_hash` Some, acceptance not `BuyerAccept(config.buyer)`, deadlines out of order.
- Root value: budget one unit short, structural lovelace one short.
- Config: wrong `tree_id`, `channel_script_hash` not the parameter, `plan_root` 31 bytes, bps value 10001, arbiter threshold 0 with arbiters or above their count, `buyer_refund` a script address, config output with extra lovelace or at the wrong script.
- Not signed by `config.buyer`.

### TopUp (`top-up.test.ts`)
- `amount` 0 or negative; output budget not `budget + amount`; any other datum field changed; node not root; state not Funded; not signed by the buyer.

### Draw (`draw.test.ts`, `draw-masumi.test.ts`, `draw-metered.test.ts`; A10, A11, A12, A13)
- Child output at the operator's key address (A10), or any Draw output at a key address.
- Leaf not in `plan_root`: forged proof step, flipped `sibling_on_left`, leaf with a different `spec_hash` (A11).
- `leaf.parent_spec_hash` not the parent's `spec_hash`; `leaf.kind` differs from `child.kind`; kind not in `allowed_leaf_kinds`.
- `child.budget` above `leaf.max_budget`; `child.fee` above `leaf.max_fee`; `fee > budget`; share above `max_child_share_bps`.
- Totals: `sum(budget) + parent.fee` one unit above `budget - committed`.
- `child.dispute_until + min_safety_margin` one ms after `parent.submit_by` (A12); `submit_by > refund_after`; challenge window below `min_challenge_window`; `challenge_until >= dispute_until`.
- Depth above `max_depth`; `children_open + n` above `max_fanout`; empty children list.
- Child name not derived from `next_child + i`; native child token not minted.
- Parent output: `committed`, `children_open`, `next_child` or `structural` off by one.
- Signed by someone other than `parent.operator`; validity upper bound after `parent.submit_by` or infinite.
- Tree frozen: root input or `root_ref` with `frozen = True` (A13); `root_ref` pointing at a non-root UTxO.
- Masumi child: external output to a script other than `config.masumi_script_hash`, value off by one, each of the 19 `vested_pay` fields mutated, `collateral_return_lovelace` of 1,435,229; receipt `external_ref` wrong.
- Metered child: channel output to a script other than `channel_script_hash`, channel datum `authority`, `tree_id`, `node_id` or `deposit` mutated.
- Acceptance keys: `ParentAccept.key` not the parent operator, `BuyerAccept.key` not the buyer, `k` 0 or above `len(keys)`.

### Submit (`submit.test.ts`)
- `children_open` 1; validity upper bound after `submit_by` or infinite; `result_hash` 31 bytes; state not Funded; not signed by the operator; output changes any field besides `result_hash` and `state`.

### Accept (`accept.test.ts`)
- `ParentAccept` without the parent key; `VerifierQuorum` with k-1 signatures, a duplicate key, a key outside the list; `BuyerAccept` without the buyer; `AutoAfterWindow` or any rule by time with lower bound at `challenge_until` (not after); state not Submitted; output changes more than `state`.

### Challenge (`challenge.test.ts`)
- Challenger neither buyer nor parent operator; `parent_ref` with another operator; stranger at the root.
- Validity upper bound after `challenge_until`; state not Submitted (second challenge).
- Bond below `config.challenge_bond`; bond to a key address or another script; each `BondDatum` field mutated; challenger not signing.

### Escalate (`escalate.test.ts`)
- Not signed by the node operator; state not Challenged; after `dispute_until`; output changes more than `state`.

### Resolve (`resolve.test.ts`)
- Arbiter signatures t-1; verifier quorum on a Disputed node; quorum when acceptance is not `VerifierQuorum`; arbiters on a Funded or Submitted node.
- `split.worker + split.parent` not equal to `budget`; payee output off by one; parent output fields off by one; node token not burned.
- After `dispute_until`: split with `worker > 0`, or any bond ruling present.
- Bond ruling on a bond with another `authority` or `node_id`; `ReturnBond` paid to someone other than `owner_address`; `SlashBond` shares not `floor(v * slash_wronged_bps / 10000)`; wronged side wrong.

### Refund (`refund.test.ts`)
- Lower bound at or before `refund_after`; `children_open` 1; kind not Native; state not Funded.
- `ParentNode`: parent gains one unit less than the child value; parent counters off by one; child token not burned.
- `RootExit`: refund output not at `buyer_refund`, one unit short; config token not burned.

### SettleChild (`settle-child.test.ts`)
- Child state Funded, or Submitted before `challenge_until`; child `children_open` 1; parent state not Funded.
- Payee output fee off by one or at another address; `payee_lovelace` above `child.structural`.
- Parent `budget`, `committed`, `children_open` or `structural` off by one; child token not burned; one payee output shared by two settlements.

### CloseReceipt (`close-receipt.test.ts`)
- Metered receipt closed by its operator alone before the channel `timeout` (ADR 1.5 F4).
- Not signed by the receipt operator and before its `dispute_until`; parent counters off by one; metered `channel_in` unclaimed or its remaining deposit not returned to the parent; receipt token not burned.

### CloseRoot (`close-root.test.ts`)
- Protocol-fee output without `protocol_lovelace`, or `protocol_lovelace` above the cap (ADR 1.5 F3).
- Root not Accepted (or Submitted before `challenge_until`); not buyer-signed before `challenge_until`; payee output off by one; protocol fee not `floor((budget - fee) * bps / 10000)`; refund output short or not at `buyer_refund`; either token not burned.

### Cancel (`cancel.test.ts`)
- `committed` non-zero; state not Funded; not buyer-signed; refund short or elsewhere; a token not burned.

### Freeze and Unfreeze (`freeze.test.ts`)
- Not buyer-signed; node not the root; output changes more than `frozen`; value moved.

### Scripts outside `cascade_node` (`config.test.ts`, `bond.test.ts`, `channel.test.ts`)
- Config UTxO spent without burning its token.
- Bond spent by a logic withdrawal with a fake `node_hash` and no mint or burn under the node policy (`bond.test.ts`, ADR 1.3 finding).
- Bond spent with no node-policy mint or burn and before `release_after`; owner reclaim not signed by `owner`.
- Channel `Redeem` with a signature over another amount or channel tag, amount below `redeemed`, after `timeout`, paying more than `amount - redeemed`, continuing output with a changed datum field; close without the authority withdrawal.
