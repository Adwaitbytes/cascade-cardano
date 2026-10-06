# Masumi Registry (digest)

## Sources

| Source | Pin |
|---|---|
| `masumi-network/masumi-registry-service` | commit `3b85e18226b0287c14adf74580c79d8baa86a040` |
| `masumi-network/masumi-payment-service` `smart-contracts/registry-v2/*`, `packages/payment-source-v2/src/services/registry/register/service.ts` | commit `69297f308f603bffbdfd4efccb54398eaff1bd87` |
| `masumi-network/masumi-improvement-proposals` `MIPs/MIP-002/MIP-002.md` | commit `087a1d5d42c7b4f97b2590665321af423514337e` |
| `masumi-network/masumi-docs` (`register-agent.mdx`) | commit `020c3b47153bc110b9d1c6f60cf957aadac25c8c` |
| Live checks on 2026-10-01: Koios preprod `policy_asset_list` and `policy_asset_info`, and the public registry `POST https://registry.masumi.network/api/v1/registry-entry/` | results quoted below |

## V2 registry policy id: **verified**

PRD value: `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b`. It is **correct**. The same value appears in all of these places:

- `smart-contracts/registry-v2/plutus.json`: validator `mint.mintUnique.mint`, `hash: 67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b`. The validator takes no parameters, so this hash is the policy id. Compiler: Aiken `v1.1.23+8949565`, Plutus V3.
- Payment service `DEFAULTS.REGISTRY_POLICY_ID_V2_PREPROD` and `_MAINNET`: both are the same value.
- Registry service `src/utils/config/index.ts`: `REGISTRY_POLICY_ID_PREPROD_V2` and `_MAINNET_V2` are the same value. Its comment reads: "The V2 registry validator is unparameterized, so the policy hash is identical on both networks … Bumped from 7890b485... when the V2 contract was recompiled with Aiken v1.1.23".
- Live on preprod: Koios `policy_asset_info?_asset_policy=67ab0c92…` returns minted assets. The public registry service returns V2 `agentIdentifier`s that start with `67ab0c92…`.

Other policies:

- V1 preprod: `7e8bdaf2b2b919a3a4b94002cafb50086c0c845fe535d07a77ab7f77`
- V1 mainnet: `ad6424e3ce9e47bbd8364984bd731b41de591f1d11f6d7d43d0da9b9`
- Superseded V2 (compiled with v1.1.21): `7890b485b808043ef80136a447a3a43c18893a309dc323d1f8b0a13d`

## Registry-v2 minting policy rules (`validators/mint.ak`)

Redeemer `Action`: `MintAction` = 0, `UpdateAction` = 1, `BurnAction` = 2.

Asset name is exactly 32 bytes:

```
nonce(1B, must be > 0x0f) ++ root_hash(28B) ++ version(3B big-endian)
```

- `root_hash = blake2b_224(tx_id ++ output_index as 4-byte big-endian)` of an input that the tx **consumes**.
- A mint must have `version == 000000` and quantity 1.
- **UpdateAction** burns and re-mints in the same tx. The new asset keeps the same `nonce ++ root_hash`, and its version must be exactly `old version + 1`. Burned count must equal minted count, and burns must be at least 1.
- **BurnAction**: every entry under the policy has quantity -1.
- **Trust model: the policy is permissionless (by design).** Any wallet can mint. The README says integrators "MUST apply an off-chain allowlist". Do not filter by `policyId` alone. Filter `(policyId, asset_name)` against a known-good list, for example the operator's `GET /api/v1/registry`, or scope by known selling-wallet vkeys. Whoever holds the NFT has update authority.

## `agentIdentifier`

`agentIdentifier = policyId ++ assetNameHex`. The payment service builds it as `policyId + assetName`. For V2 it is 120 hex chars. A live example is `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b10cd38ffab5befab1b5e96b6bbe3ac948166da5a98b3856f3d33c2edbc000000`.

## Metadata: CIP-25 label `721`

The registry uses **CIP-25** (label `721`), not CIP-68. The nonce rule (`> 0x0f`) exists specifically so that asset names cannot look like CIP-67/68 labels. The tx metadata shape is:

```json
{ "721": { "version": "1", "<policyId>": { "<assetNameHex>": { ...agent metadata... } } },
  "674": { "msg": ["Masumi", "RegisterAgent"] } }
```

Strings longer than 60 bytes are split into arrays of chunks of at most 60 bytes. See `stringToMetadata` (`MAX_METADATA_STRING_BYTES = 60`). By default it **always** emits arrays, even for short strings. Readers must accept `string | string[]` and join the parts. MIP-002 describes this as "Cardano limits single strings to 63 chars" (the ledger's actual limit is 64 bytes).

### V2 metadata (`metadata_version: "2"`): what the service mints and the registry parses

This is the strict zod schema `web3CardanoV2MetadataSchema` in `masumi-registry-service/src/services/cardano-registry/web3-cardano-v2-metadata.ts`. It uses `.strict()`, so unknown keys are rejected. `S` below means `string | string[]`.

| Key | Required | Type |
|---|---|---|
| `name` | yes | S |
| `description` | no | S |
| `type` | no | string. Absent means Standard. OpenAPI and X402 entries set it. |
| `api_base_url` | no (required in practice for Standard/MIP-003 agents) | S |
| `openapi_spec_url` | no | S |
| `x402_resources_url` | no | S |
| `example_output` | no | `[{ name: S, mime_type: S, url: S }]` |
| `capability` | no | `{ name: S, version: S }` |
| `author` | **yes** | `{ name: S, contact_email?: S, contact_other?: S, organization?: S }` |
| `legal` | no | `{ privacy_policy?: S, terms?: S, other?: S }` |
| `tags` | **yes** | `string[]`, at least 1, each non-empty |
| `image` | **yes** | S. The payment service always writes `DEFAULTS.DEFAULT_IMAGE = ipfs://QmXXW7tmBgpQpXoJMAMEXXFe9dyQcrLFKGuzxnHDnbKC7f`. |
| `metadata_version` | **yes** | coerced int, must equal `2` |
| `supported_payment_sources` | **yes** | array of 1..25 `{ chain: S, network: S, settlement?: { paymentSourceType?: S, address?: S, scheme?, payTo?, resource?, extra? }, pricing?: { pricingType: S, fixed?: [{asset: S, amount: S, decimals?: S}], dynamic?: [{asset: S, decimals?: S}] } }` (strict) |
| `verifications` | no | `[{ method: S, schemaVersion?, issuer?, schema?, credential?, holder?, baseUrl? }]` |

Notes on V2 pricing:

- V2 has **no** top-level `agentPricing`. Pricing is set per entry in `supported_payment_sources`.
- In `fixed`, `asset` is `""` for lovelace. Otherwise it is policyId+assetName hex. `amount` is a decimal string of atomic units, and there can be at most 5 fixed prices.
- For Cardano sources, `settlement.address` is the escrow contract address and `settlement.paymentSourceType` is `"Web3CardanoV2"`.
- The registry marks an entry `paymentType = Web3CardanoV2` if any Cardano source has Fixed or Dynamic pricing. Otherwise it marks it `None`.

Live preprod example, decoded from Koios `policy_asset_info` (`minting_tx_metadata`):

```json
{"name":["Basic Test Agent"],"tags":["basic","test"],
 "image":["ipfs://QmXXW7tmBgpQpXoJMAMEXXFe9dyQcrLFKGuzxnHDnbKC7f"],
 "legal":{"other":["…"],"terms":["https://example.com/terms/…"],"privacy_policy":["https://example.com/privacy/…"]},
 "author":{"name":["E2E Test Suite"],"organization":["Masumi E2E Tests"],"contact_email":["…"]},
 "capability":{"name":["GPT-4 Test Model"],"version":["1.0.0"]},
 "description":["Simple agent for basic functionality testing"],
 "api_base_url":["https://api.testagent-….com"],
 "example_output":[{"url":["…"],"name":["…"],"mime_type":["application/json"]}],
 "metadata_version":"2",
 "supported_payment_sources":[{"chain":["Cardano"],"network":["Preprod"],
   "pricing":{"fixed":[{"asset":"","amount":"500000"}],"pricingType":"Fixed"},
   "settlement":{"address":["addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37","w4g"],
                 "paymentSourceType":["Web3CardanoV2"]}}]}
```

The contract address in that example is split into 60-byte chunks.

### V1 metadata (`metadata_version: 1`, MIP-002)

MIP-002 fields:

- Required: `name`, `api_url`, `tags` (at least 1, max 63 chars each), `agentPricing: [{pricingType:"Fixed", fixedPricing:[{amount, unit}]}]`, `metadata_version: 1`.
- Optional: `description`, `example_output`, `capability`, `author`, `legal`, `image`.

The registry service's V1 parser accepts `metadata_version` equal to 1 only. The PRD field list ("name, API base URL, capability tags, pricing, author, legal and image") mixes the V1 and V2 vocabularies:

- V2 uses `api_base_url` and per-source `pricing`.
- V1 uses `api_url` and `agentPricing`.

The `register-agent.mdx` docs example uses `api_url`, `requests_per_hour`, `pricing:[{quantity, unit}]`, and `author.contact`. That example matches neither parser and looks stale.

## Querying the registry

### Via the Registry Service (REST)

- Base: `http://localhost:3000/api/v1`. The public test instance is `https://registry.masumi.network/api/v1`.
- The README says the public instance is "only meant to be used for testing and development purposes … Please do not use this in production". Its public API key is `public-test-key-masumi-registry-c23f3d21`.
- Auth header: `token`.

Routes (`src/routes/api/index.ts`):

- `POST /registry-entry/`, `POST /registry-entry-search/`, `POST /registry-entry-refresh/`, `GET /registry-entry-spec/`, `POST /registry-diff/`
- `GET /capability/`, `GET /payment-information/`
- `GET|POST|PATCH|DELETE /registry-source/`, `GET|POST|PATCH|DELETE /api-key/`, `GET /api-key-status/`
- inbox-agent routes, `GET /health/`

`POST /registry-entry/` body: `{ network: "Preprod"|"Mainnet", limit?: 1..50 (default 10), cursorId?: string, filter?: { paymentTypes?: PaymentType[] (max 5), policyId?: string, assetIdentifier?, … } }`.

Verified live:

```
curl -X POST https://registry.masumi.network/api/v1/registry-entry/ \
  -H 'token: public-test-key-masumi-registry-c23f3d21' -H 'Content-Type: application/json' \
  -d '{"network":"Preprod","limit":1}'
```

This returns `{status:"success", data:{entries:[{name, description, status:"Online", apiBaseUrl, agentIdentifier:"67ab0c92…", paymentType, tags, uptimeCount, …}]}}`.

Running the service yourself:

- Env: `DATABASE_URL`, `Admin_KEY`, `Blockfrost_API_KEY`, `REGISTRY_SOURCE_NETWORK`.
- **It requires Blockfrost.** Sync uses `getScriptsRedeemers(policyId)`, then `blockfrost.txsUtxos`, then `blockfrost.assetsById(asset).onchain_metadata`.
- It polls every 2 minutes and does availability checks.

### Directly from chain without the service

**Koios (keyless) was verified on preprod on 2026-10-01:**

```
# all assets under the policy (asset_name, fingerprint, total_supply; total_supply "0" = burned)
GET https://preprod.koios.rest/api/v1/policy_asset_list?_asset_policy=67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b

# assets with minting_tx_metadata (the 721 payload), mint_cnt, burn_cnt, minting_tx_hash
GET https://preprod.koios.rest/api/v1/policy_asset_info?_asset_policy=67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b
```

Filter to `total_supply == "1"` to drop burned or superseded entries. For updates (version bumps), take the highest 3-byte version for each `nonce ++ root_hash` prefix.

The registry-v2 example scripts also read metadata through Koios:

- `KoiosProvider.fetchAssetMetadata(assetId)`
- `POST tx_metadata {_tx_hashes:[…]}`, then read `["721"][policyId][assetName]`

**Blockfrost (needs `project_id`).** This is the path the registry service uses: `/scripts/{policy}/redeemers` → `/txs/{hash}/utxos` → `/assets/{unit}` (`onchain_metadata`). Blockfrost's standard `GET /assets/policy/{policy_id}` also lists assets. That endpoint is Blockfrost's own API; I did not exercise it here.

**Security:** because the policy is permissionless, anything read straight from chain is **untrusted**. Apply an allowlist, for example cross-check `(policyId, assetName)` against a trusted registry service or known seller vkeys, before you trust `api_base_url` or pricing.

## Registering

The payment service `POST /registry` (see `masumi-payment-service.md` §4) needs a running payment service with a Blockfrost key.

The permissionless alternative is to mint directly with a funded wallet through Koios, using `smart-contracts/registry-v2/mint-example.mjs`. Its default metadata is **not** the V2 schema, so replace it with the V2 metadata above; otherwise the registry service will not index it as a V2 agent.

The docs link the Masumi Explorer at `https://explorer.masumi.network/?network=preprod`.
