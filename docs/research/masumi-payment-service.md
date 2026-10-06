# Masumi Payment Service and `vested_pay` V2 contract (digest)

## Sources

| Source | Pin |
|---|---|
| `masumi-network/masumi-payment-service` | commit `69297f308f603bffbdfd4efccb54398eaff1bd87` (HEAD on 2026-10-01; latest release tag `0.28.0`, 2026-07-20; main is 834 commits ahead of `0.28.0`) |
| files: `smart-contracts/payment-v2/{validators/vested_pay.ak, plutus.json, aiken.toml, README.md, state_machine_diagram.md}`, `smart-contracts/registry-v2/*`, `packages/payment-core/src/config.ts`, `packages/payment-source-v2/src/contract-generator.ts`, `docs/migrations/v2-contract-cip30-upgrade.md`, `docs/configuration.md`, `.env.example`, `src/routes/api/payments/index.ts`, `src/utils/generator/swagger-generator/openapi-docs.json`, `prisma/schema.prisma` | same commit |
| `masumi-network/masumi-services-dev-quickstart` (`docker-compose.yml`) | commit `1dac5390d1418bb8c68c01b1f94bc84a41d1d9ad` |
| `masumi-network/masumi-docs` (`documentation/get-started/{install-masumi-node,register-agent}.mdx`) | commit `020c3b47153bc110b9d1c6f60cf957aadac25c8c` |

Licences: the service is MIT (README). The Aiken projects declare `license = "Apache-2.0"` (`aiken.toml`, `plutus.json` preamble).

Audit: TxPipe, April 2025 (`audits/Masumi-Payment-Service-Audit-April-2025.pdf`). That audit predates the V2 contract.

---

## 1. `payment-v2` contract (`vested_pay`)

### Build facts

- Aiken project `nmkr/masumi-payment`, `compiler = "v1.1.23"`, `plutus = "v3"`, stdlib `aiken-lang/stdlib v2.1.0`.
- `plutus.json` preamble: compiler `v1.1.23+8949565`, plutusVersion `v3`.
- The README warns that the script hash, and so the address, depends on the exact compiler version. CI (`scripts/check-v2-contracts.sh`) rebuilds and requires a byte-for-byte match.

### Validators in `plutus.json`

| title | hash | notes |
|---|---|---|
| `vested_pay.vested_pay.spend` | `2d6abca32e4b22b59e948ef22dfe682017de917a9ec088aa1bc3c64e` | compiledCode length 19,784 hex chars. **This is the hash of the unapplied (parameterised) script.** |
| `vested_pay.vested_pay.else` | same | `else(_) { fail }` |

Parameters, applied in this order by `getPaymentScriptV2` via `applyParamsToScript`:

```aiken
validator vested_pay(
  required_admins_multi_sig: Int,
  admin_vks: List<VerificationKeyHash>,   // weighted: duplicates = extra votes
  cooldown_period: Int,                   // milliseconds
)
```

Off-chain, `getPaymentScriptV2(adminWalletAddresses, requiredAdminSignatures, cooldownPeriod, network)` does the following:

- Throws if `requiredAdminSignatures <= 0` or if it exceeds the length of the admin list.
- Maps each address with `resolvePaymentKeyHash`.
- Admin order is positional. The code sorts admins by DB `order` before applying them.
- Uses Mesh pinned at `@meshsdk/core@1.9.0-beta.102` for V2 (ADR-0005).

### Deployed addresses and policy (canonical constants, `packages/payment-core/src/config.ts` `DEFAULTS`)

| Constant | Value |
|---|---|
| `PAYMENT_SMART_CONTRACT_ADDRESS_V2_PREPROD` | `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g` |
| `PAYMENT_SMART_CONTRACT_ADDRESS_V2_MAINNET` | `addr1wxs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgge2j6d` |
| `REGISTRY_POLICY_ID_V2_PREPROD` / `_MAINNET` | `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b` (same on both networks; the registry-v2 policy is unparameterised) |
| `DEFAULT_ADMIN_SIGNATURES_V2` | `2` |
| `COOLDOWN_TIME_PREPROD` / `_MAINNET` | `1000 * 60 * 7` ms (7 min) |
| `ADMIN_WALLET1_PREPROD` | `addr_test1qr7pdg0u7vy6a5p7cx9my9m0t63f4n48pwmez30t4laguawge7xugp6m5qgr6nnp6wazurtagjva8l9fc3a5a4scx0rq2ymhl3` |
| `ADMIN_WALLET2_PREPROD` | `addr_test1qplhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhmsuycl5a` |
| `ADMIN_WALLET3_PREPROD` | `addr_test1qzy7a702snswullyjg06j04jsulldc6yw0m4r4w49jm44f30pgqg0ez34lrdj7dy7ndp2lgv8e35e6jzazun8gekdlsq99mm6w` |
| `FEE_WALLET_PREPROD` / `FEE_PERMILLE_PREPROD` | `addr_test1qqfuahzn3rpnlah2ctcdjxdfl4230ygdar00qxc32guetexyg7nun6hggw9g2gpnayzf22sksr0aqdgkdcvqpc2stwtqt4u496` / `50`. The V2 validator does **not** enforce a protocol fee ("Protocol fee payment is not enforced by this validator version"). |

`docs/migrations/v2-contract-cip30-upgrade.md` says the preprod V2 address above is derived "with the default seed admin wallets and `DEFAULT_ADMIN_SIGNATURES_V2 = 2`, `COOLDOWN_TIME = 7 minutes`". So the preprod escrow is a **2-of-3 multisig over the three `ADMIN_WALLET*_PREPROD` payment key hashes, with a 7-minute cooldown**.

Superseded V2 (Aiken v1.1.21):

- payment script hash `bdbde1ee86893fdb8bdda96a4d7ca933de7850f8fe19bf2b16dd636f`
- registry policy `7890b485b808043ef80136a447a3a43c18893a309dc323d1f8b0a13d`
- old preprod address `addr_test1wqsztux7j6c23ukjj3328vvxe3yqug43fs9vufysg6ddxpg8xqev4`

Legacy V1:

| Network | Address | Registry policy |
|---|---|---|
| preprod | `addr_test1wz7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsqukgwfm` | `7e8bdaf2b2b919a3a4b94002cafb50086c0c845fe535d07a77ab7f77` |
| mainnet | `addr1wx7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsq87ujx7` | `ad6424e3ce9e47bbd8364984bd731b41de591f1d11f6d7d43d0da9b9` |

On-chain evidence: a preprod `WithdrawDisputed` settlement was run on 2026-07-02 (lock tx `121a99dcb108574b81c3ef5310d15fcb3e65ec51cca8df15fdb4e39b9e66ec9d`, settlement tx `2521fec45ee81f43edde626e6341dc807df938fff70d36ec621eb9e3d7578c0c`). It used example admin wallets, so its script address differs from the table above.

### Datum (exact field order; constructor 0; inline datum required)

```aiken
type POSIXTime = Int
pub type AssetValue = Pairs<ByteArray, Pairs<ByteArray, Int>>

pub type Datum {
  buyer: Address,                         // 0  must be a VerificationKey payment credential
  buyer_return_address: Option<Address>,  // 1
  seller: Address,                        // 2  must be a VerificationKey payment credential
  seller_return_address: Option<Address>, // 3
  reference_key: ByteArray,               // 4
  reference_signature: ByteArray,         // 5  >= 16 bytes; per-UTxO dedupe key
  seller_nonce: ByteArray,                // 6
  buyer_nonce: ByteArray,                 // 7
  agent_identifier: ByteArray,            // 8  preserved across transitions
  collateral_return_lovelace: Int,        // 9  must be >= 0
  input_hash: ByteArray,                  // 10
  result_hash: ByteArray,                 // 11 empty = no result
  pay_by_time: POSIXTime,                 // 12 (ms)
  submit_result_time: POSIXTime,          // 13
  unlock_time: POSIXTime,                 // 14
  external_dispute_unlock_time: POSIXTime,// 15
  seller_cooldown_time: POSIXTime,        // 16
  buyer_cooldown_time: POSIXTime,         // 17
  state: State,                           // 18
}
```

Off-chain encoding (`getDatumV2`):

- The `Option` fields use `Some` = alternative 0, `None` = alternative 1 with no fields.
- Addresses use Mesh `mPubKeyAddress(pkh, stakeKeyHash?)`. Enterprise addresses encode the stake part as `None`.
- The builder rejects script-credential principals, `reference_signature` shorter than 16 bytes, and a negative collateral value.
- `agent_identifier` and `input_hash` are hex. An empty value becomes an empty bytestring.

How the service fills the datum:

- `reference_key` and `reference_signature` come from the seller's CIP-8 `signData` over `sha256(stringify(blockchainIdentifierPayload))`. This is `generateBlockchainIdentifier(key, signature)` in `src/routes/api/payments/index.ts`.
- `pay_by_time` is not read by any spending branch. It is only copied through continuing outputs.

### State (constructor indices)

| Index | Constructor |
|---|---|
| 0 | `FundsLocked` |
| 1 | `ResultSubmitted` |
| 2 | `RefundRequested` |
| 3 | `Disputed` |
| 4 | `WithdrawAuthorized` |
| 5 | `RefundAuthorized` |

### Redeemer `Action` (constructor indices)

| Index | Constructor | Fields |
|---|---|---|
| 0 | `Withdraw` | none |
| 1 | `SetRefundRequested` | none |
| 2 | `AuthorizeWithdrawal` | none |
| 3 | `WithdrawRefund` | none |
| 4 | `WithdrawDisputed` | `buyer_value: AssetValue, seller_value: AssetValue, admin_signatures: List<AdminSignature>` |
| 5 | `SubmitResult` | none |
| 6 | `AuthorizeRefund` | none |

```aiken
pub type AdminSignature { verification_key: ByteArray, protected_headers: ByteArray, signature: ByteArray }
pub type DisputeWithdrawal { own_ref: OutputReference, buyer_value: AssetValue, seller_value: AssetValue }
```

There is no `UnSetRefundRequested`. It was removed in V2, and the removal is irreversible by design.

### Checks common to every spend (top of the `spend` handler)

- `expect Some(datum)`.
- `collateral_return_lovelace >= 0`.
- `len(reference_signature) >= 16`.
- The tx validity upper bound must be `Finite`. `current_time = upper_bound`, and `cooldown_time = current_time + cooldown_period`.
- Script inputs at the same address: their parseable inline datums must have **unique** `reference_signature`s. Unparseable inputs are skipped.
- Script outputs at the same address:
  - must have `reference_script == None`;
  - must carry an **inline** datum that parses as `Datum`, which is a hard `expect`;
  - must have unique `reference_signature`s, each at least 16 bytes.

  Known issue (deferred to v2.1): a dust UTxO with a bad datum sent to the script address and included as an output aborts the tx.
- Time helpers:
  - `must_start_after(range, t)` means `t <= lower_bound`, and the lower bound must be `Finite`.
  - `must_end_before(range, t)` means `upper_bound < t`, and the upper bound must be `Finite`.
- Signer check: `list.has(tx.extra_signatories, vkh)`, where `vkh` comes from the principal address's payment credential. Script credentials make the UTxO **permanently unspendable**.
- "Tagged payout output": an output whose inline datum is exactly the spent `OutputReference` (`own_ref`) and whose address is `return_address` if set, otherwise the principal. The comparison is full `Address` equality, including the stake part.
- "Continuing output" (for state-changing actions): some script output whose datum equals the input datum on every field, except the ones the action is allowed to change. Its value must be `>=` the input value (`assets.match(out, in, >=)`).

### Per-action validity rules

**`Withdraw` (seller)**

- There is no continuing output with the same `reference_signature`.
- The input's lovelace is at least `collateral_return_lovelace`.
- The seller key signs.
- One of these holds:
  - `state == WithdrawAuthorized`, with no time bound and no cooldown check; or
  - `state == ResultSubmitted` and `must_start_after(unlock_time)`.
- Tagged buyer outputs (to `buyer_return_address`, else `buyer`) total lovelace of at least `collateral_return_lovelace`.
- If `seller_return_address` is `Some`, tagged outputs there hold at least `input.value - collateral_return_lovelace`. If it is `None`, there is no constraint: the seller signs and chooses the destination.
- `result_hash` is non-empty.

**`SetRefundRequested` (buyer)**

- The continuing datum is identical except:
  - `seller_cooldown_time == 0`
  - `buyer_cooldown_time >= cooldown_time`
  - `state` = `RefundRequested` if `result_hash` is empty, else `Disputed`
- The value is preserved.
- The buyer key signs.
- `must_end_before(unlock_time)` and `must_start_after(buyer_cooldown_time)`.
- `state ∈ {FundsLocked, ResultSubmitted, Disputed}`.

**`WithdrawRefund` (buyer)**

- There is no continuing output.
- The buyer key signs.
- `state ∈ {FundsLocked, RefundRequested, RefundAuthorized}`.
- If `buyer_return_address` is `Some`, tagged outputs there hold at least the full input value. If it is `None`, there is no constraint.
- One of these holds: `must_start_after(submit_result_time)`, or `state == RefundAuthorized`.
- `result_hash` is empty.

**`AuthorizeWithdrawal` (buyer)**

- `result_hash` is non-empty.
- The continuing datum is identical except `seller_cooldown_time == 0`, `buyer_cooldown_time >= cooldown_time`, and `state == WithdrawAuthorized`.
- The buyer key signs.
- The value is preserved.
- `must_start_after(buyer_cooldown_time)`.
- `state == Disputed`.
- This action is irrevocable.

**`WithdrawDisputed` (anyone who holds admin signatures)**

- There is no continuing output.
- `result_hash` is non-empty.
- `must_start_after(external_dispute_unlock_time)`.
- The parameters satisfy `len(admin_vks) >= 1` and `0 < required_admins_multi_sig <= len(admin_vks)`.
- `state == Disputed`.
- Tagged buyer outputs are `>= buyer_value`, and tagged seller outputs are `>= seller_value`. The destination falls back to the principal when the return address is `None`, and a tagged output is **always** required here.
- `signed_message = blake2b_224(cbor.serialise(DisputeWithdrawal{own_ref, buyer_value, seller_value}))`.
- `len(admin_signatures) <= len(admin_vks)`.
- Each signature:
  - has `len(protected_headers) <= 256`;
  - satisfies `blake2b_224(verification_key) == admin_vk_hash`;
  - carries an ed25519 signature over the CIP-8 `Sig_structure` `["Signature1", protected_headers, h'', payload]`, where `payload` is `signed_message` or `blake2b_224(signed_message)` (the hashed mode).
- The count of `admin_vks` entries, with duplicates counted, that have a valid signature is at least `required_admins_multi_sig`.
- Any residual value above the two minimums is unconstrained and goes to the tx submitter as a "finder's reward".
- `collateral_return_lovelace` is **not** applied on this path.

**`SubmitResult` (seller)**

- The input's lovelace is at least `collateral_return_lovelace`.
- `state ∈ {FundsLocked, ResultSubmitted, Disputed, RefundRequested}`.
- The continuing datum is identical except:
  - `result_hash` is non-empty (any new value);
  - `seller_cooldown_time >= cooldown_time`;
  - `buyer_cooldown_time == 0`;
  - `state` = `ResultSubmitted` if the old state was `FundsLocked` or `ResultSubmitted`, else `Disputed`.
- The seller key signs.
- The value is preserved.
- `must_start_after(seller_cooldown_time)`.
- One of these holds:
  - `must_end_before(submit_result_time)`; or
  - `must_end_before(external_dispute_unlock_time)` and the old `result_hash` is non-empty (a rotation).

**`AuthorizeRefund` (seller)**

- The continuing datum is identical except `result_hash` is empty, `seller_cooldown_time >= cooldown_time`, `buyer_cooldown_time == 0`, and `state == RefundAuthorized`.
- The seller key signs.
- The value is preserved.
- `must_start_after(seller_cooldown_time)`.
- `state ∈ {RefundRequested, Disputed, FundsLocked, ResultSubmitted}`.
- There is deliberately no upper time bound.

### State machine (from `state_machine_diagram.md`)

```
[*] -> FundsLocked (lock tx; no validator runs)
FundsLocked      -> ResultSubmitted (SubmitResult) | RefundRequested (SetRefundRequested)
                  | RefundAuthorized (AuthorizeRefund) | [*] (WithdrawRefund after submit_result_time)
ResultSubmitted  -> ResultSubmitted (SubmitResult) | Disputed (SetRefundRequested)
                  | RefundAuthorized (AuthorizeRefund) | [*] (Withdraw after unlock_time)
RefundRequested  -> Disputed (SubmitResult) | RefundAuthorized (AuthorizeRefund)
                  | [*] (WithdrawRefund after submit_result_time)
Disputed         -> WithdrawAuthorized (AuthorizeWithdrawal) | RefundAuthorized (AuthorizeRefund)
                  | Disputed (SubmitResult / SetRefundRequested) | [*] (WithdrawDisputed after external_dispute_unlock_time)
WithdrawAuthorized -> [*] (Withdraw)
RefundAuthorized   -> [*] (WithdrawRefund)
```

### Refund flow

1. The buyer runs `SetRefundRequested` before `unlock_time`. With no result, the state becomes `RefundRequested`.
2. One of the following happens:
   - The seller runs `AuthorizeRefund`, giving `RefundAuthorized`. The buyer can then run `WithdrawRefund` immediately.
   - The seller does nothing. After `submit_result_time`, the buyer runs `WithdrawRefund`.
   - The seller runs `SubmitResult` (before `submit_result_time`), giving `Disputed`.

A buyer can also reclaim funds straight from `FundsLocked` with `WithdrawRefund` once `submit_result_time` has passed and no result exists.

### Dispute flow

The contract reaches `Disputed` in two ways: a refund request made after a result, or a result submitted after a refund request.

It can leave `Disputed` in three ways:

- The buyer runs `AuthorizeWithdrawal`, then the seller runs `Withdraw`.
- The seller runs `AuthorizeRefund`, then the buyer runs `WithdrawRefund`.
- After `external_dispute_unlock_time`, anyone submits `WithdrawDisputed` with enough weighted CIP-8 admin signatures.

The runbook says admins MUST NOT sign before `external_dispute_unlock_time`. The seller can rotate `result_hash` until that time, and the signature binds only `own_ref` and the payout minimums, not `result_hash`. Signers must use deterministic CBOR. Admin keys must not be used for arbitrary dApp `signData`.

### Admin / multisig keys

- On preprod, the three admin wallets are listed above; weights are 1 each; the threshold is 2.
- Deployers can create their own payment source with their own admins, which gives a different address. This goes through `POST /payment-source-extended` with the fields `AdminWallets`, `requiredAdminSignatures`, `cooldownTime`, and `feeRatePermille`.

---

## 2. REST API (`/api/v1`)

- Auth header: `token: <api key>` (OpenAPI `securitySchemes.API-Key`: `in: header, name: token`).
- The seed creates an admin key from `ADMIN_KEY`. If that is unset, it falls back to the public default `DefaultUnsecureAdminKey`.
- Swagger UI is at `/docs`. The admin dashboard is at `/admin/`.

Routes relevant to Cascade (from the committed `openapi-docs.json`):

| Route | Purpose |
|---|---|
| `GET /health` | health |
| `GET/POST/PATCH/DELETE /api-key` | manage API keys |
| `GET /payment-source` | list payment sources (includes selling wallet `walletVkey`) |
| `GET/POST/PATCH/DELETE /payment-source-extended` | admin CRUD of payment sources, including the Blockfrost key and admin wallets |
| `POST /wallet` | "Create a new wallet. (admin access required)". Body `{network}`. Returns a mnemonic and **does not save it**. |
| `GET /wallet`, `PATCH /wallet`, `GET /wallet/list` | hot wallet info |
| `POST /payment` | **seller**: create a payment request (returns `blockchainIdentifier` + times) |
| `GET /payment`, `POST /payment/resolve-blockchain-identifier` | seller payment status |
| `POST /payment/submit-result` | seller: body `{network, submitResultHash, blockchainIdentifier}`. `submitResultHash` is the hex sha256 result hash. |
| `POST /payment/authorize-refund` | seller: `{blockchainIdentifier, network}` |
| `POST /purchase` | **buyer**: lock funds in escrow |
| `GET /purchase`, `POST /purchase/resolve-blockchain-identifier` | buyer status |
| `POST /purchase/request-refund` | buyer: `{blockchainIdentifier, network}` |
| `POST /purchase/cancel-refund-request` | buyer: `{blockchainIdentifier, network}` (maps to `AuthorizeWithdrawal` on V2 per the example-script naming) |
| `POST /registry` | register (mint) agent |
| `GET /registry`, `GET /registry/agent-identifier`, `POST /registry/update`, `POST /registry/deregister`, `DELETE /registry` | registry management |

### `POST /payment` request

Required fields: `inputHash`, `network`, `agentIdentifier`, `identifierFromPurchaser`.

| Field | Type / rule |
|---|---|
| `inputHash` | hex string, max 250 |
| `network` | `"Preprod" \| "Mainnet"` |
| `agentIdentifier` | `policyId + assetName`. The service looks up the payment source by the policy-id prefix, and requires that the selling wallet holds the agent NFT. |
| `identifierFromPurchaser` | **hex**, length 14–26. Anything else gets `400` ("Purchaser identifier is not a valid hex string"). MIP-003's example `"resume-job-123"` would be rejected. |
| `paymentSourceType` | `"Web3CardanoV1" \| "Web3CardanoV2"`. Optional; it must match the agent's registry source. |
| `supportedPaymentSourceIndex` | int. **Required for V2**, forbidden for V1. It indexes into the agent's on-chain `supported_payment_sources`. |
| `RequestedFunds` | array; only for Dynamic pricing |
| `payByTime`, `submitResultTime` | date-time |
| `unlockTime` | date-time; default `submitResultTime + 6h` |
| `externalDisputeUnlockTime` | date-time; default `submitResultTime + 12h` |
| `metadata` | string |
| `sellerReturnAddress` | string |
| `forceLayer` | `"L1" \| "Hydra"` |

Server-side time rules:

- `payByTime <= submitResultTime - 5 min`
- `payByTime >= now - 5 min`
- `submitResultTime >= now + 15 min`
- `submitResultTime <= unlockTime - 15 min`
- `externalDisputeUnlockTime >= unlockTime + 15 min`

The response `data` includes `blockchainIdentifier`, `payByTime`, `submitResultTime`, `unlockTime`, `externalDisputeUnlockTime`, `inputHash`, `onChainState`, `NextAction`, `collateralReturnLovelace`, `cooldownTime`, and `sellerReturnAddress`, among others.

### `POST /purchase` request

Required fields:

- `blockchainIdentifier`
- `network`
- `inputHash`
- `sellerVkey`
- `agentIdentifier`
- `unlockTime`, `externalDisputeUnlockTime`, `submitResultTime`, `payByTime` (strings, Unix time in ms)
- `identifierFromPurchaser` (hex)

Optional fields:

- `paymentSourceType` (inferred from the shape of `blockchainIdentifier` if omitted)
- `smartContractAddress` (V2; must match the signed identifier)
- `supportedPaymentSourceIndex` (covered by the seller's signature)
- `Amounts`, `metadata`
- `buyerReturnAddress`, `sellerReturnAddress`
- `forceLayer`, `paymentForceLayer`

The README says script-credential buyer or seller addresses are rejected at `POST /purchase`.

### `blockchainIdentifier` construction (V2)

1. The seller builds this payload: `{inputHash, agentIdentifier, purchaserIdentifier, sellerIdentifier: sha256(cuid)+agentIdentifier, RequestedFunds, payByTime, submitResultTime, unlockTime, externalDisputeUnlockTime, sellerAddress, sellerReturnAddress, smartContractAddress, [paymentForceLayer], [supportedPaymentSourceIndex]}`.
2. It computes `sha256(stringify(payload))`.
3. The selling wallet signs that hash with `MeshWallet.signData`, which is CIP-8.
4. `generateBlockchainIdentifier(key, signature)` compresses and encodes the result.

---

## 3. Running it

### Does it require Blockfrost? **Yes.**

- `prisma/schema.prisma`: `enum RPCProvider { Blockfrost }`. Blockfrost is the only provider value.
- `PaymentSourceConfig.rpcProviderApiKey` is a required `String`.
- `createMeshProvider(apiKey)` returns a `BlockfrostProvider`.
- `POST /payment` calls `getBlockfrostInstance(...)`.
- `docs/configuration.md`: "The seed script reads **network-specific** Blockfrost keys — there is no generic `BLOCKFROST_API_KEY` variable." `BLOCKFROST_API_KEY_PREPROD` is required on the default install path. `BLOCKFROST_API_KEY_MAINNET` is needed only when mainnet sources are configured.
- There is no Koios, Ogmios, or Kupo alternative in the service code. (A `grep -i koios|ogmios|Maestro|Kupmios` over `src` and `packages` found none.)

### Minimum env (README "Getting Started")

`DATABASE_URL` (Postgres ≥ 13), `ENCRYPTION_KEY` (at least 20 chars; enforced in `config.ts`), `BLOCKFROST_API_KEY_PREPROD`. `ADMIN_KEY` is recommended; the docs say it must be at least 15 chars.

Optional:

- `PURCHASE_WALLET_PREPROD_MNEMONIC`, `SELLING_WALLET_PREPROD_MNEMONIC`: if blank, a new mnemonic is generated and **printed once** after seeding.
- `COLLECTION_WALLET_PREPROD_ADDRESS`
- `SEED_V1_LEGACY=true`, which also seeds V1 sources and then needs the separate `*_V2_*` mnemonics
- `COINGECKO_API_KEY`
- job intervals
- `AUTO_WITHDRAW_PAYMENTS`, `AUTO_WITHDRAW_REFUNDS` (default true)
- `BLOCK_CONFIRMATIONS_THRESHOLD` (example 20)
- `COOLDOWN_BLOCKTIME_BUFFER_MS` (default 600000; minimum 360000)

### From source

```
pnpm install
cp .env.example .env
pnpm run prisma:migrate
pnpm run prisma:seed
pnpm -C frontend run build
pnpm run dev            # :3001
```

### Docker

- The repo has a `Dockerfile` and no compose file. From `docs/deployment.md`: `docker build -t masumi-payment-service .` then `docker run --env-file .env -d -p 3001:3001 masumi-payment-service`.
- The docs' "Install Masumi Node" path uses `masumi-network/masumi-services-dev-quickstart`: `cp .env.example .env && docker compose up -d`.
- That compose file sets `ENCRYPTION_KEY`, `ADMIN_KEY`, and `BLOCKFROST_API_KEY_PREPROD`. It runs `prisma:migrate && prisma:seed && npm start`, with Postgres 15 containers exposed on 5432 (registry) and 5433 (payment).
- **Caveat: it pins `ghcr.io/masumi-network/masumi-payment-service:0.22.0` and `masumi-registry-service:0.22.0`.** Tag `0.27.0` still has only the V1 constants (`REGISTRY_POLICY_ID_PREPROD 7e8bdaf2…`). The V2 constants (`67ab0c92…`, `addr_test1wzs4e6…`) first appear at tag `0.28.0`. So the stock compose stack runs **V1 only**. To use V2 with it, bump the image to `0.28.0` or later, or build from source.

### Wallet creation

- **Seed:** `prisma:seed` creates a default `Web3CardanoV2` payment source per network. It has one purchasing hot wallet and one selling hot wallet, created from the supplied mnemonics or generated and printed once. Mnemonics are stored encrypted with `ENCRYPTION_KEY`.
- **`POST /wallet {network}`** (admin): generates a mnemonic and returns it without storing it.
- **Additional hot wallets** are attached to a payment source through `POST`/`PATCH /payment-source-extended` (`PurchasingWallets`, `SellingWallets`).
- **Funding:** preprod tADA comes from the Cardano faucet (`https://docs.cardano.org/cardano-testnets/tools/faucet`) or the Masumi dispenser (`https://dispenser.masumi.network/`), per `top-up-your-wallets.mdx` and the CrewAI template README.

---

## 4. Agent registration through the service

### Route

`POST /registry`. The required body fields are `network`, `sellingWalletVkey`, `ExampleOutputs`, `Tags`, `name`, `description`, `Capability {name, version}`, and `Author {name, contactEmail?, contactOther?, organization?}`.

Optional fields:

- `type` (`Standard` \| `OpenApi` \| `X402`; default `Standard`)
- `apiBaseUrl` (required for Standard)
- `openApiSpecUrl`, `x402ResourcesUrl`
- `Legal {privacyPolicy, terms, other}`
- `recipientWalletAddress`
- `sendFundingLovelace`
- `supportedPaymentSources`: **required for V2**. Each entry is `{chain:"Cardano", network, paymentSourceType, address (escrow contract), pricing}`, where `pricing` is one of:
  - `{pricingType:"Fixed", fixed:[{asset, amount}] (1..5)}`
  - `{pricingType:"Dynamic", dynamic:[...]}`
  - `{pricingType:"Free"}`

  EVM/x402 entries are also allowed.
- `AgentPricing`: V1 only; forbidden for V2.
- `verifications`

Other registry routes: `GET /registry` (poll status; returns `agentIdentifier` once confirmed), `POST /registry/update`, `POST /registry/deregister` (burn).

Registration runs as a background job (`REGISTER_AGENT_INTERVAL`). The docs say preprod takes about 5–15 minutes.

### What is minted

- One NFT is minted under the registry policy with quantity 1. The redeemer is `MintAction` (constructor 0).
- The asset name is 32 bytes: `nonce(1B, >0x0f; the service uses 0x10+) ++ blake2b_224(seed_utxo.tx_id ++ seed_utxo.output_index_be4) ++ 0x000000`.
- The tx carries CIP-25 metadata under label `721` as `{policyId: {assetNameHex: metadata}, version: "1"}`, plus label `674` `{msg: ["Masumi", "RegisterAgent"]}`.
- The NFT goes to the selling wallet, or to `recipientWalletAddress`.
- `agentIdentifier = policyId + assetNameHex`, which is 56 + 64 = 120 hex chars for V2.

See `masumi-registry.md` for the metadata schema.

### Cost in ADA

- The NFT output carries `max(sendFundingLovelace, collateralAmount)` lovelace. `SERVICE_CONSTANTS.SMART_CONTRACT.collateralAmount = '5000000'` gives a minimum of **5 ADA**, which stays in the recipient wallet together with the NFT.
- The mint tx also declares 5 ADA of collateral. Collateral is only consumed if the script fails.
- On top of that is the network fee.
- The docs say only: "Registration incurs a transaction fee in ADA."
- The source gives no fixed protocol registration fee. The on-chain policy is permissionless and charges nothing.

---

## 5. Paths that need only a funded preprod wallet (no Blockfrost)

- **Lock, submit, and withdraw against `vested_pay` directly:** the payment-v2 example scripts (`lock-example.mjs`, etc.) and the Mesh builders can drive every transition from any wallet. They need a chain provider for UTxO fetch, evaluation, and submission.
  - Both example suites use the keyless `KoiosProvider`: `smart-contracts/payment-v2/example-helpers.mjs:26` and `smart-contracts/registry-v2/example-helpers.mjs` both call `new KoiosProvider(network)`.
- **Registry mint:** the V2 policy is permissionless, so a funded wallet plus Koios can mint a registry NFT with `smart-contracts/registry-v2/mint-example.mjs` (`pnpm run mint`). Env for that script: `NETWORK`, `WALLET_FILE`, `AGENT_NAME`, `API_URL`, `IMAGE_URL`, `DESCRIPTION`, `COMPANY_NAME`, `CAPABILITY_NAME`, `CAPABILITY_VERSION`, `FIXED_PRICE_AMOUNT`, `FIXED_PRICE_UNIT`.
  - **Its metadata is the older demo shape** (`api_url`, `company_name`, `agentPricing`, no `metadata_version`). That does not match the strict V2 schema the Registry Service parses (`metadata_version: 2`, `supported_payment_sources`, `author`, `tags`, `image`).
  - To be indexed as a V2 agent, you must emit the V2 schema yourself.
- **Running the Payment Service itself** needs a Blockfrost project key: `BLOCKFROST_API_KEY_PREPROD`, free at blockfrost.io, "Cardano Preprod" project.

---

## 6. Credentials a human must provide, per external action

| Action | Needs from a human | Path with only a funded preprod wallet (no Blockfrost)? |
|---|---|---|
| Run Masumi Payment Service on preprod | A **Blockfrost preprod project key** (`BLOCKFROST_API_KEY_PREPROD`; free signup at blockfrost.io). Also a Postgres DB, an `ENCRYPTION_KEY`, and an `ADMIN_KEY` (self-chosen). tADA for the selling and purchasing hot wallets comes from the faucet or `dispenser.masumi.network`. | **No.** `RPCProvider` enum = `{Blockfrost}` only. |
| Register agent on the V2 preprod registry via the service (`POST /registry`) | The same as running the service, plus a funded selling wallet: at least about 5 ADA locked with the NFT, plus the fee, plus 5 ADA of collateral available. | No, because of the service's dependency on Blockfrost. |
| Register agent on the V2 preprod registry directly | Only a **funded preprod wallet mnemonic**. The policy is permissionless; the `registry-v2/mint-example.mjs` pattern with keyless Koios works. The metadata must be the V2 schema (see `masumi-registry.md`). | **Yes.** |
| Pay or escrow against `vested_pay` V2 directly (no service) | A funded wallet, with keyless Koios for chain access (as the `payment-v2` example scripts use). A `WithdrawDisputed` needs signatures from 2 of the 3 Masumi preprod admin keys, which a third party cannot obtain. | **Yes**, for lock, submit, withdraw and refund. |
| Query the registry | None. Koios is keyless. The public registry service uses the published test key `public-test-key-masumi-registry-c23f3d21`, which is for testing only. | **Yes.** |
| List on Sokosumi preprod | Per the docs, none beyond Masumi registration with tUSDM pricing. Visibility actually depends on the Sokosumi deployment config (`SHOW_AGENTS_BY_DEFAULT`). | Documented yes, unverified. |
| List on Sokosumi mainnet | A human submits the Tally whitelisting form (`https://tally.so/r/nPLBaV`), and the Sokosumi team approves. | No. |
| Hire agents via the Sokosumi API or MCP | A Sokosumi account plus an API key (or OAuth), and credits. On preprod, Stripe test card 4242…. | No. |
