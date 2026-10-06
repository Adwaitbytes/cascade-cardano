# x402 `exact` scheme on Cardano: spec digest

Source: `specs/schemes/exact/scheme_exact_cardano.md` in `x402-foundation/x402`, read in full (949 lines).

| Pin | Value |
|---|---|
| Repo commit read | `6b6ee91fee027b540faabcb25774e73851006c3b` (HEAD of `main`, 2026-09-29 21:01:32 +0200) |
| Cross-checked against | `typescript/packages/mechanisms/cardano` at the same commit (`@x402/cardano` 2.28.0) |
| Masumi blueprint cited by the spec | `masumi-network/masumi-payment-service` @ `d74b2c319228bcbef36632de37875c388dcee7ce`, `smart-contracts/payment-v2/plutus.json` (fetched and checked, see section 9) |

Anything marked **(impl)** comes from the TypeScript implementation, not the spec text.

---

## 1. Protocol basics

- **x402 version:** `2` (`"x402Version": 2` in every example; `@x402/core` exports `x402Version = 2`; the Cardano facilitator rejects `payload.x402Version !== 2` with `invalid_payload_unsupported_version` **(impl)**).
- **Scheme:** `exact`.
- **Canonical network ids:** `cardano:mainnet`, `cardano:preprod`, `cardano:preview`. These are the only forms advertised in `/supported`. They use CAIP-2 syntax, but `cardano` is not a registered CASA namespace.
- **CIP-34 aliases.** Clients and facilitators SHOULD accept these as input aliases: `cip34:1-764824073` (mainnet), `cip34:0-1` (preprod) and `cip34:0-2` (preview). They are normalized to the canonical id. A facilitator MUST treat an alias and its canonical id as the same network. The alias set is closed.
- **Network id in the tx body (impl):** mainnet `1`, every testnet `0`. `network_id` in the body is optional. If present, it must match.
- **Asset format:** `lovelace` or `${policyId}.${assetNameHex}` (policyId is 56 hex characters, asset name is 0 to 64 hex characters). Canonical form is lowercase **(impl)** `CANONICAL_CARDANO_ASSET_REGEX = /^(lovelace|[0-9a-f]{56}\.[0-9a-f]{0,64})$/`.
- **USDM, verbatim from the spec:**
  - Mainnet: `c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d`.
  - Preprod: policy `e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9`, asset name `0014df10745553444d` (the CIP-68 (333) label followed by hex of `tUSDM`).
  - 6 decimals.
- **Payment flow.** Every method is facilitator-submitted with the `authorization` flow: verify, then run the resource handler, then settle. The client signs the complete transaction and **MUST NOT broadcast** it. `extra.paymentFlow` is not emitted for this scheme.
- **Fees:** paid by the client, balanced against its own inputs.
  - `areFeesSponsored` is always `false`. When present in the masumi `extra`, it MUST be `false`.
  - The facilitator needs no funded wallet.
- **Family declarations:**

  | Item | Value |
  |---|---|
  | Fee payer | self-funded payer |
  | Replay primitive | the UTxO named by `payload.nonce`, consumed by the tx |
  | Validity window | tx TTL slot, bounded by `maxTimeoutSeconds` |
  | Duplicate submission | deduplicated by canonical tx id |

## 2. HTTP headers and wire format

| Header | Direction | Content |
|---|---|---|
| `PAYMENT-REQUIRED` | 402 response | base64 of JSON `PaymentRequired` |
| `PAYMENT-SIGNATURE` | client retry | base64 of JSON `PaymentPayload` |
| `PAYMENT-RESPONSE` | 200 response | base64 of JSON settle response |

Encoding **(impl)**: `@x402/core/http` does `safeBase64Encode(JSON.stringify(obj))`. That is standard base64 of the UTF-8 JSON string (`btoa` or `Buffer.toString("base64")`). The legacy v1 headers were `X-PAYMENT` and `X-PAYMENT-RESPONSE`.

`PaymentRequired` has these top-level fields:

- `x402Version: 2`
- `error` (e.g. `"PAYMENT-SIGNATURE header is required"`)
- `resource { url, description, mimeType }`
- `accepts: PaymentRequirements[]`

`PaymentRequirements` fields: `scheme`, `network`, `amount` (atomic units, string), `asset`, `payTo`, `maxTimeoutSeconds` (examples use `600`), `extra`.

`PaymentPayload` (the decoded `PAYMENT-SIGNATURE`) fields:

- `x402Version: 2`
- `resource`
- `accepted`: a copy of the chosen `PaymentRequirements`
- `payload`

`payload` fields for **every** method:

- `transaction`: the signed, **unbroadcast** Cardano tx as base64 CBOR.
- `nonce`: `"txHash#index"`. It MUST be one of the tx inputs. A payload without it MUST be rejected.

`PAYMENT-RESPONSE` decoded:

```js
{
  "success": true,
  "network": "cardano:mainnet",
  "transaction": "2f9a7b3c...",
  "extra": { "status": "confirmed", "confirmations": 1 },
  "errorReason": "Utxo not found in utxo set" // optional, on failure
}
```

How `status` and `confirmations` are reported:

- Before block inclusion: `status: "mempool"`, `confirmations: -1`.
- After inclusion: `status: "confirmed"` and the real depth.
- `success` is `true` only once the depth meets the policy.

## 3. Confirmation policy (all methods)

`extra.confirmationPolicy = { "l1Confirmations": n }`. It is optional and an integer in the range `-1..20`. An absent policy normalizes to `{ "l1Confirmations": 1 }`.

| Value | Meaning |
|---|---|
| `-1` | Facilitator's own broadcast acceptance (authenticated mempool). A facilitator MAY refuse it unless its operator opted in, and MUST NOT wait for block inclusion. |
| `0` | Inclusion in a canonical block. |
| `1..20` | At least that many newer canonical blocks. |

- Greater evidence satisfies a lower threshold.
- The policy is a top-level `extra` field. It is **not** part of Masumi `termsDigest`.
- `/supported` MAY advertise `l1Confirmations: { minimum, maximum }`. A client MUST NOT infer the policy from `/supported`.
- A facilitator that cannot read depth advertises `maximum: 0`. One that has not opted into mempool advertises `minimum: 0`.
- Granting access on `mempool` is "strongly discouraged". A server that does so MUST document the risk and accepts the liability.

Example `/supported` entry, verbatim:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "cardano:preprod",
      "extra": {
        "assetTransferMethods": ["default", "masumi", "script"],
        "areFeesSponsored": false,
        "l1Confirmations": { "minimum": 0, "maximum": 20 }
      }
    }
  ],
  "extensions": [],
  "signers": {}
}
```

## 4. The three `assetTransferMethod`s

The method is selected by `PaymentRequirements.extra.assetTransferMethod`, which is one of `"default" | "masumi" | "script"`. It is optional, and absent means `default`. The spec argues at length that the method is scheme payload semantics, not an x402 extension, because ignoring it strands funds.

### 4.1 `default` (address to address)

- `payTo` is the recipient address.
- `extra` may be empty or carry metadata. The only defined field is `confirmationPolicy`.
- The TS type `CardanoExtraDefault` allows unknown keys **(impl)**.
- No verification beyond the core rules (section 7).

### 4.2 `masumi` (lock into Masumi V2 `vested_pay`)

- Masumi V2 only.
- One requested asset only (`lovelace` or a single native token). There is no multi-fund payment.
- `amount` MUST be a positive canonical decimal string.
- x402 covers **only the initial `FundsLocked` output**. The rest of the lifecycle is out of scope (section 4.2.8).

#### 4.2.1 `extra` fields (closed objects: unknown fields are invalid)

`extra`, `inputCommitment`, every commitment part, `terms`, `confirmationPolicy` and `deployment` are **closed objects**. `terms` **MUST NOT** repeat a field that is projected into `signedTerms` from the top level. `collateral_return_lovelace` is deliberately absent.

| `extra` field | Required | Constraint |
|---|---|---|
| `assetTransferMethod` | yes | literal `masumi` |
| `confirmationPolicy` | no | `{ l1Confirmations }`, `-1..20`, default `1` |
| `inputCommitment` | yes | see 4.2.3 |
| `terms` | yes | see 4.2.2 |
| `referenceKey` | yes | lowercase even-length hex of one complete CBOR `COSE_Key` |
| `referenceSignature` | yes | lowercase even-length hex of one complete CBOR `COSE_Sign1` |
| `blockchainIdentifier` | yes | lowercase even-length hex of the complete LZString-compressed compatibility identifier |
| `areFeesSponsored` | no | boolean; MUST be `false` when present |
| `deployment` | no (omit for the canonical deployment; **required on preview**) | `{ requiredAdmins, adminVkeys, cooldownPeriod }` |
| `deployment.requiredAdmins` | | positive canonical base-10 integer **string**, no greater than `adminVkeys.length` |
| `deployment.adminVkeys` | | ordered non-empty array of 28-byte lowercase hex vkey hashes. Duplicates are preserved and carry voting weight. |
| `deployment.cooldownPeriod` | | non-negative canonical base-10 POSIX-ms integer **string** |

#### 4.2.2 `terms` (closed object)

| Field | Constraint |
|---|---|
| `version` | literal string `"1"` |
| `paymentType` | literal `Web3CardanoV2`. Any other value MUST be rejected. |
| `sellerAddress` | key-credential Cardano address on the selected network (datum `seller`) |
| `sellerReturnAddress` | optional key-credential address. **Omitted** when absent; JSON `null` is invalid. |
| `sellerNonce` | exactly 32 fresh CSPRNG bytes as 64 lowercase hex characters |
| `buyerNonce` | `""`, or 7 to 13 bytes as 14 to 26 even-count lowercase hex characters. Always present. |
| `agentIdentifier` | optional: `null`, `""`, or non-empty even-length lowercase hex registry asset id. Omit for an unregistered seller. |
| `inputHash` | exactly equal to `inputCommitment.digest` |
| `payByTime`, `submitResultTime`, `unlockTime`, `externalDisputeUnlockTime` | positive canonical base-10 POSIX-**millisecond strings**, no leading zero, satisfying the minimums in 4.2.6 |

Buyer nonce rules:

- The initial request MAY omit a buyer nonce. An API defines one nonce source: body, parameters, or an application header.
- The server extracts it again on the paid retry and rejects a mismatch.

Issuer obligations:

- Generate a fresh `sellerNonce` (CSPRNG) for every new requirements object.
- Store the **complete** requirements object keyed by `termsDigest` and reuse it verbatim on the paid retry. Never regenerate the nonce, deadlines, commitment or policies. The first issuance for a digest is authoritative.
- On the retry, before calling the facilitator:
  1. Recompute `termsDigest` from `accepted`.
  2. Compare the object with the stored copy. Reject an unknown digest or an altered object.
  3. Atomically bind the **first** canonical tx id to the digest. The same tx MAY retry; a different tx for the same digest MUST be rejected.

Origin of every `extra` field (the issuer derives all of them):

| Field | Origin |
|---|---|
| `inputCommitment`, `terms.inputHash` | request digest |
| `sellerNonce` | CSPRNG |
| four `*Time` fields | per request, anchored to issuance time |
| `payTo` | derived from `deployment`, never hand-supplied |
| `referenceKey`, `referenceSignature` | seller auth over `termsDigest` |
| `sellerAddress`, `sellerReturnAddress`, `agentIdentifier` | seller configuration |
| `confirmationPolicy` | issuer policy |

The buyer contributes only datum fields that are not in `extra`:

- `buyer`: proven by the payment credential that controls `payload.nonce`.
- `buyer_return_address`: buyer-chosen and never matched.
- `collateral_return_lovelace`: client-computed.

#### 4.2.3 `inputCommitment` (request commitment)

The commitment is built from the content of the buyer's protected-resource request as the issuer received it. It replaces MIP-004's formula `SHA256(identifierFromPurchaser + ";" + canonicalJSON(input_data))`, and **a Masumi Payment Service cannot reproduce an x402 `input_hash` with the MIP-004 formula**.

```js
"inputCommitment": {
  "version": "1",
  "algorithm": "sha256",
  "parts": [ { "name": "body", "canonicalization": "jcs", "mediaType": "application/json",
               "content": { "days": 3, "units": "metric" }, "digest": "<32-byte lowercase hex>" } ],
  "digest": "<32-byte lowercase hex — equals terms.inputHash>"
}
```

Each entry in `parts` is an ordered array item with a unique `name`. Conventional names are `parameters`, `body` and `raw`.

| Part field | Meaning |
|---|---|
| `name` | unique, non-empty |
| `canonicalization` | `jcs` or `raw` |
| `mediaType` | optional, preserved byte for byte |
| `content` | RFC 8785 JSON value (`jcs`) or unpadded base64url string (`raw`) |
| `digest` | lowercase hex `SHA-256(partBytes)`, 64 characters |

How `partBytes` is computed:

- `jcs`: `UTF-8(RFC8785-JCS(content))`.
- `raw`: `base64url-decode(content)`. A `raw` part captures the entity body before parsing, never the full HTTP message.

To build the manifest:

1. Take `inputCommitment`.
2. **Omit** each part's `content` and the top-level `digest`. Do not set them to `null` or empty.
3. Keep every other field and the part order.

```text
inputHash = SHA-256(
  UTF-8("masumi:x402:input:v1\n") ||
  UTF-8(JCS(manifest))
)
```

Content echo:

- `content` is REQUIRED only for issuer-originated parts.
- It is OPTIONAL for parts derived from the client's own request bytes, which the client recomputes.
- The client MUST recompute every digest and MUST present issuer-originated content for approval.
- **(impl)** `toClientCardanoSigner` refuses a 402 that omits content for a part the caller did not supply in `masumiRequestContent`.

Transport rules:

- Servers MUST NOT truncate content or replace it with a URL. They SHOULD return 413 if the header does not fit.
- Servers MUST NOT capture secrets, cookies, auth headers, x402 headers or the whole HTTP request, and MUST NOT log payment headers.

Test vector **(impl, `test/unit/masumiCodec.test.ts`)**: a `raw` part with content `"aGk"` (base64url of `hi`) has digest `8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4`.

#### 4.2.4 `termsDigest` and seller authorization (CIP-8 / COSE)

```text
signedTerms = {
  ...terms,
  scheme:              PaymentRequirements.scheme,
  assetTransferMethod: extra.assetTransferMethod,
  network:             PaymentRequirements.network,
  contractAddress:     PaymentRequirements.payTo,
  amount:              PaymentRequirements.amount,
  asset:               PaymentRequirements.asset,
  maxTimeoutSeconds:   PaymentRequirements.maxTimeoutSeconds
}

termsDigest = SHA-256(
  UTF-8("masumi:x402:terms:v1\n") ||
  UTF-8(JCS(signedTerms))
)
```

- The member list is normative. Changing it breaks the scheme.
- `confirmationPolicy` and `deployment` are **not** in `signedTerms`.
- A custom deployment is bound through `payTo`, because the applied parameters change the script hash inside the address.

Signing:

- The seller calls CIP-30 `signData(sellerAddress, lowercaseHex(termsDigest))`. The result is a CIP-8 `DataSignature`.
- `referenceKey` is the complete CBOR `COSE_Key` as lowercase hex.
- `referenceSignature` is the complete CBOR `COSE_Sign1` as lowercase hex.
- The attached payload is the 32-byte `termsDigest`, `hashed` is `false`, and the external AAD is empty.

Client and facilitator MUST verify:

- `kty = OKP (1)`, `alg = EdDSA (-8)`, `crv = Ed25519 (6)`.
- A 32-byte public key with no private material.
- Protected `COSE_Sign1` headers carry `alg = EdDSA (-8)` and the raw `sellerAddress`.
- An unprotected `hashed = false` header and an empty external AAD.
- An attached payload equal to `termsDigest`.
- A valid Ed25519 `Sig_structure`.
- Equal `kid` values when both are present.
- **`Blake2b-224(publicKey)` equal to the seller's payment-key credential.** This binds the signature to the address and MUST NOT be skipped. A `sellerAddress` with a script payment credential is invalid.

#### 4.2.5 Identity and `blockchainIdentifier`

**Registered seller.** A non-empty `agentIdentifier` is a Masumi registry claim:

- Its first 56 hex characters MUST equal the Masumi V2 registry policy id `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b`.
- Client and facilitator MUST independently validate, on the selected network: the asset, seller authorization, metadata, endpoint, network, and that the registered price equals the signed `amount`/`asset`.
- A registered price that requires more than one asset is invalid.
- **(impl)** A claim is **rejected** unless a `validateRegistryClaim` (facilitator) or `validateMasumiRegistryClaim` (client) validator is supplied.

**Unregistered seller.** An omitted, `null` or empty `agentIdentifier` means unregistered:

- The datum `agent_identifier` is empty bytes.
- The three forms are different signed wire values. Never normalize between them when rebuilding `signedTerms`.

Codec:

```text
agentIdentifierHex  = terms.agentIdentifier when it is a non-empty string, otherwise ""
sellerIdentifierHex = sellerNonceHex + agentIdentifierHex

identifierText =
  sellerIdentifierHex + "." +
  buyerNonceHex + "." +
  referenceSignatureHex + "." +
  referenceKeyHex + "." +
  contractAddressBech32

blockchainIdentifier = hex(LZString.compressToUint8Array(identifierText))
```

- Join the text **before** compression. MUST NOT hex-decode the first four segments.
- Decompression yields five period-delimited segments:
  - The first 64 characters of segment 1 are `sellerNonce`; the remainder is `agentIdentifier`.
  - Segment 2 MAY be empty and MUST be preserved.
- The `lz-string` npm package is the dependency used by the implementation, version `^1.5.0` **(impl)**.

Test vectors (encoding only; the key and signature values are not valid COSE), copied verbatim:

**Vector 1: unregistered seller, empty buyer nonce**

| Field | Value |
|---|---|
| `sellerNonceHex` | `11` repeated 32 bytes |
| `agentIdentifierHex` | empty |
| `buyerNonceHex` | empty |
| `referenceSignatureHex` | `55` repeated 16 bytes |
| `referenceKeyHex` | `a10101` |
| `contractAddressBech32` | `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g` |

`identifierText`:

```text
1111111111111111111111111111111111111111111111111111111111111111..55555555555555555555555555555555.a10101.addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g
```

`blockchainIdentifier`:

```text
230d7c6574f41d1c0acc96ade8eae04360019f607004d8809c07d005c053019cae007700bce8058680d89818c04e44002c035931a2c00daf5e00ac9bf00b6c401b80473c6535d00e6003cb8b110199db615001ca8eecc6019b58076c603b13763a80
```

**Vector 2: registered seller**

| Field | Value |
|---|---|
| `sellerNonceHex` | `22` repeated 32 bytes |
| `agentIdentifierHex` | `aa` repeated 28 bytes, followed by `01` |
| `buyerNonceHex` | `01020304050607` |
| `referenceSignatureHex` | `66` repeated 16 bytes |
| `referenceKeyHex` | `a10102` |
| `contractAddressBech32` | `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g` |

`identifierText`:

```text
2222222222222222222222222222222222222222222222222222222222222222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01.01020304050607.66666666666666666666666666666666.a10102.addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g
```

`blockchainIdentifier`:

```text
130d7c6574f4218314e4b56f46e00602300e972d82c0662c0162c0562c0362c0763d6975b7d8f3b6f3874381e004d0402700fa005c0298067093803b802f19e4a6d05018c02715001601ac154a5006d36680560bb405b4100dc0239611ae64073001eb494192e4700e000e121e70240066610076240c0ae41e400000
```

Decompression MUST return the exact `identifierText`. The issuer returns the identifier; client and facilitator rebuild it and require:

```text
PaymentRequirements.payTo
  == signedTerms.contractAddress
  == decode(blockchainIdentifier).smartContractAddress
  == the transaction's escrow output address
```

#### 4.2.6 Escrow datum `masumi.vested_pay.v2` (19 fields)

The datum is Plutus `Constr 0 [f0 … f18]`, attached as an **inline datum** on the output paying `payTo`.

| # | Field | Plutus type | Value at lock | Source |
|---|---|---|---|---|
| 0 | `buyer` | `Address` | key address whose payment credential controls the `payload.nonce` input | client wallet |
| 1 | `buyer_return_address` | `Option<Address>` | `None` or a buyer key address | client, never declared |
| 2 | `seller` | `Address` | seller key address | `terms.sellerAddress` |
| 3 | `seller_return_address` | `Option<Address>` | `None` or seller key address | `terms.sellerReturnAddress` |
| 4 | `reference_key` | `Bytes` | COSE_Key bytes | `extra.referenceKey` |
| 5 | `reference_signature` | `Bytes` (length ≥ 16) | COSE_Sign1 bytes | `extra.referenceSignature` |
| 6 | `seller_nonce` | `Bytes` | 32 bytes | `terms.sellerNonce` |
| 7 | `buyer_nonce` | `Bytes` | possibly empty | `terms.buyerNonce` |
| 8 | `agent_identifier` | `Bytes` | empty when unregistered | `terms.agentIdentifier` |
| 9 | `collateral_return_lovelace` | `Int` | ≥ 0 | **client calculation** |
| 10 | `input_hash` | `Bytes` | 32 bytes | `terms.inputHash` |
| 11 | `result_hash` | `Bytes` | **empty** | — |
| 12 | `pay_by_time` | `Int` | POSIX ms | `terms.payByTime` |
| 13 | `submit_result_time` | `Int` | POSIX ms | `terms.submitResultTime` |
| 14 | `unlock_time` | `Int` | POSIX ms | `terms.unlockTime` |
| 15 | `external_dispute_unlock_time` | `Int` | POSIX ms | `terms.externalDisputeUnlockTime` |
| 16 | `seller_cooldown_time` | `Int` | `0` | — |
| 17 | `buyer_cooldown_time` | `Int` | `0` | — |
| 18 | `state` | enum | `FundsLocked` = `Constr 0 []` | — |

Plutus Data encodings, verbatim. Addresses MUST NOT be Bech32 text or raw address bytes.

| Type | Plutus Data encoding |
|---|---|
| `Address` | `Constr 0 [paymentCredential, stakeCredentialOption]` |
| payment or stake `VerificationKey` credential | `Constr 0 [Bytes(28-byte key hash)]` |
| payment or stake `Script` credential | `Constr 1 [Bytes(28-byte script hash)]` |
| `Option<Address>.Some(address)` | `Constr 0 [address]` |
| `Option<Address>.None` | `Constr 1 []` |
| stake credential `Some(Inline(credential))` | `Constr 0 [Constr 0 [credential]]` |
| stake credential `Some(Pointer(slot, txIndex, certIndex))` | `Constr 0 [Constr 1 [Int(slot), Int(txIndex), Int(certIndex)]]` |
| stake credential `None` | `Constr 1 []` |
| every byte-string field | `Bytes` of the decoded bytes, not hex text |
| every time, cooldown, lovelace field | `Int` |
| `FundsLocked` | `Constr 0 []` |

`buyer`, `seller` and both return addresses use verification-key payment credentials.

**(impl, README)** Datum addresses are further restricted to two shapes, because Masumi's `getPubKeyAddressDatum` accepts nothing else:

- Enterprise key addresses.
- Base addresses whose payment **and** stake credentials are both key hashes.

The full `vested_pay/State` enum from the Masumi blueprint (fetched) is:

`FundsLocked` 0, `ResultSubmitted` 1, `RefundRequested` 2, `Disputed` 3, `WithdrawAuthorized` 4, `RefundAuthorized` 5.

The `vested_pay/Action` redeemers are:

| Redeemer | Index | Fields |
|---|---|---|
| `Withdraw` | 0 | — |
| `SetRefundRequested` | 1 | — |
| `AuthorizeWithdrawal` | 2 | — |
| `WithdrawRefund` | 3 | — |
| `WithdrawDisputed` | 4 | `buyer_value`, `seller_value`, `admin_signatures` |
| `SubmitResult` | 5 | — |
| `AuthorizeRefund` | 6 | — |

**CBOR test vector** (verbatim), with these inputs:

- Enterprise addresses; `None` for both return addresses.
- buyer payment-key hash `11`×28, seller `22`×28.
- `reference_key` `a10101`, `reference_signature` `55`×16, `seller_nonce` `33`×32.
- Empty `buyer_nonce`, `agent_identifier` and `result_hash`.
- `collateral_return_lovelace` `1435230`, `input_hash` `44`×32.
- Deadlines `1785756000000` / `1785759600000` / `1785763200000` / `1785766800000`.
- Both cooldowns `0`; state `FundsLocked`.

```text
d8799fd8799fd8799f581c11111111111111111111111111111111111111111111111111111111ffd87a80ffd87a80d8799fd8799f581c22222222222222222222222222222222222222222222222222222222ffd87a80ffd87a8043a1010150555555555555555555555555555555555820333333333333333333333333333333333333333333333333333333333333333340401a0015e65e58204444444444444444444444444444444444444444444444444444444444444444401b0000019fc75a1f001b0000019fc7910d801b0000019fc7c7fc001b0000019fc7feea800000d87980ff
```

Decoding and re-encoding MUST preserve the Plutus Data tree. Raw byte equality is not required. The same hex is asserted in `test/unit/masumiDatum.test.ts` **(impl)**, which also asserts this enterprise buyer address encoding:

```text
d8799fd8799f581c11111111111111111111111111111111111111111111111111111111ffd87a80ff
```

That is `Constr 0 [Constr 0 [Bytes], Constr 1 []]`, with indefinite-length lists `9f…ff`.

#### 4.2.7 Lock invariants (facilitator MUST enforce, client SHOULD check)

`vested_pay` runs only on spend, so a bad datum silently strands funds.

- `buyer` and `seller` are **public-key** credential addresses.
- The payment credential in `buyer` controls the `payload.nonce` input, and the tx carries its valid witness.
  - **(impl)** The check is `decoded.vkeyHashes.includes(buyer.payment.hash)`.
- No datum address (buyer, seller, either return address) equals the escrow address. The validator re-parses every output at the script address as a continuation datum, so this would abort every spend path.
- The effective buyer payout target (`buyer_return_address`, else `buyer`) MUST differ from the effective seller payout target (`seller_return_address`, else `seller`). No aggregated payouts.
- `state` is `FundsLocked`, `result_hash` is empty, both cooldowns are `0`, and the escrow output carries **no reference script**.
- **Deadline minimums:**
  - `pay_by_time + 5 min ≤ submit_result_time`
  - `submit_result_time + 15 min ≤ unlock_time`
  - `unlock_time + 15 min ≤ external_dispute_unlock_time`
- At issuance, `pay_by_time` is in the future and ≤ issuance time + `maxTimeoutSeconds`. `submit_result_time` is ≥ 15 minutes in the future.
- Tx validity upper bound (TTL) ≤ `pay_by_time`.
- The datum carries the exact COSE key and signature bytes. `reference_signature` is ≥ 16 bytes.
- The collateral and value rules hold (4.2.8). The escrow output carries **exactly** the requested asset set.
- `seller_return_address` matches the signed terms: declared means present with matching credentials; omitted means `None`. `buyer_return_address` is not matched.
- There is **exactly one** escrow output at `payTo`.

Implementation constants **(impl, `exact/masumi/constants.ts`)**:

| Constant | Value |
|---|---|
| `MASUMI_MIN_PAY_TO_SUBMIT_MS` | `5*60*1000` |
| `MASUMI_MIN_SUBMIT_TO_UNLOCK_MS` | `15*60*1000` |
| `MASUMI_MIN_UNLOCK_TO_DISPUTE_MS` | `15*60*1000` |
| `MASUMI_MIN_SUBMIT_RESULT_LEAD_MS` | `15*60*1000` (issuer-only check; Masumi's own endpoints refuse a closer `submitResultTime`) |
| `MASUMI_MAX_DEADLINE_HORIZON_MS` | 30 days (client ceiling: `WithdrawRefund` is gated on `must_start_after(validity_range, submit_result_time)`) |
| `MASUMI_DEFAULT_MAX_COLLATERAL_LOVELACE` | `15_000_000` (client ceiling against padded COSE bytes) |
| `DEFAULT_MASUMI_DEADLINE_OFFSETS` | submit = payBy + 15 min, unlock = payBy + 35 min, externalDispute = payBy + 55 min |

The issuer default for `payByTime` is `now + maxTimeoutSeconds`.

#### 4.2.8 Collateral, min-UTxO and the 1,435,230 figure

Let `requestedLovelace` be `amount` for a lovelace payment and `0` for a native token. Then:

```text
lockedLovelace = requestedLovelace + collateral_return_lovelace
```

This holds with **exact equality** in the facilitator. Masumi tolerates lovelace overpayment; x402 does not **(impl README)**.

Rules for `collateral_return_lovelace`:

- It MUST be `0` or **≥ 1,435,230**. That is Masumi's `CONSTANTS.MIN_COLLATERAL_LOVELACE` **(impl comment)**.
- `lockedLovelace` MUST clear the protocol min-UTxO of the datum **after `SubmitResult`**, meaning a 32-byte `result_hash` and non-zero cooldowns. Otherwise the seller can never spend.
- For a native-token payment, the collateral MUST be ≥ max(1,435,230, post-`SubmitResult` minimum).
- The token quantity is exact, and there are no other tokens.
- The seller never supplies or signs this value. Client and facilitator compute it independently.

The implementation formula **(impl)**, which mirrors Masumi `calculateMinUtxo`:

```text
masumiMinUtxoLovelace = coinsPerUtxoByte * (lockDatumBytes + 33 + 160 + 50 + 15 + 100 + 50*nativeTokenCount)
collateral = 0 if requestedLovelace >= minUtxo else max(minUtxo - requestedLovelace, 1_435_230)
```

The constants are:

| Constant | Bytes |
|---|---|
| `result_hash` delta (`0x40` to `0x5820…`) | 33 |
| overhead | 160 |
| result-hash buffer | 50 |
| cooldown buffer | 15 |
| safety margin | 100 |
| per token | 50 |

A realistic datum is about 450 bytes and needs at most about 3.7 ADA of collateral (impl comment).

Generic min-UTxO (spec, CIP-55): `minUTxO(output) = (160 + |serialized_output|) * coinsPerUtxoByte`.

- `coinsPerUtxoByte` is currently **4310** lovelace/byte on mainnet and the public testnets. It MUST be read live.
- A pure-lovelace output needs about 1 ADA. A native-asset output needs about 1.2 to 1.5 ADA, paid by the client in addition to the token.

#### 4.2.9 Deployment, escrow address and script hash

The canonical CIP-57 blueprint is `masumi-payment-service@d74b2c319228bcbef36632de37875c388dcee7ce:smart-contracts/payment-v2/plutus.json`.

| Property | Canonical value |
|---|---|
| datum schema | `masumi.vested_pay.v2` |
| CIP-57 validator title | `vested_pay.vested_pay.spend` |
| Plutus version | `v3` |
| blueprint digest | `SHA-256(JCS(blueprint))` = `6249de17bb87c5246106af6b0f33de22b44ca24b9c1445fa36d10eb8b583dec7` |
| default `requiredAdmins` | `2` |
| default ordered `adminVkeys` | `fc16a1fcf309aed03ec18bb2176f5ea29acea70bb79145ebaffa8e75`, `7f78161369549d8e2b138fee724c9fa606d6107a66720bdb4c48ada6`, `89eef9ea84e0ee7fe4921fa93eb2873ff6e34473f751d5d52cb75aa6` |
| default `cooldownPeriod` | `420000` ms |

Hashes and addresses I verified:

| Item | Value | Source |
|---|---|---|
| Un-applied `vested_pay` hash (NOT an escrow address) | `2d6abca32e4b22b59e948ef22dfe682017de917a9ec088aa1bc3c64e` | fetched blueprint; compiler `v1.1.23+8949565`; params `required_admins_multi_sig`, `admin_vks`, `cooldown_period` |
| **Applied default escrow script hash** | `a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad` | impl test `masumiCodec.test.ts` |
| **Preprod escrow address** | `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g` | spec vectors + impl test |
| **Mainnet escrow address** | `addr1wxs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgge2j6d` | impl test |

- Parameters are applied **(impl)** with `UPLC.applyParamsToScript(code, [Data.int(requiredAdmins), Data.list(adminVkeys.map(Data.bytearray)), Data.int(cooldownPeriod)])`. The address is an **enterprise** script address.
- The compiled code is vendored in `@x402/cardano` as `MASUMI_VESTED_PAY_COMPILED_CODE` (`src/exact/masumi/blueprintCode.ts`).
- Exported helpers: `masumiEscrowAddress(network, deployment?)` and `masumiEscrowScriptHash(deployment)`.

Deployment rules:

- **Preview has no canonical default.** It requires `extra.deployment`.
- A custom deployment replaces only the three parameters against the same compiled validator.
- The verifier always derives the address itself and requires it to equal `payTo`.
- An application MUST explicitly allow a non-default parameter set. The seller signature is not approval.

Admin powers:

- Admins can only settle a `Disputed` escrow, through `WithdrawDisputed`, and only after `external_dispute_unlock_time`.
- Each admin CIP-8-signs `blake2b_224(cbor(DisputeWithdrawal { own_ref, buyer_value, seller_value }))`. Anyone may submit.
- `buyer_value` and `seller_value` are **minimums**. The residual goes to the submitter as a finder's fee.
- Duplicate admin keys carry repeated weight. Wallets MUST display the effective weight per distinct key.

#### 4.2.10 Lifecycle boundary

x402 ends at the `FundsLocked` output. The seller then submits a result (`ResultSubmitted`) and the buyer may request a refund (`RefundRequested`). A refund against a submitted result makes the escrow `Disputed`. Release, refund and dispute are driven by Masumi Payment Service, another SDK, or the server's own code.

**(impl README, important)** The seller authorization diverges from Masumi's own:

- `@x402/cardano` signs this scheme's `termsDigest`.
- `masumi-payment-service` verifies `reference_signature` against `SHA-256(stableStringify(signedBlockchainIdentifierPayload))`.

Consequence, quoted verbatim: "**a lock created by this package cannot be driven through a `masumi-payment-service` node.** Masumi tooling can decode the `blockchainIdentifier` and find the UTxO, but its purchase-init check will reject the signature, so result submission, refunds and dispute resolution must be driven by x402-aware tooling holding the seller key."

### 4.3 `script` (lock into any server-defined contract)

`extra` fields:

| Field | Required | Meaning |
|---|---|---|
| `assetTransferMethod` | yes | `"script"` |
| `confirmationPolicy` | no | as above |
| `scriptHash` | one of `scriptHash` / `script` | hash of a script already on chain |
| `script` | one of `scriptHash` / `script` | `{ "type": "plutusV3", "code": "<hex>" }`. `type` is one of `plutusV1`, `plutusV2`, `plutusV3` (impl) |
| `parameters` | no | `{ name: { value, type } }`, applied to the script. Impl types: `bytes`, `bigint`, `integer`, `string`, `constr`, `list`, `map`, `boolean` |
| `datum` | no | **CBOR hex** of the inline datum to attach to the `payTo` output |

- `payTo` is the script address. It must match the script after parameters are applied.
- The TS type allows other free-form keys **(impl)**.

Facilitator rules:

- It MUST verify that `payTo`'s script payment credential equals the hash derived from `script` (+ `parameters`) or `scriptHash`. Otherwise it rejects with `ERR_SCRIPT_ADDRESS_MISMATCH` **(impl)**.
- It **MUST NOT be expected to validate `extra.datum`**. The server owns datum correctness, and a wrong datum strands funds.
- It MAY reject a script payment that has no inline datum.
- It MAY reject `plutusV1` + `datum`: inline datums cannot be spent by V1, and datum-hash outputs are out of scope.

## 5. Replay and dedupe rules

- **Rule 5 (nonce):** `payload.nonce` is `txHash#index`, and it must be an input of the tx.
  - Before submission, the nonce **and every other input** must be unspent.
  - After authenticated ledger acceptance (the pending retry), the check no longer applies.
- **Duplicate settlement (RECOMMENDED):** keep a cache keyed by the **canonical tx id** (hash of the body), never by the signed CBOR.
  1. Insert the key atomically, before the first `await` on submission.
  2. A concurrent duplicate returns the cached or in-flight outcome, or `"duplicate_settlement"`.
  3. Retain each entry until TTL plus the confirmation and rollback grace period. A flat 120 s is too short.
  4. Release a claim only once no submission occurred, or on a definitive ledger rejection. A timeout, transport error, unknown node result or mempool-only result retains the claim.
  5. Multi-instance deployments share a durable atomic store.
- **Masumi logical replay:** tx-id dedupe is insufficient, because different txs can lock for the same 402.
  - The logical key is `termsDigest`, bound atomically to the **first** claimed tx id.
  - A different tx for the same digest is a conflict and MUST NOT start work, even if it lands first.
  - The binding stays after rejection or expiry. A failed payment needs new requirements with a fresh `sellerNonce`.
  - Extra locks are duplicate deposits, recovered only by Masumi refund paths.
- **(impl)** Error codes: `masumi_terms_unknown`, `masumi_terms_mismatch`, `duplicate_settlement`.
  - `InMemoryCardanoSettlementStore` holds 4096 entries by default.
  - `InMemoryMasumiTermsStorage` is process-local. Production must supply `MasumiTermsStorage` with an atomic `updateTerms(termsDigest, current => next)`.

## 6. Pending settlement

- `/settle` broadcasts, waits a bounded time, and returns this if still below policy:

  ```json
  { "success": false, "errorReason": "settlement_pending", "transaction": "<tx id>",
    "extra": { "status": "pending", "transactionId": "<tx id>", "confirmations": 0 } }
  ```

- `@x402/core` retries `settle` **exactly once** with the identical payload. The facilitator resumes observing and MUST NOT rebroadcast.
- If a server surfaces pending as a 402, the client MUST resend the exact original `PAYMENT-SIGNATURE` and MUST NOT build another tx.
- Once the validity window has closed without the tx landing, the result is a terminal failure.
- **(impl)** `confirmationTimeoutMs` defaults to 75 s. The core facilitator-client timeout is 90 s. The TTL grace is 120 s.
- The protected handler MUST tolerate running once per paid retry.

## 7. Facilitator verification rules (all methods)

1. **Network:** the tx is for the declared network.
2. **Recipient:** at least one output pays `payTo`.
3. **Amount:** the output to `payTo` holds ≥ `amount` of `asset`. Policy id and asset name must match exactly.
4. **Asset:** exact unit match. No equivalent-value substitution.
5. **Nonce/replay:** as in section 5.
6. **Phase-1 checks** (the handler may already have run):
   - **Value conservation:** input lovelace and every asset equal outputs plus fee, using authenticated input values.
   - **Fee floor:** `fee >= minFeeB + minFeeA * |transaction|`, from live parameters.
   - **Mint rejection rule:** a tx that moves value the inputs and outputs do not show (**`mint`, `withdrawals`, `certificates`, governance deposits or donations**) MUST be rejected unless the facilitator runs a **complete ledger phase-1 validator**.
   - Plutus evaluation alone is not a substitute.
   - A facilitator without live parameters MAY skip the fee floor.
7. **TTL:** before the first submission, the TTL has not passed and is ≤ slot(now + `maxTimeoutSeconds`). Convert time to slots with system start and the era summary. Never compare seconds to slots or assume 1 slot/s.
8. **Min-UTxO:** the `payTo` output SHOULD hold ≥ `(160 + |serialized_output|) * coinsPerUtxoByte`, read live. A facilitator MAY skip this without live parameters.
9. **Confirmation:** evidence ≥ `l1Confirmations` before releasing the resource. Otherwise report pending.

What the implementation adds **(impl, `exact/facilitator/scheme.ts`)**:

- It rejects unsigned txs (no vkey and no script witnesses).
- It rejects invalid signatures and duplicate inputs.
- `balanceChangingOperations` = `mint`, `withdrawals`, `certificates`, `proposalProcedures`, `donation`. Any of them fails with `ERR_TRANSACTION_PHASE1_INVALID` ("without a complete phase-1 validator only plain payments are accepted") unless the signer implements `validatePhase1Transaction`.
- The payer is resolved from the owner of the nonce UTxO.
- A tx with `is_valid = false` counts as unknown evidence.

**Masumi-specific rules** (all of the following, rechecked by the facilitator):

- Schema (closed objects, `paymentType`).
- Commitment digests.
- Seller COSE authorization, including the Blake2b-224 key-to-address check.
- Escrow address derived from the deployment, equal to `payTo`, `contractAddress` and the identifier address, with exactly one escrow output.
- Identity and registry.
- Inline datum decodes as `masumi.vested_pay.v2`.
- `seller` equals the terms, and `buyer` controls the nonce with a witness.
- No self-addressed payouts, and distinct payout targets.
- Datum fields equal the terms.
- Value and exact asset set.
- Deadline intervals and TTL ≤ `pay_by_time`.
- Settlement evidence.
- Post-`SubmitResult` min-UTxO.

## 8. Implementation limits

An implementation MAY cap any of these, and MUST reject beyond its budget:

- tx size and input count
- script and datum size
- script parameter count
- commitment part count and content size
- admin key count

## 9. Where the `vested_pay` blueprint and hash live

| Item | Location / value |
|---|---|
| Canonical blueprint | https://github.com/masumi-network/masumi-payment-service/blob/d74b2c319228bcbef36632de37875c388dcee7ce/smart-contracts/payment-v2/plutus.json (preamble: `nmkr/masumi-payment`, Plutus v3, Aiken `v1.1.23+8949565`, Apache-2.0) |
| Vendored compiled code | `@x402/cardano` `src/exact/masumi/blueprintCode.ts` (`MASUMI_VESTED_PAY_COMPILED_CODE`) |
| Un-applied hash | `2d6abca32e4b22b59e948ef22dfe682017de917a9ec088aa1bc3c64e` |
| Applied default hash | `a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad` |
| Preprod address | `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g` |
| Mainnet address | `addr1wxs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgge2j6d` |
| Masumi-side constants | `PAYMENT_SMART_CONTRACT_ADDRESS_V2_*` in masumi-payment-service (e.g. `src/utils/v2-contract-sync.ts`, `prisma/seed.ts`); not read further |

---

## Implications for Cascade

1. **Masumi leaves are not "unmodified Masumi agents" when paid over x402.**
   - An x402 `masumi` lock carries a `reference_signature` over x402's `termsDigest`. `masumi-payment-service` rejects that signature, so a stock Masumi node cannot submit results, refund or dispute on such a lock.
   - The PRD's promise that "any existing Masumi agent can be a leaf without changing a line of its code" holds only if Cascade pays those agents through Masumi's **native** MIP-003 `/start_job` + Masumi purchase flow, not through the x402 `masumi` method.
   - Another difference: the x402 `input_hash` is not MIP-004's formula.
2. **A Masumi lock's `buyer` must be a key credential that witnesses the tx and controls `payload.nonce`.**
   - A Draw that pays a Masumi leaf therefore needs an orchestrator-key input as the nonce, and `buyer` equal to that key.
   - Refunds go to `buyer_return_address` or `buyer`, which are key addresses. This confirms PRD P1: money leaves the tree on a Masumi refund.
3. **The standard `@x402/cardano` facilitator rejects any tx that mints, withdraws, or carries certificates, proposals or donations**, unless it runs a full phase-1 validator (`validatePhase1Transaction`).
   - A Draw that mints a thread token cannot be settled by a third-party x402 Cardano facilitator.
   - Paying third-party x402 endpoints from the tree needs a non-minting tx shape, or a key-funded payment.
   - For Cascade's own facilitator, implement `validatePhase1Transaction` against a real node, e.g. Ogmios.
4. **Deadline algebra.**
   - Use 5 / 15 / 15 minute minimums, plus the issuer-side 15-minute lead to `submit_result_time`.
   - TTL ≤ `pay_by_time`, and `pay_by_time` ≤ issuance + `maxTimeoutSeconds`.
   - The implementation defaults are +15 / +35 / +55 min after payBy.
   - Clients refuse horizons above 30 days by default.
5. **Collateral for Masumi leaves.**
   - Always compute `collateral_return_lovelace` from the final datum size and live `coinsPerUtxoByte`.
   - It is 0 or ≥ 1,435,230, with **exact** `lockedLovelace` equality.
   - A native-token (USDM) leaf always needs structural lovelace ≥ max(1,435,230, post-SubmitResult min-UTxO).
6. **`masumi_script_hash` for the Cascade root must be the applied hash `a15ce9d8…14ad`** (canonical deployment, preprod and mainnet), not the un-applied blueprint hash. Preview needs an explicit deployment.
7. **The `script` method fits native Cascade children.**
   - `extra` is free-form, apart from `scriptHash`/`script`, `parameters` and `datum`.
   - The facilitator checks only the script address, never the datum. The Cascade facilitator must add its own datum checks.
   - Any `cascade`-specific `extra` keys are allowed under `script`, but **not** under `masumi`, whose objects are closed.
8. **Settlement UX.**
   - Default `l1Confirmations: 1`. Expect about 20 s blocks, a 75 s settle wait, one automatic retry, and `settlement_pending`.
   - The per-node state machine must treat pending as non-terminal.
