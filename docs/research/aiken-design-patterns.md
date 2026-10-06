# Anastasia-Labs/aiken-design-patterns: digest

## Pins

| Item | Pin |
|---|---|
| Latest tag | **`v1.9.0`**, commit `0594253ccc9c4f12e986c90105376b34f9ab1270` (2026-09-30, "Bump Aiken") |
| Its `aiken.toml` | `compiler = "v1.1.24"`, `plutus = "v3"`. Deps: `aiken-lang/stdlib v4.0.0`, `aiken-lang/fuzz v3.0.0`, `keyan-m/aiken-scott-utils v1.5.0` |
| Previous | `v1.8.0` (`dab05940…`, 2026-08-18, compiler 1.1.23). Its changes: ref scripts are disallowed on linked-list elements, and parameter validation was added. |
| Verified | Added to the scratch project `$SCRATCH/research-tooling/probe` next to stdlib v4 and fuzz v3. `aiken check` gives 209 checks, 0 errors; that count includes the library's own tests. `aiken build` is clean. The probe validator imports `stake_validator`, `tx_level_minter` and `validity_range_normalization` and runs them. |

## Adding it

```bash
aiken add anastasia-labs/aiken-design-patterns --version v1.9.0
aiken add keyan-m/aiken-scott-utils --version v1.5.0   # REQUIRED — see below
```

**Gotcha, verified:** `aiken add` does not pull transitive dependencies. Without `keyan-m/aiken-scott-utils` the build fails:

> `unknown module: 'aiken_scott_utils/types'` (from `aiken-design-patterns/lib/aiken-design-patterns/utils.ak`)

The PRD's one-liner `aiken add anastasia-labs/aiken-design-patterns` is therefore incomplete. Add scott-utils too.

The `aiken.toml` block is in [aiken.md](aiken.md). The README's own snippet still says `--version v1.8.0`; that one is stale.

Import paths: file names use dashes and module paths use underscores.

```aiken
use aiken_design_patterns/stake_validator
use aiken_design_patterns/multi_utxo_indexer
use aiken_design_patterns/singular_utxo_indexer
use aiken_design_patterns/tx_level_minter
use aiken_design_patterns/validity_range_normalization
use aiken_design_patterns/merkelized_validator
use aiken_design_patterns/parameter_validation          // + /advanced
use aiken_design_patterns/linked_list                   // + /advanced, /nested
```

## Stake validator (withdraw-zero), `stake_validator`

```aiken
pub fn validate_withdraw(
  withdraw_script_hash: ScriptHash,
  redeemers: Pairs<ScriptPurpose, Redeemer>,
  withdraw_redeemer_index: Int,                 // positional index into tx.redeemers
  withdraw_redeemer_validator: fn(Redeemer) -> Bool,
) -> Bool

pub fn validate_withdraw_with_amount(
  withdraw_script_hash: ScriptHash,
  redeemers: Pairs<ScriptPurpose, Redeemer>,
  withdraw_redeemer_index: Int,
  withdrawals: Pairs<Credential, Lovelace>,
  withdrawal_index: Int,                        // positional index into tx.withdrawals
  withdraw_redeemer_validator: fn(Redeemer, Lovelace) -> Bool,
) -> Bool

pub fn validate_withdraw_minimal(
  withdraw_script_hash: ScriptHash,
  withdrawals: Pairs<Credential, Lovelace>,
  withdrawal_index: Int,
) -> Bool
```

How the index-based checks work:

- `validate_withdraw` does `expect Some(pair) = list.at(redeemers, idx)`, then `expect Withdraw(Script(hash)) == pair.1st`.
- `validate_withdraw_with_amount` also checks that `withdrawals[withdrawal_index].1st == Script(hash)`.
- The indices come in the **spend redeemer**, so off-chain code must compute them. Two orderings matter:
  - stdlib v4 orders redeemers `Spend < Mint < Publish < Withdraw`.
  - Withdrawals are sorted with `Script` credentials first.

**Neither helper checks that the withdrawal amount is 0.** That check is ours; the upstream example does `withdraw_amount == 0`.

Upstream example usage:

```aiken
let redeemer_data, withdraw_amount <- stake_validator.validate_withdraw_with_amount(
  withdraw_script_hash: withdraw_script_hash, redeemers: redeemers,
  withdraw_redeemer_index: redeemer.withdraw_redeemer_index,
  withdrawals: withdrawals, withdrawal_index: redeemer.withdrawal_index,
)
expect out_ref_passed_to_staking_script: OutputReference = redeemer_data
expect out_ref_passed_to_staking_script == own_out_ref
withdraw_amount == 0
```

## UTxO indexers

### Multi (withdraw-coupled), `multi_utxo_indexer`

v1.9.0 has one-to-one variants only. **There is no multi one-to-many.**

```aiken
pub fn one_to_one_no_redeemer(
  indices: Pairs<Int, Int>,                 // (input_idx, output_idx), both strictly ascending
  spending_script_hash: ScriptHash,
  inputs: List<Input>, outputs: List<Output>,
  validation_logic: fn(Int, Input, Int, Output) -> Bool,
) -> Bool

pub fn one_to_one_with_redeemer(
  indices: Pairs<Int, Int>,
  spending_script_hash: ScriptHash, stake_script_hash: ScriptHash,
  inputs: List<Input>, outputs: List<Output>,
  redeemers: Pairs<ScriptPurpose, Redeemer>,
  spend_redeemer_coercer_and_stake_credential_extractor: fn(Data) -> (a, Credential),
  validation_logic: fn(Int, Input, a, Int, Output) -> Bool,
) -> Bool
```

How `one_to_one_no_redeemer` behaves:

- It walks **all** tx inputs.
- Every input at `Script(spending_script_hash)` must be listed in `indices`. Otherwise it fails with "More UTxOs of the script are spent than specified".
- Indices must be strictly ascending, which prevents double satisfaction by output reuse.
- It is meant to run inside the `withdraw` handler. The upstream example calls it from `withdraw` with `redeemer: Pairs<Int, Int>`, and from `spend` via `validate_withdraw_with_amount`.

### Singular (per-spend), `singular_utxo_indexer`

```aiken
pub fn one_to_one(input_index: Int, output_index: Int, own_ref: OutputReference,
  inputs: List<Input>, outputs: List<Output>, double_satisfaction_prevented: Bool,
  validation_logic: fn(Input, Output) -> Bool) -> Bool

pub fn one_to_many(input_index: Int, output_indices: List<Int>, own_ref: OutputReference,
  inputs: List<Input>, outputs: List<Output>, double_satisfaction_prevented: Bool,
  input_collective_outputs_validator: fn(Input, List<Output>) -> Bool,
  input_output_validator: fn(Input, Int, Output) -> Bool) -> Bool
```

- `double_satisfaction_prevented` is only a reminder flag, `expect`-ed True. **You must implement double-satisfaction protection yourself.**
- `one_to_many` requires ascending output indices.

## Tx-level minter, `tx_level_minter`

```aiken
pub fn validate_mint(
  mint_script_hash: PolicyId, mint: Assets,
  redeemers: Pairs<ScriptPurpose, Redeemer>, mint_redeemer_index: Int,
  mint_validator: fn(Redeemer, Dict<AssetName, Int>) -> Bool,
) -> Bool
pub fn validate_mint_minimal(mint_script_hash: PolicyId, mint: Assets) -> Bool   // any mint/burn under policy
```

The spend handler only proves that the mint handler runs; the heavy logic lives in `mint` and executes once per tx. In the example, spend and mint are in one multivalidator, so `own_hash` serves as the policy id. This matches our `cascade_node` layout.

## Validity range normalization, `validity_range_normalization`

```aiken
pub type NormalizedTimeRange {
  ClosedRange { lower: Int, upper: Int }   // both inclusive
  FromNegInf { upper: Int }
  ToPosInf { lower: Int }
  Always
  InvalidRange
}
pub fn normalize_time_range(validity_range: ValidityRange) -> NormalizedTimeRange
```

- Exclusive bounds are converted to inclusive ones by ±1.
- `lower >= upper` becomes `InvalidRange`.
- Verified: `[10, 20)` normalizes to `ClosedRange { lower: 10, upper: 19 }` (test `validity_normalization`).
- Units are POSIX ms.
- Lucid's `validFrom`/`validTo` are slot-converted, so bounds snap to slot boundaries (1 s on preprod and on Yaci by default).

## Merkelized validator, `merkelized_validator`

```aiken
pub type ComputationRedeemer<a, b> { input_arg: a, result: b }
pub type ValidationRedeemer<a> { input_arg: a }

pub fn delegated_compute(function_input: a, staking_validator: ScriptHash,
  redeemers: Pairs<ScriptPurpose, Redeemer>, redeemer_index: Int,
  input_data_coercer: fn(Data) -> a, output_data_coercer: fn(Data) -> b) -> b
pub fn delegated_validation(function_input: a, staking_validator: ScriptHash,
  redeemers: Pairs<ScriptPurpose, Redeemer>, redeemer_index: Int,
  input_data_coercer: fn(Data) -> a) -> Bool
pub fn computation_withdrawal_wrapper(redeemer: ComputationRedeemer<a, b>, function: fn(a) -> b) -> Bool
pub fn validation_withdrawal_wrapper(redeemer: ValidationRedeemer<a>, validation: fn(a) -> Bool) -> Bool
```

- This splits logic into separate withdraw-zero scripts to stay under size limits.
- The library notes a 200 KiB (204800 B) total reference-script cap per tx, with exponential ref-script fees. Ogmios on Yaci and preprod reports `minFeeReferenceScripts {base: 15, range: 25600, multiplier: 1.2}` and `maxReferenceScriptsSize 204800`.
- Each extra staking script also needs **its own stake registration** before it can be withdrawn from.

## Also in v1.9.0 (not in the PRD list)

- `parameter_validation`: `apply_param`, `apply_prehashed_param`, `wrapper` and friends. These verify on-chain that a script hash is a given parameterized instance.
- `linked_list` (+ `advanced`, `nested`).
- `utils`, `@hidden`, `get_withdraw_scripts_redeemer_at`: fine to use but undocumented.

## Relevance to Cascade

- `cascade_node.withdraw` = `stake_validator` coordinator + `multi_utxo_indexer.one_to_one_no_redeemer` for child/parent pairing.
- `cascade_node.spend` = `stake_validator.validate_withdraw` (or `_minimal`).
- `mint` = the tx-level minter for thread tokens.
