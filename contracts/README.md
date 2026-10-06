# Cascade contracts

Aiken validators for Cascade escrow trees. The interface is frozen in
`docs/adr/0001-onchain-design.md`; this package implements it.

- Aiken `v1.1.24`, Plutus V3
- `aiken-lang/stdlib` v4.0.0, `aiken-lang/fuzz` v3.0.0
- `anastasia-labs/aiken-design-patterns` v1.9.0 (validity range normalisation),
  which needs `keyan-m/aiken-scott-utils` v1.5.0 listed explicitly because Aiken
  does not resolve transitive dependencies

## Run

```sh
export PATH="$HOME/.aiken/bin:$PATH"
aiken check                          # all unit, property and vector tests
aiken check -m "cascade/tests/draw"  # one module
scripts/build.sh                     # plutus.json, no traces, deployment tag applied
python3 scripts/budget.py            # build, size gate (15,500 bytes), BUDGET.md
python3 scripts/budget.py --check    # size gate only; exits 1 if a script is too big
python3 scripts/gen_vectors.py       # regenerate tests/vectors.ak from packages/shared
                                     # (warns and leaves out sections whose shape predates ADR 1.6)
```

`plutus.json` is committed and built by `scripts/build.sh`: traces silent, and
the tag in `deployment-tag` applied to the three leaf validators so each
deployment has its own hashes (ADR 0001, Hackathon redeploy). Plain
`aiken build` leaves the leaves parameterised and the deploy script rejects it. `BUDGET.md` holds
script sizes and execution units per action; regenerate it, never edit it.

## Scripts

| Validator | Parameters | Handlers | Role |
| --- | --- | --- | --- |
| `cascade_node` | config, bond, channel, logic core, logic draw, logic ext hashes | `mint`, `spend` | Thread-token policy and node address. Passes only when exactly one of the three logic scripts is withdrawn from with amount 0 and its redeemer names this script's hash. |
| `cascade_logic_core` | config, bond, channel hashes | `withdraw`, `publish` | FundRoot, TopUp, Submit, Accept, Challenge, Escalate, Refund, SettleChild, CloseRoot, Cancel, Freeze, Unfreeze |
| `cascade_logic_draw` | config, bond, channel hashes | `withdraw`, `publish` | Draw of every child kind: native, AddressPayment, Masumi and Metered receipts |
| `cascade_logic_ext` | config, bond, channel hashes | `withdraw`, `publish` | Resolve, CloseReceipt (ADR 1.4) |
| `cascade_config` | deployment tag, applied at build | `spend` | Tree Config UTxO; spendable only when the tx burns its tokens |
| `cascade_bond` | deployment tag, applied at build | `spend` | Bonds; moved when the authority's policy mints or burns, or reclaimed by the owner after `release_after` |
| `cascade_channel` | deployment tag, applied at build | `spend` | Metered voucher channel: provider `Redeem` with the payer's Ed25519 voucher before `timeout`; `Close` only when the authority's policy mints or burns |

Every other handler fails (`else(_) { fail }`). `cascade_node`'s config,
bond and channel parameters are unused in its code (blueprint titles
`_config_hash`, `_bond_hash`, `_channel_hash`) but still bind the node hash to
one deployment set, as ADR 1.3 lists them. Both logic `publish` handlers
accept only `RegisterCredential`.

## Modules

| Module | Contents |
| --- | --- |
| `lib/cascade/types.ak` | Every ADR type, constructor and field in frozen order, plus `LogicRedeemer` (ADR 1.3) |
| `lib/cascade/ids.ak` | Root, child and config token names; `be16`, `be32`, `be64` |
| `lib/cascade/merkle.ak` | Plan leaf bytes, leaf hash (`0x00` prefix), node hash (`0x01` prefix), proof fold |
| `lib/cascade/value.ak` | `expected_value`, asset helpers (lovelace is policy `#""`, name `#""`) |
| `lib/cascade/time.ak` | "Before T" and "after T" over normalised validity ranges |
| `lib/cascade/node.ak` | All tree logic: per-action checks, input coverage, output uniqueness, mint exactness |
| `lib/cascade/channel.ak` | `ChannelDatum`, `ChannelRedeemer`, voucher tag and message (ADR 9) |
| `lib/cascade/masumi.ak` | Masumi `vested_pay` V2 datum, 19 fields (ADR 8) |
| `lib/cascade/fixtures.ak`, `scenarios.ak` | Test-only: a small tree, its plan, and one full mock transaction per action |
| `lib/cascade/tests/*.ak` | Positive, negative, global, property and vector tests |

## How a transaction is checked

1. Each node input runs `cascade_node` `spend`; minting runs `mint`. Both only
   check the single zero logic withdrawal and that its redeemer's `node_hash`
   is the node's own hash.
2. The logic script's `withdraw` runs once. Each action checks its inputs and
   outputs by index and returns the input indices it claims, the output
   indices it names and its token deltas.
3. Global checks: the sorted claimed inputs equal every governed input (node
   and config inputs, and bond or channel inputs naming the node); named
   outputs are all distinct; Cascade tokens minted equal the declared deltas,
   each by exactly one.
4. Continuing and new node outputs must match the expected datum and
   `expected_value` exactly, at the parent's exact address, with no reference
   script.

## Tests

| Suite | What it covers |
| --- | --- |
| `tests/positive.ak` | Every honest action passes and conserves value |
| `tests/fund_root.ak`, `draw.ak`, `draw_payment.ak`, `lifecycle.ak`, `resolve.ak`, `settlement.ak` | One mutated field per negative test, per action |
| `tests/global.ak` | Unclaimed inputs, shared outputs, stray mints, zero withdrawal, logic action sets |
| `tests/properties.ak` | PRD 7.6 invariants 1 to 8 as fuzz properties |
| `tests/audit.ak` | Regression tests for audit findings F1 to F5, and a depth-3 lifecycle property ending in CloseRoot with exact conservation |
| `tests/evaluator.ak` | Regressions for evaluator findings E1 to E14 (including the cross-script double satisfaction) and per-redeemer property tests |
| `tests/vectors.ak` | Generated: token names, leaves, Merkle proofs and datum CBOR shared with TypeScript |
| `validators/*.ak` | Handler tests: node shell, logic `publish`, bond and config spend, `budget_*` measurements |

## Accounting (ADR 1.5)

A node's `budget` never decreases (only TopUp raises it, at the root).
`committed` is what is drawn into open children and returns to 0 when
`children_open` does. `spent` is what has left the tree from this node:
AddressPayment amounts, settled children's fees and `spent`, Resolve worker
shares, Masumi receipt budgets and redeemed channel amounts. A native node
holds exactly `budget - committed - spent` of the tree asset, plus
`structural` lovelace and its token. Closing child `d` into parent `p`:
`p.committed -= d.budget` and `p.spent += d.spent + paid_out`.

## Building a transaction (shape that passes)

- One logic withdrawal per transaction: `cascade_logic_core`, `_draw` or
  `_ext`, any amount (the ledger forces the full reward balance), with
  redeemer `LogicRedeemer { node_hash, actions }`. Node inputs use any spend
  redeemer.
- Every node, config, bond and channel input that names the node must be
  claimed by exactly one action; every output index an action names is used
  once. Payments of zero value are not named.
- Receipt nodes carry `external_ref = None` (ADR 8 amended): a datum cannot
  contain its own transaction id. A Metered channel is found by its token
  `#"6b" ++ receipt_id`; a Masumi lock is tracked off chain.
- Mint and burn exactly the thread tokens the actions declare, one each.
- Every payout to a key address (payee, protocol, refund, bond return and
  slash shares, AddressPayment) has no datum and no reference script
  (ADR 1.6, E1), so it can never double as an output another script tags
  (Masumi's `WithdrawRefund` tags its refund with an inline datum).
- Plan leaves carry `acceptance_hash = sha2_256(acceptance_bytes)` of the
  child's acceptance rule (ADR 1.6, E7): ParentAccept `00`, VerifierQuorum
  `01 ++ be8(k) ++ keys`, AutoAfterWindow `02`, BuyerAccept `03`.

## Deviations and clarifications

These keep the frozen types and encodings; each is reported to the lead.

- **Bond authority is the `cascade_node` hash, and bond path (a) requires the
  tx to mint or burn under that policy.** ADR 1.3 names the logic hash as
  authority with a withdrawal check. That lets a logic run with a forged
  `node_hash` rule on real bonds without `cascade_node` ever running (see
  `bond_rejects_logic_withdrawal_alone`). Resolve always burns the node token,
  so the node policy runs and admits only a logic run for its own hash.
- **TopUp and SettleChild find the config by its token** in the reference
  inputs, because they need the tree asset and their redeemers carry no config
  index.
- **Refund raises the parent's `structural` by the child's.** ADR 5.1 lists
  only the counters, but the parent receives the child's whole value, so its
  datum must record the lovelace to keep `expected_value` exact.
- **Resolve at the root reads the config from `config_in`** and requires
  `config_ref == config_in`, since Conway forbids spending and referencing one
  UTxO.
- **Payee lovelace is capped at 2,000,000** (`max_payee_lovelace`) on
  SettleChild, Resolve, CloseRoot (payee and protocol output) and
  AddressPayment extra lovelace.
- **Evaluator fixes (ADR 1.6)**: NoDatum payouts (E1);
  `min_dispute_window` config field 20, positive, enforced for every node
  (E6); `acceptance_hash` plan leaf field 6 (E7); Masumi
  `seller_return_address` a key address when set (E8); arbiter and protocol
  fee addresses are key addresses and a channel `timeout` is at least the
  receipt's `submit_by` (E14). E12 (no payee lovelace on the Resolve deadline
  exit) holds except when a Disputed node's fee is paid in a native asset:
  that output needs min-UTxO lovelace, without which a Disputed node in a
  token tree could never close.
- **Audit fixes (ADR 1.5)**: withdrawals are checked for presence, not
  amount (F2); CloseRoot's protocol output carries `protocol_lovelace` (F3);
  a Metered CloseReceipt needs the provider's signature or the channel
  `timeout` to have passed (F4); a tree allowing Native leaves needs
  `arbiter_threshold >= 1`, and the Resolve deadline exit pays the worker its
  `fee` when Disputed and nothing when only Challenged (F5). The protocol fee
  is `floor((budget - spent - fee) * bps / 10000)`, the old formula under the
  new accounting. Otherwise a cranker could route a tree's
  structural reserve to a payee.
- **`child.refund_after + min_safety_margin <= parent.submit_by`** is checked
  on Draw beside the ADR's `dispute_until` rule, because invariant 4 covers a
  child's last deadline.
- **AddressPayment** also respects `allowed_leaf_kinds` and the child share
  cap.
- **Claimed inputs and named outputs are compared after sorting**, which
  accepts every transaction the ADR's "collected in order, strictly
  increasing" rule accepts, and also batches whose inputs interleave (input
  order is fixed by the ledger, not the builder). Uniqueness is unchanged.
- **Masumi receipts** (ADR 8): the lock's `buyer` is the parent operator's
  key (it requests refunds), `buyer_return_address` is `Some(buyer_refund)`,
  `seller` is the receipt's `payee`, the lock address is the enterprise
  address of `masumi_script_hash` (no stake part), value is exactly the
  receipt budget plus `external_lovelace`, and Masumi's times nest as
  `pay_by <= submit_result <= unlock <= external_dispute_unlock <=
  receipt.dispute_until`. CloseReceipt: operator signs, or anyone after the
  receipt's `dispute_until`.
- **Metered receipts** (ADR 9, 1.4): Draw writes a channel whose datum names
  the node as authority, the receipt as `node_id`, the receipt's payee as
  provider, the tree asset, `deposit = budget`, `redeemed = 0` and
  `timeout <= receipt.dispute_until`, holding the budget, `external_lovelace`
  and the channel token `#"6b" ++ receipt_id` (minted in the Draw).
  CloseReceipt needs that token, burns it and returns the unredeemed deposit
  and the channel lovelace into the parent.
- **Channel redeemer**: `ChannelRedeemer = Redeem { amount, signature, out }
  | Close` (constructors 0, 1). A channel input naming the node is governed
  whichever path it is spent by, so a provider Redeem cannot share a
  transaction with a Cascade action.

`aiken-design-patterns` compiles cleanly with this stdlib; Cascade uses its
validity range normalisation. The stake validator, indexer and minting
helpers are not used: the zero-withdrawal check, the index pairing and the
mint check are a few lines each in `node.ak` and fit the ADR's exact rules.
