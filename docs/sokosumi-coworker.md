# Cascade as a Sokosumi Coworker

Cascade runs as a Coworker on Sokosumi preprod. A buyer creates a Task with a brief. Cascade plans
the work as an escrow tree, hires agents, checks their results, and returns the deliverable with a
receipt: who was hired, what each was paid, and a preprod link for every payment and refund. The
buyer pays 1 test USDM per Task through Masumi escrow; the result hash goes on chain before the Task
completes, and the seller collects after the unlock time.

## Identifiers

| What | Value |
| --- | --- |
| Sokosumi account | adwaitkeshari288@gmail.com (personal Workspace) |
| Vendor | `01a110cd-2605-751f-8fdf-f310dbf883b8` (Cascade) |
| Coworker | `01a110cd-4ee0-763b-ae63-4008564c9f8e` (Cascade, capability `tasks`) |
| TOKEN2049 Workspace access | requested, PENDING admin approval |
| Masumi registration | `cmuwk89cn003287pf68eqqbp6`, RegistrationConfirmed, Dynamic pricing |
| Masumi agent identifier | `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b103b928cfe0e53ff7de902d2e3b5bedcdbdc05ac720486fadfcfb7ece8000000` |
| Registration tx | [27f2aa49…06a3](https://preprod.cardanoscan.io/transaction/27f2aa49f9245d826b1837745d2a54d247f857ced77a7a2ef36856da7b8906a3) |
| Payment service | orchestrator operator's MPS, `http://127.0.0.1:23100`, Preprod Web3CardanoV2 source |
| Escrow contract | `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g` |
| Seller (selling wallet) | `addr_test1qrfkwa9q6etsgnt84pc9mdypsls0a3248wdm66ma4j798awhjdjse2vv0kjn9mj05xhd6u6ux30dl7fhx04ptquhlngspt05mm` |
| Price | 1 test USDM per Task (`1000000` of unit `16a55b2a…0014df10745553444d`) |
| Tree buyer wallet | role `coworker-buyer` (account 44), funded with 300 tADA in [1f4d4260…2081](https://preprod.cardanoscan.io/transaction/1f4d42606ca9bbb8320c80c07a62863521913841301262941589233b1f962081) |

All public facts are in `agents/cascade-coworker/registration.preprod.json`.

## How a paid Task runs

The worker (`agents/cascade-coworker`) follows the TOKEN2049 guide order for every Task:

1. Polls `GET /v1/tasks?coworkerId=…&status=READY` with the Coworker runtime key and moves the Task to RUNNING.
2. Requests fresh signed seller terms from our MPS (`POST /payment`): input hash is SHA-256 of the
   exact Task description, 1 test USDM, pay-by in 10 minutes, result deadline after the tree window.
3. Posts the terms unchanged as `masumiPayment` on the Task event endpoint. Sokosumi charges the
   buyer's credits and funds the Masumi escrow.
4. Waits for a confirmed `FundsLocked` before any work.
5. Drafts a Cascade plan through the preprod Conductor (`POST /v1/jobs`), funds its root from the
   `coworker-buyer` wallet, and reads the root's composed result from the tree workflow.
6. Accepts the root, writes the result (deliverable, then hired agents, payments and links), and
   submits its SHA-256 to MPS (`POST /payment/submit-result`).
7. After `ResultSubmitted` is confirmed on chain, completes the Task with that exact text.
8. Waits for the seller collection (`Withdrawn`) after the unlock time and records the tx hash.

Every external write is journaled first (`infra/.data/coworker/task-<id>.json`). An uncertain
`masumiPayment` post is never retried automatically. A Task whose plan cannot fit its signed result
deadline is failed with a plain explanation, and Masumi returns the escrow to the buyer.

## Run it

```sh
scripts/run-coworker.sh start      # detached; log in infra/.data/agents/agent-cascade-coworker.log
scripts/run-coworker.sh stop
scripts/preprod-status.sh          # shows cascade-coworker on :24012
```

`scripts/preprod-up.sh` starts it if it is down, and `scripts/run-preprod-agents.sh` restarts it with
the agent group. One-time setup, already done:

```sh
npx tsx agents/cascade-coworker/scripts/fund-buyer.ts 300   # coworker-buyer from the treasury
npx tsx agents/cascade-coworker/scripts/register.ts register # Masumi registry, Dynamic pricing
npx tsx agents/cascade-coworker/scripts/register.ts status   # until RegistrationConfirmed
npx tsx agents/cascade-coworker/scripts/register.ts key      # scoped MPS key into .env
```

Secrets are read from `.env` by the worker and never printed: `SOKOSUMI_COWORKER_API_KEY`,
`MASUMI_COWORKER_MPS_TOKEN` (read and pay, Preprod, selling wallet only) and
`CASCADE_TREASURY_MNEMONIC` (derives the `coworker-buyer` key in the worker process; no LLM runs there).

LLM models: the Conductor's planner and the worker agents run on `google/gemini-2.5-flash-lite`, and
the three checkers run on free models from three providers. When OpenRouter answers 402 (credit spent)
or 429 (rate limit), a call moves to the next model in its fallback chain, ending on free models, and
each call logs a `[cascade-llm] served=...` line. Once the operator tops up the key, switch the worker
model with `CASCADE_LLM_MODEL_WORKER=google/gemini-2.5-flash` in `.env` (and
`CASCADE_LLM_MODEL_PLANNER` for the planner), then restart the agents with
`scripts/run-preprod-agents.sh`. `CASCADE_LLM_FALLBACK_<ROLE>` takes a comma-separated chain, or `none`.

To try it: `sokosumi --preprod tasks create --personal --coworker-id 01a110cd-4ee0-763b-ae63-4008564c9f8e --name "Brief" --description "Market-entry brief for cold-pressed juice in Dubai with a competitor price table." --status READY --json`.

## Proof

<!-- PROOF -->

## Known limits

- The registered agent URL (`…/cascade-coworker`) is served through the agents gateway once the gateway
  restarts and picks up the new route; until then only the Sokosumi path (outbound polling) is live.
  Its `start_job` sends callers to Sokosumi, since a Task is the paid entry point.
- Sokosumi CLI 1.0.4 has no flags for the profile's price or estimated duration; both are stated in the description.
- A Cascade tree with Masumi leaves needs about 2 h 45 min of window, so the signed result deadline is
  about 3 h 35 min after the Task starts and the seller collects about 4 h after the start.

### Paid Task 1 (2026-10-06): payment flow proven end to end

- Task: `01a110e2-b1ca-752c-bc65-123cd12ae594` on Sokosumi preprod, Coworker `01a110cd-4ee0-763b-ae63-4008564c9f8e`
- Masumi escrow lock (Sokosumi pays with the buyer's credits): https://preprod.cardanoscan.io/transaction/caafb951464f87f3f2f2f972875657f6723c870e81a7152bd8ca61116472c589
- Result hash on chain (SubmitResult): https://preprod.cardanoscan.io/transaction/a9cefb55e6a6b035ef6cbee15332691b09741204d2e86cc1beec7e85aa578d1c
- Seller collection, state Withdrawn: https://preprod.cardanoscan.io/transaction/0e584a87be1ce0315a42a39a7c1c18b100f7c75074ede6825f8c351bb3dc93c4
- Cascade tree funding: https://preprod.cardanoscan.io/transaction/ffe6216e97f7fd70027a545ad4e0d0e2af17a351edd9b03e19c22ab4cf7d71ed

Honest notes: this Task ran before the hackathon redeploy, so its Cascade tree used the earlier script hashes, and the delivered result was partial because the child agents went offline mid-run. It proves the Sokosumi to Masumi escrow to seller payout path. Paid Task 2 below runs on today's deployment with a full result.

### Paid Task 2 (2026-10-07): full deliverable, paid out

- Task: `01a11176-0b37-75cb-a4d9-d568b3fd9cdb`, a market-entry brief for a cold-pressed juice brand in Dubai. Full result: [docs/samples/task-01a11176-dubai-juice-brief.md](samples/task-01a11176-dubai-juice-brief.md)
- Masumi escrow lock: https://preprod.cardanoscan.io/transaction/a7a8afe4a4092d4d048616feb97865c9f11f6864bf82c3acabd01b4e18787950
- Result hash on chain: https://preprod.cardanoscan.io/transaction/ac5706a15d9cad115f62488668949822302797385d4b7c51c426fe7a9e2af952
- Seller collection, state Withdrawn: https://preprod.cardanoscan.io/transaction/f37ffe31f43bbbbb5c5f2c3834c62cf791c7bd218fe2e7ee9855be55830f769e
- Cascade tree funding: https://preprod.cardanoscan.io/transaction/49d52a7576be879c3f0aca14ad572265b0431ba94b402c3c6adf18639329307e

Note: this Task ran overnight before the switch to the redeployed scripts, so its Cascade tree uses the earlier script hashes; all its Masumi transactions are inside the hackathon window. Paid Task 3 runs on today's deployment.
