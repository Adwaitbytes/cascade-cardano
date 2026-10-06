# Lucid Evolution (+ Mesh, Ogmios client): digest

## Pins (npm, 2026-10-01)

| Package | Version | Notes |
|---|---|---|
| `@lucid-evolution/lucid` | **`0.6.5`** (2026-09-17) | Deps: `provider 0.2.4`, `utils 0.1.74`, `wallet 0.2.2`, `core-types 0.3.0`, `plutus 0.1.36`, `uplc 0.2.23`, CML `@anastasia-labs/cardano-multiplatform-lib-* 6.2.0-1`, `effect ^3.12.7` |
| `@cardano-ogmios/client` | **`7.0.0`** (2026-06-20) | Pulls in `@cardano-ogmios/schema@7.0.0` |
| `@meshsdk/core` | **`1.9.1`** (2026-06-19) | Dep `@meshsdk/wallet 1.9.1`, which exports `BrowserWallet`, `MeshWallet`, `AppWallet` |
| `@meshsdk/react` | `latest` = **`2.0.0-beta.2`** (2026-02-12) | **No stable 1.9.x exists.** The last stable is `1.8.14` (2025-01). `2.0.0-beta.2` depends on `@meshsdk/wallet 2.0.0-beta.5`, where `BrowserWallet` is replaced by `CardanoBrowserWallet` / `MeshCardanoBrowserWallet`. The React exports are `CardanoWallet`, `MeshProvider`, `useWallet`, `useWalletList`, `useAddress`, `useLovelace`, `useNetwork`, `useRewardAddress`, `useAssets`, `useWalletSubmit`. The pairing that matches `core 1.9.x` is `@meshsdk/react@1.9.0-beta.98` (wallet `1.9.0-beta.98`). |
| `@evolution-sdk/evolution` | `0.5.16` (2026-09-30) | Yaci ships examples for it; not evaluated here |
| `@blockfrost/blockfrost-js` | `6.2.0` | |

Installed into `$SCRATCH/research-tooling/lucid` with pnpm 12. pnpm 12 refuses ignored build scripts, so `cbor-extract` needs `allowBuilds: { cbor-extract: true }` in `pnpm-workspace.yaml`.

- Probe scripts, all run on Node 26:
  - `probe.mjs`: export list
  - `data-probe.mjs`: `Data` and params
  - `build-only.mjs`: providers, wallets, tx build and evaluate, **never signed or submitted**
  - `eval-raw.mjs` / `eval-debug*.mjs`: raw evaluate endpoints
- There are 233 exports. `Lucid`, `Blockfrost`, `Koios`, `Kupmios`, `Maestro`, `Emulator`, `Data`, `Constr`, `generateSeedPhrase`, `applyParamsToScript`, `applyDoubleCborEncoding`, `validatorToAddress`, `validatorToScriptHash`, `validatorToRewardAddress`, `mintingPolicyToId`, `SLOT_CONFIG_NETWORK`, `unixTimeToSlot`, `slotToUnixTime`, `getAddressDetails`, `paymentCredentialOf`, `stakeCredentialOf`, `credentialToAddress`, `credentialToRewardAddress`, `scriptHashToCredential`, `keyHashToCredential`, `fromText`, `toUnit`, `fromHex`, `toHex`, `walletFromSeed`, `makeWalletFromSeed`, `CML` are all present.
- `walletFromPrivateKey` does not exist; use `makeWalletFromPrivateKey` or `selectWallet.fromPrivateKey`.

## Construction

```ts
declare const Lucid: (provider?: Provider, network?: Network, options?: LucidOptions) => Promise<LucidEvolution>;
type Network = "Mainnet" | "Preview" | "Preprod" | "Custom";
type LucidOptions = { presetProtocolParameters?: ProtocolParameters; evaluator?: EvaluatorAdapter;
                      slotConfig?: SlotConfig /* required for uninitialized Custom networks */ };
type SlotConfig = { zeroTime: UnixTime /* ms */; zeroSlot: Slot; slotLength: number /* ms */ };
```

`SLOT_CONFIG_NETWORK` (verified):

| Network | zeroTime | zeroSlot | slotLength |
|---|---|---|---|
| Preprod | 1655769600000 | 86400 | 1000 |
| Preview | 1666656000000 | 0 | 1000 |
| Mainnet | 1596059091000 | 4492800 | 1000 |
| Custom | 0 | 0 | 0 (must override) |

**Yaci (verified working):**

```ts
const devkit = await (await fetch("http://localhost:10000/local-cluster/api/admin/devnet")).json();
const lucid = await Lucid(new Blockfrost("http://localhost:8080/api/v1", "yaci"), "Custom",
  { slotConfig: { zeroTime: devkit.startTime * 1000, zeroSlot: 0, slotLength: devkit.slotLength * 1000 } });
lucid.currentSlot();               // == tip slot (2030 at test time) — correct
```

- Use the **instance** methods `lucid.unixTimeToSlot` and `lucid.slotToUnixTime` for `Custom`.
- The free functions `unixTimeToSlot(network, t)` read the global `SLOT_CONFIG_NETWORK.Custom`, which is all zeros (see lucid-evolution PR #443).
- `Custom` produces testnet `addr_test…` / `stake_test…` addresses.

### Providers

| Provider | Constructor | `evaluateTx` implementation |
|---|---|---|
| Blockfrost | `new Blockfrost(url, projectId?, { requestTimeoutMs? })` | `POST {url}/utils/txs/evaluate/utxos`. Expects the Ogmios-v5 `result.EvaluationResult`. |
| Koios | `new Koios(baseUrl, bearerToken?)`, e.g. `new Koios("https://preprod.koios.rest/api/v1")` | **Yes.** `POST {baseUrl}/ogmios` with JSON-RPC `evaluateTransaction { transaction:{cbor}, additionalUtxo }`, 10 s timeout. Maps `budget.memory/cpu`. |
| Kupmios | `new Kupmios(kupoUrl, ogmiosUrl, { kupoHeader?, ogmiosHeader?, requestTimeoutMs?, awaitTxTimeoutMs? })` | Ogmios `evaluateTransaction` over **HTTP** POST (the ogmiosUrl is `http://…:1337`, not `ws://`). Requires Kupo ≥ 2.10. |
| Maestro | `new Maestro({ network, apiKey, turboSubmit })` | Not tested |
| Emulator | `new Emulator(accounts)` with `generateEmulatorAccount(assets)` | Local |

- Kupmios `getProtocolParameters` reads both `maxReferenceScriptsSize` (Ogmios v6) and `maxReferenceScriptsSizePerTransaction` (Ogmios v7), so it is compatible with both.
- The `Provider` interface also has optional `getUtxosWithPolicy` (Kupmios implements it), `getTransactionStatus`, and `getRewardAccount`.

**Verified against Yaci (build and evaluate only):**

| Provider → Yaci | Wallet UTxOs | `register.Stake` + publish eval | `withdraw(…, 0n, …)` eval |
|---|---|---|---|
| Blockfrost → yaci-store `:8080/api/v1` | OK; genesis UTxOs visible | OK: local eval, and provider eval with `validTo` under 300 s | OK (local and provider) |
| Kupmios → `:1442` + `:1337` | **Empty.** Kupo does not index genesis UTxOs; fund with a topup tx first. | fails: no funds | fails: no funds |

- **Horizon gotcha, verified:** with `.validTo(Date.now() + 10 min)` on Yaci, provider evaluation fails.
  - Ogmios says `3004 CannotCreateEvaluationContext: … PastHorizon`, because the forecast horizon is only 300 slots.
  - **Lucid's Blockfrost provider hides this** as `EvaluatorError: Cannot use 'in' operator to search for 'EvaluationResult' in undefined`.
  - `validTo(now + 2 min)` works.
  - On preprod the horizon is 36 h, so this is not an issue there.
- Blockfrost evaluation against yaci-store returned `{"publish:0":{memory:17287,steps:4742412}}`, identical to direct Ogmios `evaluateTransaction`.

## Wallets

```ts
lucid.selectWallet.fromSeed(seed: string, options?: { addressType?: "Base" | "Enterprise"; accountIndex?: number; password?: string })
lucid.selectWallet.fromPrivateKey(bech32PrivKey) / .fromAPI(cip30Api) / .fromAddress(address, utxos)
walletFromSeed(seed, { password?, addressType?, accountIndex?, network? })  // -> { address, rewardAddress, paymentKey, stakeKey }
makeWalletFromSeed(provider, network, seed, { addressType?, accountIndex?, password? })  // standalone Wallet
generateSeedPhrase()   // 24 words (verified)
```

- **There is no `addressIndex` option.** Derivation is `m/1852'/1815'/{accountIndex}'/0/0` and `…/2/0` for the stake key.
- To get several agent wallets from one mnemonic, vary `accountIndex`.
- Verified: accountIndex 0, 1 and 19 reproduce Yaci's default Address #0, #1 and #19 exactly.
- `lucid.wallet().address()` is async.

## Tx builder API (`lucid.newTx()`, from 0.6.5 `index.d.ts`)

```ts
readFrom(utxos: UTxO[])                                                        // reference inputs / reference scripts
collectFrom(utxos: UTxO[], redeemer?: Redeemer | RedeemerBuilder | BuildTxWithRedeemer)
pay.ToAddress(address, assets)
pay.ToAddressWithData(address, outputDatum?, assets?, scriptRef?)
pay.ToContract(address, outputDatum?, assets?, scriptRef?)                     // outputDatum = { kind: "inline", value: cborHex } | { kind: "hash", value } | { kind: "asHash", value }
mintAssets(assets: Assets, redeemer?)                                          // assets keyed by unit = policyId + assetNameHex
withdraw(rewardAddress, amount: Lovelace, redeemer?)                           // withdraw-zero: withdraw(rewardAddr, 0n, redeemerCbor)
register.Stake(rewardAddress, redeemer?: CertificateRedeemer)                  // Conway; redeemer ⇒ script witness ⇒ runs `publish`
registerStake(rewardAddress, redeemer?)                                        // deprecated alias
deregister.Stake(...), delegate.ToPool(...), registerAndDelegate.ToPool(...), register.DRep(...), vote(...), propose(...)
attach.SpendingValidator(s) / MintingPolicy(s) / WithdrawalValidator(s) / CertificateValidator(s) / Script(s) / VoteValidator / ProposeValidator
validFrom(unixMs) / validTo(unixMs)
addSigner(address | rewardAddress) / addSignerKey(keyHash)
attachMetadata(label, json)
compose(otherTxBuilder | null) / setMinFee(bigint)
complete(options?: CompleteOptions): Promise<TxSignBuilder>
completeSafe(...) -> Either   // chain(...) -> [newWalletUTxOs, derivedOutputs, TxSignBuilder]  (for tx chaining without awaiting)
```

`CompleteOptions`:

| Option | Default | Meaning |
|---|---|---|
| `coinSelection` | true | Run coin selection |
| `changeAddress` | wallet address | Where change goes |
| `localUPLCEval` | true | Built-in Aiken/WASM evaluator. `false` sends evaluation to `provider.evaluateTx`. |
| `evaluator` | — | Custom evaluator |
| `setCollateral` | 5_000_000n | Collateral amount |
| `canonical` | false | Canonical CBOR ordering |
| `includeLeftoverLovelaceAsFee` | false | Put leftover lovelace into the fee |
| `presetWalletInputs` | `[]` | Wallet UTxOs to use for coin selection |

**RedeemerBuilder** handles index-dependent redeemers, which the withdraw-zero indexer needs:

```ts
{ kind: "selected", inputs: UTxO[], makeRedeemer: (inputIndices: bigint[]) => Redeemer }  // indices after final sorting
{ kind: "self", makeRedeemer: (inputIndex: bigint) => Redeemer }
type BuildTxWithRedeemer = (ctx: RedeemerContext) => Redeemer   // also accepted by withdraw/mint/certs
```

Then sign, submit and await:

```ts
const signed = await (await tx.complete()).sign.withWallet().complete();   // TxSignBuilder.sign.withWallet() / .withPrivateKey(k)
const txHash = await signed.submit();                                     // TxSigned.submit({ canonical? })
// Multi-party (buyer + arbiter): each party runs partialSign.withWallet() / .withPrivateKey(k) -> TransactionWitnesses; then
// txSignBuilder.assemble([w1, w2]).complete().then(s => s.submit())
await lucid.awaitTx(txHash /*, checkIntervalMs */);   // or lucid.awaitTxConfirmation(txHash, opts)
tx.toCBOR(); tx.toTransaction()                         // inspect before signing
```

- Queries: `utxosAt(addrOrCred)`, `utxosAtWithUnit`, `utxosAtWithPolicy`, `utxoByUnit`, `utxosByOutRef`, `datumOf(utxo, schema?)`, `delegationAt`, `rewardAccountAt`, `transactionStatus`, `currentSlot`.
- `overrideUTxOs(utxos)` / `clearUTxOOverride()` let you chain from local state.

**Verified build (not submitted):**

```ts
const rewardAddress = validatorToRewardAddress("Custom", script);   // stake_test17rtfuv3e…  (script credential)
await lucid.newTx().register.Stake(rewardAddress, Data.void()).attach.CertificateValidator(script).complete();
await lucid.newTx().withdraw(rewardAddress, 0n, Data.to(new Constr(0, [0n]))).attach.WithdrawalValidator(script).complete();
```

Fees were about 0.236 ADA and 0.238 ADA. The register tx also locks the 2 ADA `key_deposit`.

## Data utilities (verified)

```ts
Data.to(value, Schema?) -> cborHex ; Data.from(cbor, Schema?) -> value ; Data.void() === "d87980"
new Constr(index, fields)             // Data.to(new Constr(0, [bytesHex, 1n, 2n]))
Data.Object({...}) Data.Bytes({minLength,maxLength}) Data.Integer() Data.Enum([...]) Data.Literal("Tag") Data.Array(...) Data.Map(...) Data.Nullable(...)
```

- An aiken record `NodeDatum { owner: ByteArray(28), budget: Int, deadline: Int }` corresponds to `Data.Object({ owner: Data.Bytes({minLength:28,maxLength:28}), budget: Data.Integer(), deadline: Data.Integer() })`. Both encode to `d8799f581c…0102ff`, which is **byte-identical to aiken `cbor.serialise`** (checked in an aiken test).
- An aiken enum `MintNode { seed } | BurnNode` corresponds to `Data.Enum([Data.Object({ MintNode: Data.Object({ seed: … }) }), Data.Literal("BurnNode")])`. `BurnNode` encodes as `d87a80`.
- Blueprint codegen: the PRD's `@cascade/contracts` generates types from CIP-57. Lucid has no built-in blueprint codegen; hand-write `Data` schemas or use a blueprint generator.

## Scripts and params (verified)

```ts
const script = { type: "PlutusV3", script: applyDoubleCborEncoding(blueprint.validators[i].compiledCode) };
applyParamsToScript(applyDoubleCborEncoding(compiledCode), [0n])   // hash d69e3239… == `aiken blueprint apply … 00`
validatorToScriptHash(script); mintingPolicyToId(script)            // same hash for a multivalidator
validatorToAddress(network, script, stakeCredential?)               // addr_test1w… (Custom/Preprod)
validatorToRewardAddress(network, script)                           // stake_test17… ; == credentialToRewardAddress(network, scriptHashToCredential(hash))
```

- Blueprint `compiledCode` is single-CBOR-wrapped. Wrap it with `applyDoubleCborEncoding` before `applyParamsToScript` or before using it as a `Script`.
- For a reference script, pay it into an output via `pay.ToContract(addr, datum, assets, script)`, then use `readFrom([refUtxo])` in later txs **without** `attach.*`.

## `@cardano-ogmios/client` 7.0.0

- Exports: `createInteractionContext(errorHandler, closeHandler, { connection: { host, port, tls } })`, `createChainSynchronizationClient(ctx, { rollForward({block, tip}, next), rollBackward({point, tip}, next) }, { sequential })`, which returns `{ resume(points?, inFlight?), shutdown }`.
- Also: `createTransactionSubmissionClient` (`evaluateTransaction`, `submitTransaction`), `createLedgerStateQueryClient` (`protocolParameters`, `utxo`, `eraSummaries`, `networkTip`, `ledgerTip`, `rewardAccountSummaries`, `genesisConfiguration`, …), `createMempoolMonitoringClient`, `getServerHealth`.
- The 7.x client targets the Ogmios v7 schema. The JSON-RPC method names are unchanged from v6. The Yaci beta5 Ogmios is v6.14; our raw JSON-RPC chain-sync script worked against it.

## Mesh (UI wallet connect only)

- `@meshsdk/react` `CardanoWallet` + `MeshProvider` + `useWallet()` gives a CIP-30 connect button. The underlying `BrowserWallet.enable(name)` is in `@meshsdk/wallet 1.9.x`.
- Because `react@latest` is a 2.0 beta with a renamed wallet API, **pin the pair explicitly**: either `core 1.9.1` + `react 1.9.0-beta.98`, or everything on 2.0 betas.
- An alternative for a CIP-30 handle is Lucid's `selectWallet.fromAPI(await window.cardano[name].enable())`.
