# x402 TypeScript packages: digest

Sources:

- `x402-foundation/x402` at commit `6b6ee91fee027b540faabcb25774e73851006c3b` (main, 2026-09-29), directory `typescript/packages/**`.
- npm registry, queried 2026-10-01 with `npm view`.
- The hosted facilitator at `https://x402.org/facilitator/supported`, queried 2026-10-01.

## 1. Published packages and versions

All v2 packages are on **2.28.0** (`latest`, published 2026-09-29). The legacy v1 packages are frozen at 1.2.0.

| npm package | Latest | Repo path | Role |
|---|---|---|---|
| `@x402/core` | 2.28.0 | `typescript/packages/core` | protocol types, `x402Client`, `x402ResourceServer`, `x402Facilitator`, HTTP helpers, `HTTPFacilitatorClient` |
| **`@x402/cardano`** | **2.28.0** (all versions: `2.26.0`, `2.27.0`, `2.28.0`) | `typescript/packages/mechanisms/cardano` | Cardano `exact` scheme: client, server, facilitator |
| `@x402/fetch` | 2.28.0 | `typescript/packages/http/fetch` | `fetch` wrapper |
| `@x402/axios` | 2.28.0 | `http/axios` | axios interceptor |
| `@x402/express` | 2.28.0 | `http/express` | Express middleware |
| `@x402/hono` | 2.28.0 | `http/hono` | Hono middleware |
| `@x402/next` | 2.28.0 | `http/next` | Next.js |
| `@x402/fastify` | 2.28.0 | `http/fastify` | Fastify |
| `@x402/paywall` | 2.28.0 | `http/paywall` | browser paywall UI |
| `@x402/mcp` | 2.28.0 (also `alpha` 2.3.0-alpha) | `packages/mcp` | MCP transport |
| `@x402/extensions` | 2.28.0 | `packages/extensions` | Bazaar etc. |
| `@x402/evm` | 2.28.0 | `mechanisms/evm` | (other chains: svm, avm, aptos, …) |
| `x402`, `x402-fetch`, `x402-express`, `x402-hono` | 1.2.0 | `packages/legacy/*` | v1 legacy. Do not use. |

`@x402/cardano@2.28.0` details:

- Dependencies: `@x402/core ~2.28.0`, `@evolution-sdk/evolution ^0.5.9` (pure-TS Cardano serialization, no WASM), `@noble/hashes ^2.2.0`, `lz-string ^1.5.0`.
- License: Apache-2.0.
- The workspace requires Node `>=22.0.0`.
- Changelog: 2.26.0 was "Implement x402 v2 protocol support for the Cardano mechanism (exact scheme)". 2.27.0 and 2.28.0 are dependency bumps.

**Cardano coverage by language.**

- **Cardano `exact` is published and implemented in TypeScript.** It supports all three methods: `default`, `masumi` and `script`.
- There is no Cardano implementation under `python/`, `go/` or `java/`. I grepped for "cardano" and found no matches.
- **The hosted x402.org facilitator does NOT support Cardano.** Its `/supported` networks on 2026-10-01 were `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe`, `aptos:2`, `base-sepolia`, `eip155:84532`, `hedera:testnet`, `solana-devnet`, `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, `stellar:testnet` and `xrpl:1`. You must run your own Cardano facilitator.

## 2. `@x402/cardano` entry points

| Import | Exports |
|---|---|
| `@x402/cardano/exact/client` | `ExactCardanoScheme` (client): `new ExactCardanoScheme(signer: ClientCardanoSigner)` |
| `@x402/cardano/exact/server` | `ExactCardanoScheme` (server): `new ExactCardanoScheme(config?: ExactCardanoServerConfig)`; also `MasumiQuoteIssuer`, `DEFAULT_MASUMI_DEADLINE_OFFSETS`, `InMemoryMasumiTermsStorage`, `isMasumiTemplate`, `assertMasumiTemplate`, `paymentPayloadFromTransportContext` |
| `@x402/cardano/exact/facilitator` | `ExactCardanoScheme` (facilitator): `new ExactCardanoScheme(signer: FacilitatorCardanoSigner, config?: ExactCardanoFacilitatorConfig)`; `supportedCardanoNetworks`, `InMemoryCardanoSettlementStore`, types `CardanoSettlementStore`, `CardanoSettlementClaim` |
| `@x402/cardano` (root) | everything else, listed below |

Root exports:

- **Reference signers:** `toClientCardanoSigner`, `toFacilitatorCardanoSigner`, `toMasumiSellerSigner`, `blockfrostQueries`, `withCardanoProviderTimeout`.
- **Masumi helpers:** `masumiEscrowAddress`, `masumiEscrowScriptHash`, `resolveMasumiDeployment`, `MASUMI_DEFAULT_DEPLOYMENT`, `MASUMI_BLUEPRINT_DIGEST`, `MASUMI_VALIDATOR_TITLE`, `MASUMI_DATUM_SCHEMA_VERSION`, `MASUMI_REGISTRY_POLICY_ID`, `MASUMI_MIN_COLLATERAL_LOVELACE`, `masumiMinUtxoLovelace`, `masumiCollateralLovelace`, `masumiDeadlineIntervalsHold`.
- **Masumi datum, identifier and digest functions** from `exact/masumi/{datum,digests,identifier,issue}`, including `issueMasumiRequirements`, `verifySellerTermsSignature`, `buildMasumiLock`, `validateMasumiExtra`, `verifyMasumiAuthorization`, `verifyMasumiLock`, `jcs`, `jcsBytes`.
- **Script method:** `buildScriptDatumInline`.
- **Types:** `ExactCardanoPayload`, `CardanoExtra*`, `MasumiTerms`, `MasumiDeployment`, etc.
- **Constants:** `CARDANO_MAINNET_CAIP2 = "cardano:mainnet"`, `CARDANO_PREPROD_CAIP2`, `CARDANO_PREVIEW_CAIP2`, the CIP-34 aliases, `normalizeCardanoNetwork`, `USDM_*`, `LOVELACE_ASSET`, `ASSET_TRANSFER_METHOD_{DEFAULT,MASUMI,SCRIPT}`.
- **Other:** `DEFAULT_ASSETS`, `getDefaultAsset`, `findDefaultAsset`, and the policy helpers.

### 2.1 Signer interfaces

`ClientCardanoSigner`:

```ts
interface ClientCardanoSigner {
  getAddress(): string;
  buildAndSignPaymentTransaction(input: ClientCardanoSignInput):
    Promise<ClientCardanoSignResult> | ClientCardanoSignResult;
}
interface ClientCardanoSignInput { network: string; payTo: string; asset: string; amount: string;
  maxTimeoutSeconds: number; extra?: Record<string, unknown>; resource?: ResourceInfo; }
interface ClientCardanoSignResult { transaction: string /* base64 CBOR, NOT broadcast */; nonce: string /* txHash#index, must be an input */; }
```

`FacilitatorCardanoSigner` has these required methods:

- `getAddresses()`
- `getUtxo(ref, network) -> { exists, address?, coin?, assets?, paymentKeyHash? }`
- `getCurrentSlot(network)`
- `submitTransaction(txB64, network) -> { txHash, status: "confirmed" | "mempool" }`

Its optional methods:

| Method | Purpose |
|---|---|
| `validatePhase1Transaction(txB64, network)` | full ledger phase-1 validator; the **only way to accept `mint`/`withdrawals`/`certificates`** |
| `isDefinitiveSubmissionRejection(err)` | classifies a submission error as a definitive rejection |
| `waitForConfirmation(txHash, network)` | waits for confirmation |
| `evaluateTransaction(txB64, network)` | Plutus dry-run only |
| `getTransactionEvidence(txHash, network) -> { status: "unknown" \| "mempool" \| "confirmed", confirmations }` | required for `l1Confirmations > 0` and to resume `settlement_pending` |
| `getProtocolParameters(network) -> { coinsPerUtxoByte, minFeeCoefficient, minFeeConstant }` | enables the fee-floor and min-UTxO checks |

Reference signer factories (built on Evolution SDK):

- **Provider config:** `CardanoProviderConfig` is either `{ blockfrost: { baseUrl, projectId? } }` or `{ koios: { baseUrl, token? } }`, plus an optional `requestTimeoutMs` (1 to 120000, default 10 s).
- **`toClientCardanoSigner({ mnemonic, network, provider, accountIndex?, … })`.** Its Masumi options are `masumiBuyerInput`, `validateMasumiRegistryClaim`, `masumiRequestContent`, `validateCustomMasumiDeployment`, `masumiMaxCollateralLovelace` and `masumiMaxDeadlineHorizonMs`.
  - It picks a wallet UTxO as the nonce and sets TTL from `maxTimeoutSeconds`.
  - For `script` it attaches `extra.datum` inline. For `masumi` it builds the full 19-field lock datum.
- **`toFacilitatorCardanoSigner({ network, provider, mnemonic?, accountIndex?, awaitConfirmation? = true, validatePhase1Transaction? })`.**
  - `mnemonic` is optional. The facilitator needs no funds.
  - Only Blockfrost supplies `getTransactionEvidence`. With Koios, `/supported` advertises `l1Confirmations.maximum = 0`, so routes must set `confirmationPolicy` explicitly.
- **`toMasumiSellerSigner({ mnemonic, network, … })`** returns `{ sellerAddress, signTerms }`. It CIP-8-signs `termsDigest`.

### 2.2 Facilitator config (`ExactCardanoFacilitatorConfig`)

| Field | Default | Meaning |
|---|---|---|
| `settlementStore` | `InMemoryCardanoSettlementStore` (4096 entries) | tx-id dedupe; share it across replicas |
| `acceptMempool` | `false` | allow settling `l1Confirmations: -1` |
| `confirmationTimeoutMs` | `75_000` | wait per `settle()` before `settlement_pending` |
| `confirmationPollMs` | `5_000` | poll interval |
| `validateRegistryClaim` | none | without it, a non-empty `agentIdentifier` is rejected |
| `validateCustomMasumiDeployment` | none | approves a non-canonical deployment |

The server-side `HTTPFacilitatorClient` timeout defaults to **90 s** (`@x402/core`).

**Extending the facilitator.** `runMethodSpecificChecks(requirements, decoded, ctx)` is `protected`. To add a custom method, subclass and call `super.runMethodSpecificChecks(...)`. An unknown method otherwise fails with `ERR_UNSUPPORTED_SCHEME`. `verify` also hard-requires `scheme === "exact"` and `x402Version === 2`.

### 2.3 Server config (`ExactCardanoServerConfig`)

- `masumiStorage?: MasumiTermsStorage`
  - Default: process-local `InMemoryMasumiTermsStorage`.
  - Production needs an atomic shared store with `updateTerms(termsDigest, current => next)`.
- `masumi?: MasumiIssuerConfig`, with these fields:
  - `seller` (a `MasumiSellerSigner` or a per-network resolver)
  - `sellerReturnAddress?`
  - `agentIdentifier?`
  - `deployment?`
  - `commitment?(ctx) => MasumiCommitmentInput[]`. The default commits only to the resource URL.
  - deadline offsets. Defaults: submit = payBy + 15 min, unlock = payBy + 35 min, dispute = payBy + 55 min, with `payByTime = now + maxTimeoutSeconds`.
- `paymentFlows`: `default`, `masumi` and `script` are each `{ supported: ["authorization"], default: "authorization" }`. `defaultAssetTransferMethod = "default"`.
- `parsePrice`: `"$0.10"` and `"0.10 USDM"` resolve to the network's USDM. `lovelace` needs explicit `{ amount, asset: "lovelace" }`.
- **Route template for Masumi** (verbatim from the README): `extra: { assetTransferMethod: "masumi" }`, `payTo: masumiEscrowAddress("cardano:preprod")`, `price: { amount: "5000000", asset: "lovelace" }`, `maxTimeoutSeconds: 600`. The scheme issues a fresh signed quote per 402 via `enrichPaymentRequiredResponse`, and binds the paid retry in `onAfterVerify`.
- A route with a Masumi template must offer a single Cardano network. Every unpaid 402 signs a fresh quote, so **rate-limit anonymous Masumi routes**.

## 3. Core APIs (client / server / facilitator)

### 3.1 Client

```ts
import { x402Client } from "@x402/core/client";            // also re-exported by @x402/fetch
import { wrapFetchWithPayment, wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { toClientCardanoSigner } from "@x402/cardano";

const client = new x402Client().register("cardano:*", new ExactCardanoScheme(toClientCardanoSigner({ mnemonic, network: "cardano:preprod", provider })));
const fetchWithPay = wrapFetchWithPayment(fetch, client);   // (fetch, x402Client | x402HTTPClient)
```

`x402Client` methods:

- `register(network, SchemeNetworkClient)`. Wildcards like `"cardano:*"` are allowed; a specific network wins.
- `registerV1`, `registerPolicy(policy)`, `setSpendControls(controls | false)`, `registerExtension`.
- Hooks: `onBeforePaymentCreation` (return `{ abort: true, reason }` to cancel), `onAfterPaymentCreation`, `onPaymentCreationFailure`, `onPaymentResponse`.
- `createPaymentPayload`, `handlePaymentResponse`.
- `x402Client.fromConfig({ schemes: [{ network, client }], spendControls, policies, paymentRequirementsSelector })`.

`x402HTTPClient` (from `@x402/core/http` or `/client`):

- `getPaymentRequiredResponse(getHeader, body)`
- `encodePaymentSignatureHeader(payload)` returns `{ "PAYMENT-SIGNATURE": … }`
- `getPaymentSettleResponse(getHeader)`

**Spend controls.** The default cap is `"$1"` on recognised USD assets. Cardano's `findDefaultAsset` knows USDM only. **`lovelace` is not a default asset**, so paying in ADA needs `spendControls.allowedAssets` (e.g. `[{ network: "cardano:preprod", asset: "lovelace", maxAmountPerPayment: "…" }]`) or `spendControls: false`.

### 3.2 Resource server middleware

```ts
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, paymentMiddlewareFromConfig } from "@x402/express"; // or "@x402/hono"
import { ExactCardanoScheme } from "@x402/cardano/exact/server";

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL }))
  .register("cardano:*", new ExactCardanoScheme({ masumi: { seller } }));
app.use(paymentMiddleware(routes, server /*, paywallConfig?, paywall?, syncFacilitatorOnStart = true */));
```

- Signatures (Express and Hono are identical):
  - `paymentMiddleware(routes, server, paywallConfig?, paywall?, syncFacilitatorOnStart = true)`
  - `paymentMiddlewareFromConfig(routes, facilitatorClients?, schemes?: {network, server}[], paywallConfig?, paywall?, syncFacilitatorOnStart = true)`
  - `paymentMiddlewareFromHTTPServer(httpServer, …)`
  - `setSettlementOverrides(res|c, overrides)`
  - `ExpressAdapter` / `HonoAdapter`
- Route config shape: `{ "METHOD /path": { accepts: { scheme, network, payTo, price, maxTimeoutSeconds?, extra? } | [...], description?, mimeType? } }`.
- `x402ResourceServer` hooks: `onBeforeVerify`, `onAfterVerify`, `onBeforeSettle`, `onAfterSettle`, and more.
- The server retries `settle` once on `settlement_pending`.
- The server calls the facilitator's `/supported` on `initialize()`. The scheme may reject an unsupported `confirmationPolicy` via `validateFacilitatorSupport`.

### 3.3 Facilitator

```ts
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactCardanoScheme } from "@x402/cardano/exact/facilitator";
import { toFacilitatorCardanoSigner } from "@x402/cardano";

const facilitator = new x402Facilitator()
  .register("cardano:preprod", new ExactCardanoScheme(toFacilitatorCardanoSigner({ network: "cardano:preprod", provider, awaitConfirmation: false })));
```

- `x402Facilitator` methods:
  - `register(networks, SchemeNetworkFacilitator)`, `registerExtension`
  - `getSupported()`
  - `verify(payload, requirements)`, `settle(payload, requirements)`
  - hooks: `onBeforeVerify`, `onAfterVerify`, `onVerifyFailure`, `onBeforeSettle`, `onAfterSettle`, `onSettleFailure`
- **Core ships no HTTP server for the facilitator.** The example (`examples/typescript/facilitator/advanced/all_networks.ts`) wires Express routes itself:
  - `POST /verify` and `POST /settle` take body `{ paymentPayload, paymentRequirements }`.
  - `GET /supported`
  - `GET /health`

## 4. Registering a custom scheme or network

Implement the core interfaces in `@x402/core` `src/types/mechanisms.ts` and register them with a network pattern.

`SchemeNetworkClient`:

- `scheme`
- `findDefaultAsset?`
- `createPaymentPayload(x402Version, requirements, ctx?) -> { x402Version, payload, extensions? }`

`SchemeNetworkServer`:

- `scheme`
- `defaultAssetTransferMethod`
- `paymentFlows: Record<atm, { supported: ("authorization"|"upfront"|"escrow")[], default }>`. Every ATM the scheme accepts must appear here.
- `parsePrice(price, network)`
- `enhancePaymentRequirements(req, supportedKind, extensions)`
- optional: `enrichPaymentRequiredResponse`, `enrichSettlementPayload`, `enrichSettlementResponse`, `settleOnCancel`, `getAssetDecimals`, `validateFacilitatorSupport`, `schemeHooks`, `dynamicExtraFields`

`SchemeNetworkFacilitator`:

- `scheme`
- `caipFamily` (e.g. `"cardano:*"`)
- `getExtra(network)`, whose output appears as the `/supported` kind `extra`
- `getSigners(network)`
- `verify(payload, req, ctx?)` and `settle(payload, req, ctx?)`

Register each with `client.register(network, impl)`, `server.register(network, impl)` or `facilitator.register(networks, impl)`. The `Network` type is `` `${string}:${string}` ``, and wildcards like `"cardano:*"` are allowed.

**A new `assetTransferMethod` inside Cardano `exact`** (e.g. a Cascade-specific one) needs changes in three places:

1. **Server:** a subclass or wrapper of the server `ExactCardanoScheme` that adds the ATM to `paymentFlows`. The built-in object lists only `default`, `masumi` and `script`.
2. **Facilitator:** a subclass overriding `runMethodSpecificChecks` and calling `super`.
3. **Client:** a `ClientCardanoSigner` that honours the new `extra`.

The alternative is to use the existing `script` method, whose `extra` accepts arbitrary extra keys, together with a custom facilitator.

A wholly new scheme name (e.g. `batch-settlement`) is registered the same way. `loveaihq/subbit-x402` does exactly this against `@x402/core` 2.27.0 (see `subbit.md`).

## 5. Behaviours worth knowing

- **What the facilitator's `verify` rejects.** These are all tx types that `@x402/cardano` will not settle without a full `validatePhase1Transaction`:
  - Any tx carrying `mint`, `withdrawals`, `certificates`, `proposalProcedures` or `donation` (`ERR_TRANSACTION_PHASE1_INVALID`).
  - Unsigned txs.
  - Invalid vkey signatures.
  - Duplicate inputs.
  - Spent inputs.
  - A TTL beyond now + `maxTimeoutSeconds`.
  - Value not conserved.
  - A fee below `minFeeB + minFeeA*size`.
- The payer is resolved from the owner address of the **nonce UTxO**.
- `settle()` broadcasts each tx id at most once, and a retry resumes observation. Terminal failure reason: `exact_cardano_settlement_failed`.
- Preprod timing observed by the maintainers (code comment): a block gap of 80 s followed by one of 36 s. Two 60 s waits did not cover it, hence the 75 s default.
- The e2e config (`e2e/config/mechanisms_cardano.json`) uses env vars `SERVER_CARDANO_ADDRESS`, `SERVER_CARDANO_SELLER_MNEMONIC`, `SERVER_CARDANO_SCRIPT_ADDRESS`, `SERVER_CARDANO_SCRIPT_CODE`, `SERVER_CARDANO_SCRIPT_DATUM`, `CLIENT_CARDANO_MNEMONIC`, `FACILITATOR_CARDANO_MNEMONIC` and `CARDANO_L1_CONFIRMATIONS`, plus Blockfrost.

---

## Implications for Cascade

1. **Pin these versions:** `@x402/core@2.28.0`, `@x402/cardano@2.28.0`, `@x402/fetch@2.28.0`, `@x402/express@2.28.0` or `@x402/hono@2.28.0`.
   - All are on Node ≥ 22, with `@evolution-sdk/evolution` ^0.5.9. `subbit-x402` pins 0.5.15.
   - Use one Evolution SDK version across Cascade to avoid duplicate CBOR types.
2. **Cascade must run its own Cardano facilitator.** x402.org's hosted facilitator has no Cardano network.
   - Build it on `x402Facilitator` + `ExactCardanoScheme(toFacilitatorCardanoSigner(...))` with **Blockfrost**. Koios cannot report depth, which caps `l1Confirmations` at 0.
   - Add Express routes for `/verify`, `/settle` and `/supported`.
3. **Draw transactions are not "plain payments."** A Draw that mints a node thread token is rejected by stock `verify()`.
   - The Cascade facilitator must implement `validatePhase1Transaction`, a real ledger phase-1 check (e.g. an Ogmios- or node-backed evaluate/submit dry run).
   - Or, for payments to **third-party** facilitators, the orchestrator must pay from a key-controlled wallet in a plain tx rather than from a script input.
4. **The PRD's `cascade` method.** The PRD calls it "x402 `cascade` payment method on top of the Cardano `exact` scheme".
   - It can be the built-in `script` ATM plus extra free-form keys (`spec_hash`, …). That works with stock clients and servers.
   - Or it can be a new ATM, which needs the three subclasses listed in section 4.
   - Recommendation: use `script`. Stock x402 Cardano clients can then pay Cascade nodes, and Cascade adds datum checks only in its own facilitator's `runMethodSpecificChecks` override.
5. **Client spend controls.** For tADA payments the orchestrator's client must set `spendControls.allowedAssets` for `lovelace`, or the default `$1`-USDM-only controls silently drop the accept.
6. **Masumi quote storage and dedupe must be durable and shared.** The in-memory defaults are wrong for a multi-process orchestrator. Implement `MasumiTermsStorage` and `CardanoSettlementStore` on Convex, Postgres or Redis with atomic updates.
