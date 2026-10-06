# Aiken v1.1.24 + stdlib v4.0.0: digest

## Sources and pins

| Item | Pin | Verified |
|---|---|---|
| Aiken compiler | `v1.1.24+bacbeb3` (tag `v1.1.24`, commit `bacbeb35fbc9f1db93cd2e1e93fb1d93053acb4a`, released 2026-09-26) | `aiken --version` locally |
| aiken-lang/stdlib | **`v4.0.0`**, commit `dfdf5ffc4fa28896c075f06faf2bf6709a11cc5e` (2026-09-26). Its `aiken.toml` says `compiler = "v1.1.24"`, `plutus = "v3"`. `aiken new` on 1.1.24 scaffolds `v4.0.0`. | fetched into `build/packages`, compiled |
| aiken-lang/fuzz | **`v3.0.0`**, commit `96b6ecea3669e5c71dfda40f5669872b1d9af11d` (2026-09-26). It requires stdlib v4 because of the `Value`→`Assets` rename. | compiled, property tests ran |
| Previous stdlib | `v3.1.0` (`7d5cee54…`, 2026-04-24) is **not** used with 1.1.24. aiken-design-patterns v1.9.0 needs v4. | — |
| Scratch project | `$SCRATCH/research-tooling/probe` (`cascade/probe`). `aiken check` gives 12/12 of our tests passing. `aiken build` is clean with `-D` (deny warnings). | yes |

`$SCRATCH` = `/private/tmp/claude-501/-Users-adwaitkeshari-Desktop-cardano/9771299c-3776-4b87-b459-83688f92c770/scratchpad`

### stdlib v4.0.0 breaking changes you will hit

- **`Value` was renamed to `Assets`** in `cardano/assets`. `Output.value` and `Transaction.mint` are now `Assets`. The new builtin UPLC `Value` type lives in the separate `cardano/value` module. Aiken 1.1.24 adds `Value` literals and builtins. Keep using `cardano/assets` for script-context values.
- **`cardano/transaction/script_purpose.compare` now follows ledger order: `Spend < Mint < Publish < Withdraw < Vote < Propose`.** `tx.redeemers` is sorted in that order. This matters when off-chain code computes a *redeemer index* for withdraw-zero helpers (`stake_validator.validate_withdraw(…, withdraw_redeemer_index, …)`): the withdraw redeemer comes after all spend, mint and publish redeemers.
- A new type alias `Tokens = Dict<AssetName, Int>`. `from_data` / `expect_from_data` were added to `list` and `pairs`.

## aiken.toml (working, verbatim)

```toml
name = "cascade/probe"
version = "0.0.0"
compiler = "v1.1.24"
plutus = "v3"
license = "Apache-2.0"
description = "Aiken contracts for project 'cascade/probe'"

[repository]
user = "cascade"
project = "probe"
platform = "github"

[[dependencies]]
name = "aiken-lang/stdlib"
version = "v4.0.0"
source = "github"

[[dependencies]]
name = "aiken-lang/fuzz"
version = "v3.0.0"
source = "github"

[[dependencies]]
name = "anastasia-labs/aiken-design-patterns"
version = "v1.9.0"
source = "github"

# REQUIRED: aiken does NOT resolve transitive deps; design-patterns imports aiken_scott_utils
[[dependencies]]
name = "keyan-m/aiken-scott-utils"
version = "v1.5.0"
source = "github"

[config]
```

Added with `aiken add aiken-lang/fuzz --version v3.0.0` etc. Without the scott-utils entry, `aiken check` fails with `unknown module: 'aiken_scott_utils/types'`. `aiken.lock` pins the versions. Commit it.

## Plutus V3 validator syntax (compiled and tested)

This is a multivalidator: one script hash covers `mint`, `spend`, `withdraw` and `publish`. Every handler in the validator shares that one hash. The blueprint lists `probe.cascade_node.{mint,spend,withdraw,publish,else}` with the same `hash`.

```aiken
use aiken/builtin
use aiken/cbor
use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash, blake2b_224, blake2b_256, sha2_256}
use aiken/fuzz
use aiken/interval.{Finite, IntervalBound}
use aiken/primitive/bytearray
use aiken_design_patterns/stake_validator
use aiken_design_patterns/tx_level_minter
use aiken_design_patterns/validity_range_normalization.{ClosedRange, normalize_time_range}
use cardano/address.{Address, Credential, Script}
use cardano/assets.{PolicyId}
use cardano/certificate.{Certificate, RegisterCredential}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction}

pub type NodeDatum { owner: VerificationKeyHash, budget: Int, deadline: Int }
pub type SpendRedeemer { withdraw_redeemer_index: Int }
pub type MintRedeemer { MintNode { seed: OutputReference }  BurnNode }
pub type SettleRedeemer { Settle { count: Int } }

validator cascade_node(version: Int) {           // parameters come first; apply with `aiken blueprint apply`
  mint(redeemer: MintRedeemer, policy_id: PolicyId, tx: Transaction) {
    let tokens = assets.tokens(tx.mint, policy_id)          // Dict<AssetName, Int>
    when redeemer is {
      MintNode { seed } -> {
        let spent_seed = list.any(tx.inputs, fn(i) { i.output_reference == seed })
        and { version >= 0, spent_seed, dict.to_pairs(tokens) == [Pair(thread_token_name(seed), 1)] }
      }
      BurnNode -> dict.foldl(tokens, True, fn(_k, q, acc) { acc && q < 0 })
    }
  }

  spend(datum: Option<NodeDatum>, redeemer: SpendRedeemer, own_ref: OutputReference, tx: Transaction) {
    expect Some(NodeDatum { owner, .. }) = datum            // datum is ALWAYS Option<T> in V3
    expect Some(own_input) = transaction.find_input(tx.inputs, own_ref)
    expect Script(own_hash) = own_input.output.address.payment_credential
    expect owner != #""
    stake_validator.validate_withdraw(own_hash, tx.redeemers, redeemer.withdraw_redeemer_index,
      fn(r) { expect Settle { count }: SettleRedeemer = r  count > 0 })
  }

  withdraw(redeemer: SettleRedeemer, account: Credential, tx: Transaction) {
    expect Script(own_hash) = account
    let Settle { count } = redeemer
    let script_inputs = list.count(tx.inputs, fn(i) { i.output.address.payment_credential == Script(own_hash) })
    and {
      script_inputs == count,
      list.all(tx.withdrawals, fn(Pair(c, amt)) { c != Script(own_hash) || amt == 0 }),  // withdraw-zero
    }
  }

  publish(_redeemer: Data, certificate: Certificate, _tx: Transaction) {
    when certificate is {
      RegisterCredential { .. } -> True     // accept ONLY stake registration (PRD T18)
      _ -> False
    }
  }

  else(_) { fail }                          // vote / propose / anything else
}

pub fn thread_token_name(seed: OutputReference) -> ByteArray {
  seed.transaction_id
    |> bytearray.concat(bytearray.from_int_big_endian(seed.output_index, 2))
    |> blake2b_256
    |> bytearray.take(28)
}

pub fn parse_inline_datum(output: Output) -> NodeDatum {
  expect InlineDatum(raw) = output.datum   // raw: Data
  expect d: NodeDatum = raw                // structural cast; fails the script on mismatch
  d
}
```

The formatted source is in `$SCRATCH/research-tooling/probe/validators/probe.ak`.

### Handler signatures (V3)

| Handler | Signature |
|---|---|
| `mint` | `mint(redeemer: R, policy_id: PolicyId, tx: Transaction)` |
| `spend` | `spend(datum: Option<D>, redeemer: R, own_ref: OutputReference, tx: Transaction)` |
| `withdraw` | `withdraw(redeemer: R, account: Credential, tx: Transaction)` |
| `publish` | `publish(redeemer: R, certificate: Certificate, tx: Transaction)` |
| `vote` / `propose` | exist, not used here |
| `else(ctx: ScriptContext)` | fallback for any purpose without a handler. `else(_) { fail }` rejects them. |

### `cardano/certificate.Certificate` constructors (stdlib v4)

- `RegisterCredential { credential: Credential, deposit: Never }`. **`deposit` is typed `Never`** and is always `None` on-chain, even when the tx sets it. To construct one in a test, write `RegisterCredential { credential: c, deposit: Never }`.
- `UnregisterCredential { credential, refund: Never }`
- `DelegateCredential { credential, delegate: Delegate }`
- `RegisterAndDelegateCredential { credential, delegate, deposit: Lovelace }`
- `RegisterDelegateRepresentative`, `UpdateDelegateRepresentative`, `UnregisterDelegateRepresentative`
- `RegisterStakePool`, `RetireStakePool`
- `AuthorizeConstitutionalCommitteeProxy`, `RetireFromConstitutionalCommittee`

To accept registration only, pattern-match `RegisterCredential { .. } -> True` and send everything else to `False`. The tests `publish_accepts_registration_only` and `publish_rejects_unregistration` (a `fail` test) both pass.

## Key stdlib names (v4.0.0, from source)

**`cardano/transaction`**

- `Transaction` fields: `inputs`, `reference_inputs`, `outputs`, `fee`, `mint: Assets`, `certificates`, `withdrawals: Pairs<Credential, Lovelace>`, `validity_range: ValidityRange`, `extra_signatories: List<VerificationKeyHash>`, `redeemers: Pairs<ScriptPurpose, Redeemer>`, `datums`, `id`, `votes`, `proposal_procedures`, `current_treasury_amount`, `treasury_donation`
- `Input { output_reference, output }`
- `OutputReference { transaction_id, output_index }`
- `Output { address, value: Assets, datum: Datum, reference_script: Option<ScriptHash> }`
- `Datum = NoDatum | DatumHash(DataHash) | InlineDatum(Data)`
- `ScriptPurpose = Mint(PolicyId) | Spend(OutputReference) | Withdraw(Credential) | Publish { at, certificate } | Vote(Voter) | Propose { at, proposal_procedure }`
- Helpers: `find_input(inputs, ref) -> Option<Input>`, `resolve_input`, `find_datum`, `find_script_outputs`, `placeholder` (an empty `Transaction` for tests)
- Ordering notes:
  - Withdrawals are ordered by credential, with `Script` credentials sorting before `VerificationKey` credentials.
  - Redeemers are ordered `Spend < Mint < Publish < Withdraw < Vote < Propose`.

**`cardano/assets`**

- Types: `Assets` (opaque), `PolicyId`, `AssetName`, `Lovelace`, `Tokens`
- Constants: `zero`, `ada_policy_id = ""`
- Construct: `from_lovelace(n)`, `from_asset(policy, name, qty)`, `add(self, policy, name, qty)`, `merge(a, b)`, `negate`, `difference`
- Read: `lovelace_of`, `quantity_of(self, policy, name)`, `tokens(self, policy) -> Dict<AssetName, Int>`, `policies(self) -> List<PolicyId>` (includes `""` when ADA is present), `without_lovelace`, `restricted_to(self, [policies])`
- Predicates: `has_nft`, `has_nft_strict`, `has_any_nft`, `match`, `contains`, `is_zero`
- Iterate and convert: `flatten`, `reduce`, `to_dict`, `to_pairs`, `to_value` / `from_value`
- Checked in test `value_helpers`: `policies(2 ADA + 1 tt) == ["", pid]`.

**`cardano/address`**

- `Credential = VerificationKey(VerificationKeyHash) | Script(ScriptHash)`
- `Address { payment_credential, stake_credential: Option<StakeCredential> }`
- `StakeCredential = Referenced<Credential>` (`Inline(c)` or `Pointer`)
- Constructors: `from_script(h)`, `from_verification_key(vkh)`, `with_delegation_key`, `with_delegation_script`

**`aiken/crypto`**

- Hashes: `blake2b_224`, `blake2b_256`, `sha2_256`, `sha3_256`, `keccak_256`, all `ByteArray -> Hash<alg, a>`
- Signatures: `verify_ed25519_signature(vk, msg, sig)`, `verify_ecdsa_signature`, `verify_schnorr_signature`
- Type aliases: `VerificationKeyHash`, `ScriptHash`, `DataHash`, `Signature`

**`aiken/interval`**

- `Interval { lower_bound: IntervalBound, upper_bound: IntervalBound }`
- `IntervalBound { bound_type: IntervalBoundType, is_inclusive: Bool }`
- `IntervalBoundType = NegativeInfinity | Finite(Int) | PositiveInfinity`
- Functions: `after`, `before`, `between`, `entirely_*`, `contains`, `is_entirely_after`, `is_entirely_before`, `hull`, `intersection`, `includes`
- On-chain times are POSIX **milliseconds**.

**`aiken/collection/list`**

`any all at count find find_map has head last length filter filter_map map indexed_map foldl foldl2 foldr foldr2 indexed_foldr reduce sort unique partition span take drop slice concat difference zip unzip push reverse delete`, each with an `expect_*` variant (for example `expect_at`, `expect_find`, `expect_head`).

**`aiken/collection/dict`**

`from_pairs from_ascending_pairs from_value singleton get get_or_else has_key keys values size is_empty insert insert_with delete pop union union_with filter map foldl foldr to_pairs find` plus `expect_*`.

**`aiken/collection/pairs`**

`get_first get_all find_first has_key keys values insert_by_ascending_key foldl foldr` and others.

**CBOR**

- `aiken/cbor.serialise(self: Data) -> ByteArray` is identical to `aiken/builtin.serialise_data` (tested).
- Also `cbor.deserialise(bytes) -> Option<Data>` and `cbor.diagnostic(data) -> String`.
- Verified: `cbor.serialise(NodeDatum{owner, 1, 2}) == #"d8799f581c…0102ff"`. That is byte-identical to Lucid Evolution `Data.to(…)`, which also uses an indefinite-length list inside constr (see lucid-evolution.md). On-chain and off-chain hashes of datums/plans therefore agree.

**ByteArray (`aiken/primitive/bytearray`)**

- `concat(left, right)`
- `from_int_big_endian(n, size)`: tested, `from_int_big_endian(1, 2) == #"0001"`
- `from_int_little_endian`, `to_int_big_endian`
- `take`, `drop`, `slice`, `length`, `compare`, `starts_with`, `to_hex`, `from_string`, `replicate` (new in v4)

### `expect` cast of inline datum

`expect InlineDatum(raw) = output.datum` followed by `expect d: MyType = raw` does a structural validation of the `Data` against the type (constructor index and field shapes). A mismatch aborts the script. In `spend`, the datum arrives already as `Option<T>`; a malformed datum makes the handler fail before the body runs. Test `datum_cast_bad` (an `InlineDatum(42)` cast to `NodeDatum`) fails as expected.

## Tests

- Unit test: `test name() { bool_expr }`.
- Expected failure: `test name() fail { … }`.
- Property test: `test name(x via fuzzer) { … }`.

```aiken
test prop_token_name_is_28_bytes(
  x via fuzz.tuple(fuzz.bytearray_fixed(32), fuzz.int_between(0, 65535)),
) {
  let (txid, ix) = x
  bytearray.length(thread_token_name(OutputReference(txid, ix))) == 28
}

test prop_budget_never_negative(n via fuzz.int_at_least(0)) {
  NodeDatum { owner: owner_key, budget: n, deadline: 0 }.budget >= 0
}
```

Handlers are callable from tests as `validator_name.handler(params..., args...)`:

```aiken
test withdraw_zero_ok() {
  let h = #"22222222222222222222222222222222222222222222222222222222"
  let tx = Transaction { ..transaction.placeholder, withdrawals: [Pair(Script(h), 0)] }
  cascade_node.withdraw(0, Settle { count: 0 }, Script(h), tx)   // 0 = the `version` param
}
```

### `aiken/fuzz` v3.0.0

Generic fuzzers: `int int_between int_at_least int_at_most bool byte bytearray bytearray_between bytearray_fixed list list_between list_at_least list_at_most set* tuple..tuple9 option one_of pick such_that map..map9 and_then both either* constant sublist subset label label_when label_if data`.

Module `cardano/fuzz` (import `use cardano/fuzz as cardano_fuzz`):

`address address_with credential script script_hash verification_key verification_key_hash stake_credential inline lovelace assets assets_with asset_name policy_id certificate register_credential(_with) unregister_credential delegate_* datum inline_datum no_datum input input_with output output_with output_reference transaction_id withdrawals withdrawals_with reference_script`

In v3, `value` was renamed to `assets`. Combinator style is `let x <- and_then(f)`, ending with `fuzz.constant(...)`.

## Running and measuring

| Command | Effect |
|---|---|
| `aiken check` | Type-checks and runs all tests, **including every dependency's tests**: 209 checks here. To limit to our module, use `-m "probe.{..}"`. `-m probe` matches **nothing** and prints a warning. |
| `aiken check -D -m "probe.{..}" --seed 42 --max-success 1000` | Deny warnings, fixed seed, 1000 property runs (default is 100). |
| Output format | On a TTY: `PASS [mem: 5.93 K, cpu: 3.24 M] hashes_and_cbor` and `PASS [after 100 tests] prop_…`. When stdout is **not** a TTY, it prints **JSON**, for example `{"summary":{…},"modules":[{"tests":[{"title","status","execution_units":{"mem","cpu"},"iterations"}]}]}`. `--show-json-schema` prints the schema. Use the JSON in CI to track per-test budgets. |
| `aiken check -t compact` | Trace verbosity for tests. Default is `verbose`. |
| `aiken bench` | Benchmarks (`bench` blocks). |
| `aiken build` | Writes `plutus.json` (CIP-57). **`--trace-level` / `-t` accepts `silent\|compact\|verbose`. The default for `build` is `silent`**, so traces are stripped. Verified: `aiken build` and `aiken build -t silent` both give hash `56e83b4c…`, 1347 bytes. `-t verbose` gives `d2810096…`, 2138 bytes. `-f/--trace-filter user-defined\|compiler-generated\|all`, `-D` denies warnings, `-o` sets the output path, `-I` includes all types in the blueprint. |
| `aiken blueprint apply -m probe -v cascade_node 00 -o applied.json` | Applies one parameter given as **hex CBOR Plutus Data** (`00` = Int 0, `182a` = 42; use `cbor.serialise` or Lucid `Data.to` to produce it). Repeat once per parameter. The output validators no longer have `parameters`. The result hash `d69e3239…caf5f` equals Lucid `applyParamsToScript(script, [0n])`, verified. |
| `aiken blueprint hash` / `policy` / `address` | `-i applied.json -m probe -v cascade_node` gives the hash, policy id, and `addr_test1w…` (use `--mainnet`, or `--delegated-to <stake addr>`). |
| `aiken blueprint convert` | Produces a cardano-cli text envelope. |
| `aiken tx simulate tx.cbor inputs.cbor outputs.cbor` | Evaluates a real tx locally. Takes `--slot-length`, `--zero-time`, `--zero-slot` (defaults are **mainnet**; pass the Yaci or preprod values) and `--blueprint` with `--script-override` to swap scripts. |

The design-patterns library's own tests pass under 1.1.24. See [aiken-design-patterns.md](aiken-design-patterns.md).
