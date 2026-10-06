# Ogmios, Kupo, Koios: digest

## Pins

| Component | Latest | What we run where |
|---|---|---|
| Ogmios | **`v7.0.0`** (2026-06-20, commit `b3a830a1…`, tested with cardano-node 11.0.1 on mainnet, preprod and preview). Previous: `v6.14.0` (2025-10-16). | Yaci beta5 bundles **`v6.14.0.2 (f069c789)`**. Koios' `/ogmios` proxy describes itself as "Ogmios v6". **Our own preprod node (cardano-node 11.0.1, PV11) needs Ogmios v7.0.0.** Images: `cardanosolutions/ogmios:v7.0.0` or `cardanosolutions/cardano-node-ogmios:v7.0.0_11.0.1-preprod`. |
| Kupo | **`v2.12.0`** (2026-07-18, commit `491918a5…`, tested with node 11.0.1 and Ogmios `v7.*`). v2.11 was tested with Ogmios `v6.*`. | Yaci beta5 bundles **`v2.11.0.1`**. Preprod needs `cardanosolutions/kupo:v2.12.0`. |
| Koios | API `v1.4.2` (spec at `https://preprod.koios.rest/koiosapi.yaml`) | Preprod base `https://preprod.koios.rest/api/v1` |

**Ogmios v7 breaking changes** (JSON-RPC method names are unchanged):

- `ProtocolParameters.maxReferenceScriptsSize` was renamed to `maxReferenceScriptsSizePerTransaction`. Lucid 0.6.5 Kupmios handles both names.
- The transaction object omits empty `validityInterval` and `outputs`.
- Byron bootstrap witness encoding changed.
- Submit and evaluate errors now only carry `alonzo`+ era hints.
- New: preliminary Dijkstra / PlutusV4 support; in evaluation, the `additionalUtxo` you pass now **overrides** chain-resolved UTxOs.

## Ogmios JSON-RPC (v6/v7), verified on Yaci

Transport is WebSocket `ws://host:1337`, or plain HTTP `POST http://host:1337` with the same JSON body. Each message is `{"jsonrpc":"2.0","method":…,"params":…,"id":…}`.

| Method | Params | Result (observed) |
|---|---|---|
| `evaluateTransaction` | `{ transaction: { cbor }, additionalUtxo?: [...] }` | `[{"validator":{"index":0,"purpose":"publish"},"budget":{"memory":17287,"cpu":4742412}}]`. Purposes are `spend`, `mint`, `publish`, `withdraw`, `vote`, `propose`. |
| `submitTransaction` | `{ transaction: { cbor } }` | `{ transaction: { id } }` |
| `queryLedgerState/protocolParameters` | none | `minFeeCoefficient`, `minFeeConstant.ada.lovelace`, `minFeeReferenceScripts {base 15, range 25600, multiplier 1.2}`, `maxTransactionSize.bytes 16384`, `maxReferenceScriptsSize.bytes 204800` (v6 name), `stakeCredentialDeposit`, `plutusCostModels`, `maxExecutionUnitsPerTransaction`, `collateralPercentage`, `minUtxoDepositCoefficient`, … |
| `queryLedgerState/eraSummaries` | none | Includes `parameters.safeZone`. That is 300 on Yaci; see the horizon note below. |
| `queryLedgerState/utxo` | `{ addresses: [...] }` or `{ outputReferences: [...] }` | UTxOs. **Blocked on Koios.** |
| `queryLedgerState/tip`, `queryNetwork/tip` | none | `{slot, id}` |
| `queryNetwork/genesisConfiguration` | `{ era: "shelley" }` | `networkMagic 42`, `startTime`, `epochLength 600`, `slotLength.milliseconds 1000`, `securityParameter 100`, `activeSlotsCoefficient "1/1"` |
| `queryLedgerState/rewardAccountSummaries` | `{ keys/scripts }` | Lucid uses it for stake registration state |
| `findIntersection` | `{ points: [ {slot,id}, …, "origin" ] }` | `{ intersection, tip }`, or error `1000 "No intersection found."` with `data.tip` |
| `nextBlock` | none | `{ direction: "forward", block, tip }` or `{ direction: "backward", point, tip }` (this is **RollBackward**) |
| `acquireMempool` / `nextTransaction` / `hasTransaction` / `sizeOfMempool` / `releaseMempool` | — | Mempool monitoring |
| `acquireLedgerState` / `releaseLedgerState` | `{ point }` | Pins queries to a point |
| `GET /health` | — | JSON with `version`, `lastKnownTip`, `networkSynchronization`, `currentEra`, `connectionStatus` |

### Chain sync with rollbacks

Tested with `$SCRATCH/research-tooling/lucid/chainsync.mjs`.

1. Send `findIntersection` with **several** known points, newest first, and end the list with `"origin"` or a checkpoint.
2. Pipeline N `nextBlock` requests; we used 50 in flight. Send one more per response.
3. The **first** response after an intersection is always `direction:"backward"` to the intersection point. Handle it as a no-op or an idempotent rollback.
4. On `backward`, delete every row with `slot > point.slot`. In the PRD's schema, mark the `node_events` rows `rolled_back`.
5. On a socket close (Yaci's snapshot rollback restarts the node; see yaci-devkit.md), reconnect and re-intersect with the stored points. A `1000` error means every point you sent is orphaned, so send older ones.

The typed client `@cardano-ogmios/client@7.0.0` offers `createChainSynchronizationClient(ctx, { rollForward, rollBackward })` and `client.resume(points, inFlight)`.

### Error codes (from Ogmios v7 `ogmios.json`)

**Evaluate:**

| Code | Name |
|---|---|
| 3000 | IncompatibleEra |
| 3001 | UnsupportedEra |
| 3002 | OverlappingAdditionalUtxo |
| 3003 | NodeTipTooOld |
| **3004** | **CannotCreateEvaluationContext.** Observed as `PastHorizon` when `validTo` is beyond the safe zone. |
| **3010** | **ScriptExecutionFailure**, whose `data[]` holds per-validator: |
| | 3011 InvalidRedeemerPointers |
| | 3012 ValidationFailure (script `fail`/trace) |
| | 3013 UnsuitableOutputReference |

**Submit:**

| Code | Name |
|---|---|
| 3005 | EraMismatch |
| 3100 | InvalidSignatories |
| 3101 | MissingSignatories |
| 3102 | MissingScripts |
| 3109 | MissingRedeemers |
| 3110 | ExtraneousRedeemers |
| 3113 | ScriptIntegrityHashMismatch |
| 3117 | UnknownOutputReferences (input already spent or unknown; the double-spend / race signal) |
| 3118 | OutsideOfValidityInterval |
| 3119 | TransactionTooLarge |
| 3122 | TransactionFeeTooSmall |
| 3123 | ValueNotConserved |
| 3125 | InsufficientlyFundedOutputs (min-UTxO) |
| 3128 | InsufficientCollateral |
| 3130 | UnforeseeableSlot |
| 3134 | ExecutionUnitsTooLarge |
| 3141 | IncompleteWithdrawals |
| 3145 | CredentialAlreadyRegistered |
| 3146 | UnknownCredential (withdrawing from an unregistered stake script) |
| 3151 | CredentialDepositMismatch |
| 3161 | ExecutionBudgetOutOfBounds |
| 3164 | ConflictingInputsAndReferences |
| 3166 | ReferenceScriptsTooLarge |
| 3997 | UnexpectedMempoolError |

**Other:** `-32602` means the tx is not deserialisable (Invalid params).

**Horizon rule:** evaluation needs `validTo` inside the forecast horizon, which is `safeZone` slots past the tip (3k/f).

| Network | Horizon | Consequence |
|---|---|---|
| Yaci | **300 s** | `validTo(now + 10 min)` gives 3004. Use about 2 min. |
| Preprod | 129,600 s (36 h) | |

## Kupo HTTP API (v2.11/v2.12), verified on Yaci `:1442`

**Patterns** go in the path of `GET /matches/{pattern}` and on the CLI as `--match`:

| Pattern | Matches |
|---|---|
| `*` | Any output |
| `addr_test1…` | Exact address |
| `stake_test1…` | Delegated to that stake address |
| `{payment_cred}/*` | Payment credential. Accepts 56-hex hash, `addr_vkh1…` or `script1…` bech32. For a script address, use `<scriptHash>/*`. |
| `*/{stake_cred}` | Stake credential |
| `{policyId}.*` | Any asset of a policy. **Use this for Cascade thread tokens.** |
| `{policyId}.{assetNameHex}` | One asset |
| `{index}@{txId}` | One output reference |
| `*@{txId}` | All outputs of a tx |
| `{label}` | Metadata tag; for indexing only |

**Query flags on `/matches`:**

- `?unspent` or `?spent`
- `created_after` / `created_before` / `spent_after` / `spent_before`: a slot number or a point `slot.headerHash`. Inclusive. One lower and one upper bound at most.
- `order=most_recent_first|oldest_first`
- `policy_id` + `asset_name`, `transaction_id` + `output_index`: filters, slower than path patterns
- `resolve_hashes`: inlines `datum` and `script`

**Match object (observed):**

```json
{"transaction_index":0,"transaction_id":"d142b7…","output_index":1,"address":"addr_test1vzs0…",
 "value":{"coins":"2999998374137602","assets":{}},"datum_hash":null,"script_hash":null,
 "created_at":{"slot_no":1919,"header_hash":"6406cf…"},"spent_at":null}
```

- There is also `datum_type` (`"hash"` or `"inline"`); fetch inline or hashed datums via `GET /datums/{datum_hash}`.
- `coins` came back as a **string** from Yaci's Kupo even without `Accept: application/json;asset-quantity=string`; the spec says integer by default. **Parse both.**

**Other endpoints:**

| Endpoint | Purpose |
|---|---|
| `GET /checkpoints` | Recent indexed points, newest first: `[{slot_no, header_hash}]` |
| `GET /checkpoints/{slot}?strict` | Exact slot or `null`. Without `?strict` it returns the nearest ancestor. |
| `GET /datums/{hash}` | Datum by hash |
| `GET /scripts/{hash}` | Script by hash |
| `GET /metadata/{slot}` | Metadata at a slot |
| `GET /patterns`, `PUT /patterns/{pattern}`, `DELETE /patterns/{pattern}` | Runtime pattern management. A `PUT` with body `{"rollback_to": {"slot_no": N}}` forces a re-sync from a point. By default you cannot roll back beyond the safe zone. |
| `GET /health` | Prometheus text, or JSON with `Accept: application/json` |
| `GET /metrics` | Metrics |

**Rollbacks:**

- Kupo follows the node's rollbacks automatically: mark and sweep, data kept for k blocks.
- **Verified:** after Yaci's `rollback-to-db-snapshot`, the rolled-back topup UTxO vanished from `/matches` with no client action.
- Every response carries `X-Most-Recent-Checkpoint` (slot) and `ETag` (header hash of that block).
- **Client pattern:** store `created_at.{slot_no,header_hash}` per UTxO. On each poll, compare the header hash against `GET /checkpoints/{slot}?strict`; if it differs or is null, that row was rolled back. Treat anything younger than N blocks behind `X-Most-Recent-Checkpoint` as unconfirmed.
- **Kupo does not index genesis UTxOs.** Yaci's 20 default wallets are invisible to Kupo and Kupmios until funded by a real tx.

## Koios preprod (verified 2026-10-01)

Base URL is `https://preprod.koios.rest/api/v1`.

- Public tier needs no auth.
- The free registered tier uses `Authorization: Bearer <token>` issued at koios.rest.
- Lucid: `new Koios(base, token?)`.

| Endpoint | Method and body | Notes |
|---|---|---|
| `/tip` | GET | `[{hash, epoch_no, abs_slot, epoch_slot, block_height, block_time}]`. At test time: epoch 316, slot 135,123,713, Conway. |
| `/epoch_params?limit=1&order=epoch_no.desc` | GET | `protocol_major 11`, `max_tx_ex_mem 17500000`, `max_tx_ex_steps 1e10`, `coins_per_utxo_size 4310`, `min_fee_ref_script_cost_per_byte 15`, `key_deposit 2000000` |
| `/genesis` | GET | `networkmagic "1"`, `systemstart 1654041600`, `epochlength 432000`, `securityparam 2160`, `activeslotcoeff 0.05` |
| `/address_utxos` | POST `{"_addresses":[…], "_extended": true}` | `_extended` adds asset_list, inline_datum, reference_script |
| `/credential_utxos` | POST `{"_payment_credentials":["<hex>"], "_extended": true}` | By script hash, so it covers every Cascade node UTxO |
| `/asset_utxos` | POST `{"_asset_list":[["<policy>","<nameHex>"]], "_extended": true}` | |
| `/policy_asset_list` | GET `?_asset_policy=<policy>` | Verified against the Masumi V2 registry policy `67ab0c92…bd0b`: it returns assets |
| `/tx_info` | POST `{"_tx_hashes":[…], "_inputs", "_metadata", "_assets", "_withdrawals", "_certs", "_scripts", "_bytecode", "_governance"}` | Booleans |
| `/tx_status` | POST `{"_tx_hashes":[…]}` | `num_confirmations` (null if unknown) |
| `/utxo_info`, `/script_utxos`, `/reference_script_utxos`, `/datum_info`, `/asset_addresses`, `/policy_asset_info` | — | Also available |
| `/submittx` | POST, `Content-Type: application/cbor`, raw tx **bytes** | Returns the tx id. A 3 KB and a 12 KB junk body both reached the decoder (HTTP 400, not 413). |
| `/ogmios` | POST JSON-RPC | See the list below |

**`/ogmios` proxy methods:**

- Allowed: `queryNetwork/{blockHeight, genesisConfiguration, startTime, tip}`, `queryLedgerState/{epoch, eraStart, eraSummaries, liveStakeDistribution, protocolParameters, proposedProtocolParameters, stakePools}`, **`evaluateTransaction`**, **`submitTransaction`**.
- **`queryLedgerState/utxo` is blocked** ("not supported off public tier").
- There is no chain sync.
- Verified: `queryNetwork/tip` and `eraSummaries` answer, and `evaluateTransaction` with a 3 KB body reaches the decoder.

**Free and public limits** (from the spec's "Limits" section):

- **Burst: 100 requests per 10 s per IP per endpoint**, then HTTP 429 for 60 s.
- 1000 rows per page; use `offset`/`limit` and read the `Content-Range` header.
- 30 s query timeout, returning 504.
- **Request body limit "1 kb public / 5 kb registered"** as documented. In practice `/submittx` and `/ogmios` accepted larger bodies. Bulk RPC bodies (`_addresses` lists) should stay under 1 KB on the public tier, which is roughly 10 addresses.
- Lucid's Koios provider evaluates through `/ogmios`. That works publicly, but **it cannot resolve UTxOs through Ogmios**, so Lucid fetches them via `/address_utxos` or `/utxo_info`.

## Relevance to Cascade

- PRD gate 8 ("local evaluation through Ogmios") works with Kupmios against our own node, or with Koios `/ogmios` as a fallback.
- **Pin Ogmios v7.0.0 + Kupo v2.12.0 for preprod** (node 11.0.1). Yaci beta5 gives v6.14 / v2.11; code must tolerate both. The method names are identical, and so is Lucid.
- The PRD names Demeter.run as a managed fallback. Lucid's docs still show `preprod-v6.ogmios-m1.demeter.run` URLs, so confirm that Demeter serves an Ogmios build compatible with node 11 / PV11 before relying on it.
