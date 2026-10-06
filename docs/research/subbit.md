# Subbit.xyz voucher channels and x402 issue #3579: digest

## Sources

| Source | Pin |
|---|---|
| Issue https://github.com/x402-foundation/x402/issues/3579 "[Feature]: batch-settlement on Cardano" | by `loveaihq`, opened 2026-09-25T05:28:20Z, label `enhancement`, **state open, 0 comments** (`gh api …/comments --paginate` returned nothing on 2026-10-01) |
| Validator repo https://github.com/kompact-io/subbit-xyz | commit `66648db2e5dbc459b8cd335846af079328c4313f` (2026-09-01, HEAD of `main`) |
| Binding + reference implementation https://github.com/loveaihq/subbit-x402 | commit `4d4e86d5f3cc870c0bcf16a635eaa96d3dae42af` (2026-09-29); npm `subbit-x402@0.2.3` (published 2026-09-29) |
| Binding spec draft | `subbit-x402/specs/scheme_batch_settlement_cardano.md`, **draft v0.6 (2026-09-25)** |
| Local verification | Aiken `v1.1.24+bacbeb3` (downloaded release binary), Python `cryptography` Ed25519 |

---

## 1. What the issue proposes

- **Problem.** Cardano cannot price x402 resources with `exact`. Every payment output needs its min-UTxO, "about 0.98 ADA (~$0.23)", plus "a ~0.17 ADA fee", while most resources sell for $0.01 or less. "In September 2026 none of the 16,621 resources in the discovery index accepted Cardano."
- **Proposal.** Add a Cardano binding of x402's existing **`batch-settlement`** scheme, which has EVM and SVM bindings. It would sit over Subbit.xyz, which the issue describes as an "existing Aiken payment-channel validator (Apache-2.0, alpha, unaudited)". The mechanism:
  - One deposit opens or tops up a channel.
  - Each request carries an off-chain cumulative voucher, an Ed25519 IOU over (tag, cumulative amount).
  - The server redeems many channels in one tx.
  - A refund uses the validator's `Mutual` redeemer, co-signed by the server.
  - The fallback is the consumer's unilateral close, then end or elapse.
  - "The facilitator holds no key by default."
- **Open questions** addressed to x402 maintainers `@fabianbormann` and `@Kammerlo`:
  - Does a binding on a third-party validator fit?
  - Should the TS implementation go into `@x402/cardano`?
- **Planned PR path:** `specs/schemes/batch-settlement/scheme_batch_settlement_cardano.md`. That file does not exist in x402 `main` at `6b6ee91`, which has only the `cloudflare`, `evm` and `svm` bindings plus the generic `scheme_batch_settlement.md`.
- **Status:** open, no maintainer reply, not merged. "Most of the code and text was written with an AI assistant (Claude)."

Preprod transactions listed in the issue, verbatim:

| Action | Preprod tx |
|---|---|
| Deposit opening a channel, first request paid | `0614b7d062db1ffd1385333d08c55ca48326c4f56ebe374999ce263c2dc70981` |
| One `Sub` redeeming 200 requests | `de70bb06fca7c4f59720b81b7a4b847a456f8f7645f5ac626048076b3788da1d` |
| One claim over 10 channels | `4fa168b6dcdcbaf61bda06d57ebda03dab389f52b1d1bb68bb20ecf913c680dc` |
| Refund (`Mutual`, co-signed) | `b053c1d16da3f37e0f8c116e2ed03b6e90aa8a42a89414873641d2596d9184be` |
| Top-up of a tUSDM channel | `8914fba9b2dd1196d90b95a64d8592e499497f40451e34f358f684692e652b1c` |
| Consumer's close, then the server's automatic settle (tUSDM) | `b09f876ccee525fd5fb02a6b572ec710e42a18efdabf8850295e1fa513b01bb8`, `4e95e4283b8f1e588f08f11f9c00e0746c4940e6467d833e5f8c7359c1623b35` |
| Elapse without the server (tUSDM) | `abfb361f9ffe04c5e6fcb703f1c48eef3305d637ed9cb5daac1d86840805f067` |

Extra preprod transactions from `subbit-x402/RESULTS.md`:

| Action | Preprod tx | Cost |
|---|---|---|
| `Sub` of 5,000 IOUs (5 tADA) | `9b1d9addd28bd534acf4f770a6b9adbdf36dc0f9324d39846dc21571e41047f4` | fee 0.341537, 0.000068 ADA per request |
| Same with the reference script | `616c5dc674416897ad2107fa79fb8b344a744758cc4663f7ca50d7c235404923` | fee 0.254730, 0.000050 ADA per request |
| Reference-script deploy of the validator (output `#0`) | `544752f68665183e51c8ecb6e0a835543aec64a6ec8e7588d34470ddfd12cdb5` | 14.154040 tADA = 4,310 × (160 + 3,124) bytes |

## 2. The validator: `kompact-io/subbit-xyz`

### 2.1 Location, licence, build

| Item | Value |
|---|---|
| Aiken project | `aiken/` subdirectory (not repo root) |
| `aiken.toml` | `name = "kompact-io/subbit-xyz"`, `version = "0.0.0"`, `compiler = "v1.1.23"`, `plutus = "v3"`, `license = "Apache-2.0"` |
| Dependencies | `aiken-lang/stdlib` **`v3.1.0`**, `aiken-lang/fuzz` `2.2.0` |
| Licence | Apache-2.0 declared **only** in `aiken/aiken.toml`. There is no top-level LICENSE file; GitHub reports `license: null`. The Rust workspace `Cargo.toml` declares `MPL-2.0`. |
| Status | README: "Status: alpha." Catalyst F13 project; milestones M1 to M5 ticked, M6 open. Unaudited. |
| Blueprint | `aiken/plutus.json`, preamble compiler `v1.1.23+5bcde6d`, `plutusVersion: v3` |
| **Script hash** | `subbit.subbit.spend` = **`62ce4309e37e09e5c633c96c6ae68061c434f122d32626d6912d7c2a`** (compiled code: 6092 hex characters, about 3,046 bytes) |
| Parameters | **none**. The validator is not parameterized, so every channel on a network shares one address, and per-channel constants live in the datum. |
| Other validators in `validators/x.ak` | `currency`, `constants`, `stage`, `steps`, `step`, `cont`, `eol`. These are dev-only mint validators that always return `False`, used to expose types in the blueprint. |

**I verified locally with Aiken v1.1.24+bacbeb3:**

- `aiken build` of `aiken/` at `66648db` reproduces hash `62ce4309…d7c2a` exactly. The only warning is "aiken.toml demands compiler version v1.1.23".
- The `subbit-x402` provenance file independently reports the same for 1.1.23+8949565 and 1.1.24+bacbeb3.

### 2.2 Types (from `lib/subbit/types.ak` and the blueprint)

```aiken
pub type Tag = ByteArray
pub type Currency { Ada  Asset { hash: ScriptHash, name: ByteArray } }
pub type Constants = (Tag, Currency, VerificationKey, VerificationKeyHash, VerificationKeyHash, Int)
//                    tag  currency  iou_key          consumer             provider             close_period
pub type Datum = (ScriptHash, Constants, Stage)      // (own_hash, constants, stage)
pub type Stage { Opened { subbed: Amount }  Closed { subbed: Amount, elapse_at: Timestamp }  Settled }
pub type Redeemer { Defer  Main(Steps)  Mutual }
pub type Step { StepCont(Cont)  StepEol(Eol) }
pub type Steps = List<Step>
pub type Cont { Add  Sub { n: Amount, sig: Signature }  Close  Settle { n: Amount, sig: Signature } }
pub type Eol { End  Elapse }
```

Plutus Data encoding, taken from the blueprint `definitions`. Aiken tuples are Plutus **lists**; enums are constructors.

| Type | Encoding |
|---|---|
| `Datum` | `List [Bytes own_hash(28), Constants, Stage]` |
| `Constants` | `List [Bytes tag, Currency, Bytes iou_key(32, Ed25519 pubkey), Bytes consumer(28, vkey hash), Bytes provider(28, vkey hash), Int close_period(ms)]` |
| `Currency` | `Ada` = `Constr 0 []`; `Asset` = `Constr 1 [Bytes policy, Bytes name]` |
| `Stage` | `Opened` = `Constr 0 [Int subbed]`; `Closed` = `Constr 1 [Int subbed, Int elapse_at]`; `Settled` = `Constr 2 []` |
| `Redeemer` | `Defer` = `Constr 0 []`; `Main` = `Constr 1 [List Step]`; `Mutual` = `Constr 2 []` |
| `Step` | `StepCont` = `Constr 0 [Cont]`; `StepEol` = `Constr 1 [Eol]` |
| `Cont` | `Add` = `Constr 0 []`; `Sub` = `Constr 1 [Int n, Bytes sig(64)]`; `Close` = `Constr 2 []`; `Settle` = `Constr 3 [Int n, Bytes sig(64)]` |
| `Eol` | `End` = `Constr 0 []`; `Elapse` = `Constr 1 []` |

The datum must be **inline** (`coerce_datum`: `expect InlineDatum(data)`), and `own_hash` must equal the channel's own script credential (`expect Script(own_hash) == own_cred`).

### 2.3 Spend logic

The entry point is `validator subbit { spend(datum: Option<t.Datum>, redeemer, own_oref, tx) }`. It does `expect Some(datum)` and dispatches on the redeemer:

- **`Defer`.** Passes iff this input is **not** the first input in `tx.inputs` (ledger order, i.e. lexicographic by output reference) whose payment credential is the validator. Only one input runs `Main`.
- **`Main(steps)`.**
  - Folds `steps` over the inputs and outputs **in order**:
    - `yield_in` takes the next input at the validator and parses its datum.
    - For a `Cont` step, `yield_out` takes the next output at the validator. That output must have the **same stake credential** as the input, a datum with the same `own_hash` and identical `constants`, and **no reference script**.
  - Each step returns the vkey hash that must sign. The hashes are accumulated with `xlist.ordered_insert`, and every one must be in `extra_signatories`.
  - Finally, no validator input may remain unconsumed by a step.
- **`Mutual`.**
  - Both `consumer` and `provider` must be in `extra_signatories`.
  - The channel must be the **only** input at the validator's payment credential.
  - Outputs are unconstrained.

Per-step rules (`lib/subbit/steps/*.ak`):

| Step | Stage in → out | Signer | Checks |
|---|---|---|---|
| `Add` | `Opened` → identical `Opened` | consumer | `amount_in(currency, v_in) < amount_out(currency, v_out)` |
| `Sub{n,sig}` | `Opened{subbed_in}` → `Opened{subbed_out}` | provider | `subbed_out - subbed_in == amount_in - amount_out`; `iou.verify(iou_key, tag, n, sig)`; `subbed_out <= n` |
| `Close` | `Opened{subbed}` → `Closed{subbed, elapse_at}` | consumer | same `subbed`; `amount_in <= amount_out`; upper validity bound is `Finite(ub)` with `ub <= elapse_at - close_period` |
| `Settle{n,sig}` | `Closed{subbed_in,_}` → `Settled` | provider | `iou.verify(iou_key, tag, n, sig)`; `amount_in - amount_out <= n - subbed_in` |
| `End` (Eol) | `Settled` → gone | consumer | none |
| `Elapse` (Eol) | `Closed{elapse_at}` → gone | consumer | lower validity bound is `Finite(lb)` with `elapse_at <= lb` |

Value handling (`lib/subbit/assets.ak`):

- `amount_in` reads only the currency (lovelace or `quantity_of(policy, name)`) and ignores stray tokens.
- `amount_out` is strict:
  - An ADA channel's continuing output must hold **only** ADA.
  - A token channel's continuing output may hold ADA plus that single token and nothing else (`fail @"bad value"`).
- For token channels, the ADA in the output is not counted; only min-UTxO protects it.

**Opening a channel runs no script.** Any datum can be placed at the address. A malformed datum makes the UTxO unspendable by every path, including `Mutual`, because the datum is parsed first. All open-time checks fall on the server and facilitator.

### 2.4 Voucher (IOU) signing format

`lib/subbit/iou.ak`:

```aiken
pub fn verify(key: VerificationKey, tag: t.Tag, amount: Amount, signature: Signature) {
  let message: Data = (tag, amount)
  verify_ed25519_signature(key, cbor.serialise(message), signature)
}
```

- **Signed bytes:** Plutus `serialiseData` of the 2-element list `[Bytes tag, Int amount]`. That is the indefinite-length CBOR list `0x9f ‖ bytes(tag) ‖ uint(amount) ‖ 0xff`.
  - The Rust `TagTbs` in `packages/core/src/tag_tbs.rs` encodes the same, and its tests assert `encoded[0] == 0x9f` and last byte `0xff`.
- **Signature:** plain Ed25519, 64 bytes, by `iou_key` (a raw 32-byte Ed25519 public key in the datum, not a key hash).
- **Tags:** tags longer than 64 bytes get chunked by `serialiseData` and MUST NOT be used (binding spec).
- **`amount`:** **cumulative** (the total owed so far on this channel), not per request.
- **Expiry:** IOUs carry none.
- **Channel tag.** The consumer fixes it in the datum. ADR `docs/adrs/tag.md` recommends:
  - `blake2b256` of one of the opening tx's inputs.
  - For several channels opened in one tx, that hash appended with the channel's rank.
  - The binding spec makes this a MUST: "`channelId` is the channel's `tag`, 32 bytes … blake2b-256 of the CBOR of one of the inputs its opening transaction spends", and requires a fresh `iouKey` per channel, because an IOU is bound to the pair `(iouKey, tag)`.

**Test vector** (binding spec, verbatim):

```
private key seed  0707…07 (32 bytes)
public key        ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c
tag               1111…11 (32 bytes)
amount            203000
message           9f58201111111111111111111111111111111111111111111111111111111111111111 1a000318f8 ff
signature         d09aac1f109a70db6328acec3e83d01f9d894d6bab248b03e8689ac3818526582426262cbd8c14ec2d763696910748159405ff38ee3d049c1a3954ddfa073a08
```

**I verified this vector independently:**

- Python `cryptography` Ed25519 with seed `07`×32 gives exactly the public key and signature above, over message `9f582011111111111111111111111111111111111111111111111111111111111111111a000318f8ff`.
- Aiken v1.1.24 test with stdlib v3.1.0: `cbor.serialise((tag, 203000))` equals that message, and `subbit/iou.verify(pk, tag, 203000, sig)` returns `True`. Both tests passed.

Optional IOU key derivation (binding, client-private; nothing on chain depends on it):

- `root = HKDF-SHA256(ikm = CIP-8 Ed25519 signature over a fixed message, salt = "x402 batch-settlement cardano", info = "iou root v1", 32 bytes)`
- `seed = HKDF-SHA256(ikm = root, salt = same, info = "iou key v1 <network> <tag hex>", 32 bytes)`

### 2.5 Batch redeem, close and timeout

**Batch redeem.**

- One tx spends N channels.
- The lexicographically first channel input carries `Main([step_1 … step_N])`, one step per channel in input order. Every other channel input carries `Defer`.
- Continuing outputs appear in the same order.
- The provider signs once.

Measured claim cost on preprod (binding spec):

| Channels | ADA channels (tADA) | Token channels (tADA) |
|---:|---:|---:|
| 1 | 0.256727 | 0.267227 |
| 10 | 0.571358 | 0.632372 |
| per extra channel | 0.034959 | ~0.0406 |

The size limit binds first, at "about 45 ADA channels, or 36 token channels, per transaction (extrapolated … not measured)".

**Close and timeout (unilateral exit).**

1. The consumer runs `Close` and sets `elapse_at ≥ tx upper bound + close_period`.
2. The provider must `Settle` with its latest IOU. The validator gives `Settle` no deadline, but after `elapse_at` a settle races an `Elapse`, so `elapse_at` is the practical deadline.
3. The consumer then runs `End` (after `Settled`), or `Elapse` once `lower bound ≥ elapse_at` (if the provider never settled).

`End` and `Elapse` constrain **no outputs**. The consumer's key alone decides where the remaining funds go.

- **Cooperative close (`Mutual`).** Consumer and provider co-sign. The channel must be the only validator input. Outputs are free, so the co-signed tx itself defines the split.
- **Binding parameter.** `withdrawDelay` (seconds) sets `close_period = withdrawDelay × 1000` ms. It must be in **900 to 2,592,000** seconds and ≥ `maxTimeoutSeconds`. `MIN_WITHDRAW_DELAY = 900` in `src/x402/types.ts`.

**Reserve (min-UTxO of the largest continuing output, `Closed` stage),** measured on preprod:

- **1.73 tADA** for an ADA channel.
- **2.13 tADA** for a token channel.
- For token channels, the client MUST deposit exactly the reserve in ADA. A redemption may take that ADA down to the exact min-UTxO (measured 2.133450 → 2.042940).

### 2.6 Known defect (liveness)

The `subbit-x402` authors found this with 73 Aiken tests of their own. Quoted: "A batch that needs two different signers fails when the later step's signer sorts first. It fails closed."

The code confirms it. `extra/xlist.ak`:

```aiken
pub fn ordered_insert(xs: List<ByteArray>, item: ByteArray) {
  when xs is {
    [x, ..xs] -> when bytearray.compare(x, item) is {
        Less -> [x, ..ordered_insert(xs, item)]
        Equal -> [x, ..xs]
        Greater -> fail @"Impossible"
      }
    _ -> [item]
  }
}
```

A `Main` batch that mixes consumer steps and provider steps can therefore fail, depending on key ordering. Single-signer batches are fine: all provider `Sub`/`Settle`, or all consumer steps.

## 3. The x402 binding (`loveaihq/subbit-x402`, draft v0.6)

**Scheme.** `batch-settlement`, not `exact`. It has no `assetTransferMethod`, and `paymentFlow` is `authorization`. It uses the same network ids and asset format as Cardano `exact`.

**`PaymentRequirements.extra`:**

| Field | Required | Meaning |
|---|---|---|
| `scriptHash` | yes | 28-byte hex; the validator the server accepts |
| `receiverAuthorizer` | yes | 28-byte key hash; the datum `provider`, which signs every redemption |
| `withdrawDelay` | yes | integer seconds |
| `referenceScript` | no | `txHash#index` of an output holding the validator as a reference script |
| `minDeposit` | no | capacity hint; the facilitator MUST NOT enforce it |
| `confirmationPolicy` | no | as in Cardano `exact` |
| `channelState`, `voucherState` | corrective 402 only | see the corrective 402 below |

Example, verbatim:

```json
{ "scheme": "batch-settlement", "network": "cardano:preprod", "asset": "lovelace", "amount": "1000",
  "payTo": "addr_test1qrxchm0g4la6hqfd9wq6vuuldx7l20az52t7lvgpgujr8pvwmpzru5kuf4mpmvtaf0hlsjtz7t4r2h7tj9v3c02dhljq0wqkef",
  "maxTimeoutSeconds": 300,
  "extra": { "scriptHash": "62ce4309e37e09e5c633c96c6ae68061c434f122d32626d6912d7c2a",
             "receiverAuthorizer": "cd8bede8affbab812d2b81a6739f69bdf53fa2a297efb10147243385",
             "withdrawDelay": 900,
             "referenceScript": "544752f68665183e51c8ecb6e0a835543aec64a6ec8e7588d34470ddfd12cdb5#0",
             "minDeposit": "10000" } }
```

**Payload types.**

| Type | Shape |
|---|---|
| `deposit` | `{ channelConfig, voucher, deposit: { amount, transaction } }` (open, or a top-up via `Main([Add])` when `voucher.channelRef` is set) |
| `voucher` | `{ channelConfig, voucher }` |
| `refund` | `{ channelConfig, voucher, transaction (Mutual, consumer-signed), providerWitness? }` |
| `claim` | server-originated: `{ transaction, claims: [{ channelId, totalClaimed }] }` |

The two record types are:

- `channelConfig = { payer (consumer key hash), payerAuthorizer (iouKey hex 32 B), receiver (== payTo), receiverAuthorizer, token (== asset), withdrawDelay }`.
- `Voucher = { channelId, maxClaimableAmount, signature (hex 64 B), channelRef? }`.

**Identity versus position.**

- `channelId` is the `tag`. It is stable.
- `channelRef` is the current `txHash#index`. It moves with every `Sub` or `Add`.

**Server rules.**

- A paid voucher MUST equal `chargedCumulativeAmount + amount`. Otherwise the server sends a **corrective 402**, with `error = invalid_batch_settlement_cardano_cumulative_amount_mismatch` and the `channelState` / `voucherState` fields in `extra`.
- One in-flight request per channel (`channel_busy`).
- Vouchers are committed locally; no facilitator call.
- A retry of the latest voucher is answered from the kept response.
- The response id `commitmentId` is `"<channelId>:<maxClaimableAmount>"`.

**Facilitator rules.**

- It holds no key or funds by default. It verifies a deposit's datum binding: `ownHash = scriptHash`, `tag = channelId`, `iouKey`, `consumer`, `provider`, `closePeriod`, stage `Opened(0)`.
- It rejects certificates, withdrawals, minting and governance actions.
- It broadcasts the exact bytes received and answers `settlement_pending` as Cardano `exact` does.
- Optional provider-key delegation to the facilitator is authenticated by `delegationMac = HMAC-SHA256(secret, canonical JSON of { payTo, payload })`.

**Error prefix:** `invalid_batch_settlement_cardano_`.

**Reference implementation.**

- npm `subbit-x402@0.2.3`, Apache-2.0.
- Dependencies pinned exactly: `@x402/core` **2.27.0**, `@evolution-sdk/evolution` **0.5.15**, `@noble/hashes` 2.4.0.
- Exports `subbit-x402/subbit` and `subbit-x402/x402/{client,server,facilitator,manager,chain,koios,cardano,txcheck,types,claimtx,sponsor}`.
- Claims 58 chain-free TS tests and 73 Aiken tests (under `vendor/subbit/aiken/lib/mark/`).
- Status: "a research spike, preprod only."

## 4. Can Cascade use Subbit as an Aiken dependency (Aiken v1.1.24, stdlib v2, Plutus V3)?

**Short answer: not as a declared `[[dependencies]]` entry, and not against stdlib v2.** It is compatible with Aiken 1.1.24 and Plutus V3, so reference it by hash or vendor it.

I tested this in the scratchpad with Aiken v1.1.24+bacbeb3:

| Test | Result |
|---|---|
| Build `subbit-xyz/aiken` as-is (stdlib v3.1.0) with v1.1.24 | Builds. Hash `62ce4309e37e09e5c633c96c6ae68061c434f122d32626d6912d7c2a`, identical to the v1.1.23 blueprint. |
| New project (stdlib `v2.2.0`) with `[[dependencies]] name = "kompact-io/subbit-xyz", version = "66648db2…", source = "github"` | Fails: `aiken::check::unknown::module … 'subbit/types'`. Aiken fetches the repo root, but the Aiken project lives in `aiken/`, so `lib/` is not found. **A git dependency cannot work.** |
| Subbit `lib/subbit` + `lib/extra` vendored into a stdlib **v2.2.0** project | Fails: `aiken::check::cycle` at `lib/subbit/prelude.ak:28` (`pub type Timebound = IntervalBoundType`). In stdlib v2.2.0, `IntervalBoundType<a>` is generic. Subbit is written for stdlib v3, where it is not. |
| Same, vendored into a stdlib **v3.1.0** project, with Aiken v1.1.24 | Builds. `subbit.subbit.spend` has hash `62ce4309…d7c2a`, identical, so vendoring does not change the script. |

Also note:

- Aiken `v1.1.24` was released 2026-09-26.
- stdlib releases: `v2.2.1` (2025-12-16), `v3.0.0` (2025-10-22), `v3.1.0` (2026-04-24), `v4.0.0` (2026-09-26).
- Subbit pins `v3.1.0`.

---

## Implications for Cascade

1. **Do not import Subbit into the Cascade Aiken project.** Cascade only needs:
   - `channel_script_hash = 62ce4309e37e09e5c633c96c6ae68061c434f122d32626d6912d7c2a`, the same on every network because the validator is unparameterized.
   - A **local mirror of the datum types** to check that a Draw's channel output is well formed:
     - `Datum = [own_hash, Constants, Stage]`
     - `Constants = [tag, Currency, iou_key(32), consumer(28), provider(28), close_period]`
     - the stage is `Opened(0)` = `Constr 0 [0]`
     - `own_hash == channel_script_hash`
     - an inline datum and no reference script
   - Mirror types written against stdlib v2 are fine. They are Data shapes, not Subbit code.
   - If Cascade wants Subbit's own code in-tree (for Aiken tests), it must move to stdlib v3.1.0, or keep a separate vendored stdlib v3 test project.
2. **Refunds do not flow back into the tree trustlessly.**
   - `consumer` in the channel datum must be a **key hash**, and `End`, `Elapse` and `Mutual` constrain no outputs.
   - The unspent deposit returns wherever the consumer key (the orchestrator) sends it.
   - So "Trustless for the deposit" in PRD section 8.1 is true for the buyer versus the provider, but not for the tree versus the orchestrator. The PRD invariant "No Draw output pays a key address… until settlement" does not extend through a channel's close.
   - Cascade would need an off-chain obligation, or a Cascade-owned wrapper, to force the refund back into `cascade_node`.
3. **Min-UTxO economics.**
   - A channel needs about 1.73 tADA of reserve (ADA channel) or about 2.13 tADA (token channel).
   - Each claim costs about 0.26 tADA plus about 0.035 tADA per extra channel.
   - The PRD target "200 tool calls, ≤ 3 L1 txs" (open, one `Sub`, one refund) matches what was measured: 5,000 IOUs in one `Sub` at 0.00005 to 0.00007 ADA per request.
4. **The IOU format is fixed and verified.** Sign `9f 58 20 <tag32> <uint amount> ff` with a per-channel Ed25519 key. Use a 32-byte tag equal to blake2b-256 of an opening input's CBOR, and a fresh `iouKey` per channel.
5. **Batch shape constraint.** Never mix consumer-signed and provider-signed steps in one `Main` batch; the `ordered_insert` defect can make it fail. Separate txs are safe.
6. **Opening runs no validator, so Cascade's Draw check is the only guard.** A malformed datum strands the deposit permanently.
7. **Status and risk.**
   - Subbit is alpha and unaudited, and its licence is declared only in `aiken.toml`.
   - The x402 `batch-settlement` Cardano binding is an **unmerged draft** in an open issue with zero maintainer response, and `@x402/cardano` does not include it.
   - Treat `subbit-x402@0.2.3` (pinned to `@x402/core` 2.27.0, not 2.28.0) as a reference, not a dependency, unless its core pin is compatible.
   - The PRD's "Subbit binding, x402 issue #3579" should be described as a proposal, not an x402 standard.
