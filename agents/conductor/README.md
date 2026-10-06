# Conductor

The orchestrator agent. It plans a job, serves the buyer console API (`/v1/*`) and runs funded trees on
Temporal. Every transaction is signed by the signer service. The preprod instance is started with the
other agents by `scripts/run-preprod-agents.sh`.

## A second Conductor for acceptance tests (A14, A15)

A14 stops the orchestrator and checks that the watchtower alone brings every node to a terminal state.
A15 crashes the orchestrator between signing and submitting, restarts it, and checks there is no
duplicate Draw and no lost node. Neither test can stop or set env on the shared preprod Conductor, so
it launches its own:

```sh
pnpm --filter @cascade/agent-conductor build                         # once, after code changes
agents/conductor/scripts/test-instance.sh start a15 24100            # prints http://127.0.0.1:24100
agents/conductor/scripts/test-instance.sh status a15                 # running | exited:<code> | not started
agents/conductor/scripts/test-instance.sh stop a15
```

The test instance uses the same preprod services (indexer, facilitator, signer), the same database and
the same running agents. It keeps its trees apart from the main Conductor in three ways:

- port and base URL: `CASCADE_CONDUCTOR_PORT` and `CASCADE_CONDUCTOR_BASE_URL`. Agents fetch the
  plan from this base URL, so it has to be reachable from them; they run on this machine.
- Temporal task queue: `CASCADE_TASK_QUEUE=cascade-test-<name>`.
- state tables: `CASCADE_ORCHESTRATOR_STATE_PREFIX=test_<name>` gives the tables
  `test_<name>_plans` and `test_<name>_hires`.

Restarting with the same name resumes the same trees: the Temporal workflows are on its queue, and its
hire records are in its tables. The log is `infra/.data/agents/test-conductor-<name>.log`.

### Crash points (A15)

Set `CASCADE_TEST_CRASH_AFTER_SIGN` when starting, and the process exits with code 86 at that point.
The point is printed to the log, labelled `TEST SCENARIO`.

| Value | Where it exits |
| --- | --- |
| `draw-signed` | After the signer returned a Draw, before it is recorded or sent |
| `payment-recorded` | After the hire ledger recorded the signed Draw, before the paid purchase |
| `tx-signed` | After the signer returned any other transaction, before it is submitted |

```sh
CASCADE_TEST_CRASH_AFTER_SIGN=payment-recorded agents/conductor/scripts/test-instance.sh start a15 24100
# drive a job through http://127.0.0.1:24100/v1/jobs, fund it, wait for `status a15` to print exited:86
agents/conductor/scripts/test-instance.sh start a15 24100     # restart without the variable
```

After the restart, the hire activity finds the recorded Draw and resends that same payment, so no
second Draw happens (packages/orchestrator/test/crash.integration.test.ts proves this against
Postgres).

### Test scenarios

`POST /v1/jobs` accepts `test_scenario` (labelled; `CASCADE_DISABLE_TEST_SCENARIOS=1` refuses it). Each
scenario replaces the planner with a fixed draft:

| Scenario | Tree |
| --- | --- |
| `a1-happy-path` | 3 levels, 7 nodes. Scribe and Scout each sub-hire two agents, and every node delivers. |
| `a5-address-payment` | Scribe, plus one Lookup API call paid by an x402 `default` payment from the tree |
| `a7-metered` | Pricer pays 210 Lookup API calls through one metered voucher channel |
| `a8-schema-fail` | Scribe's output fails the spec schema; Scribe concedes the challenge |
| `a9-escalation` | As A8, but Scribe escalates to the arbiters |

## A3 on preprod (Masumi leaf through the purchase wallet P)

`scripts/a3-preprod.ts` drives A3 through the running Conductor:

1. It creates a console job with `test_scenario: "a3-masumi-leaf"`, and the buyer role funds it from the
   Conductor's unsigned FundRoot.
2. It follows the Conductor's hire ledger to the Draw that pays P, then to P's `vested_pay` lock.
3. It polls Lisan's payment service until `onChainState` is ResultSubmitted and Lisan's SubmitResult
   transaction is confirmed.

The last line printed is a JSON summary: plan, tree, FundRoot, Draw, lock and SubmitResult
transactions, the Lisan job id, and the states seen. The script exits 0 only on a confirmed
SubmitResult.

```sh
npx tsx agents/conductor/scripts/a3-preprod.ts
```

It reads `CASCADE_TREASURY_MNEMONIC`, `DATABASE_URL_PREPROD` and `MASUMI_LISAN_ADMIN_KEY` from `.env`.
Optional variables:

| Variable | Default |
| --- | --- |
| `CASCADE_CONDUCTOR_URL` | `http://127.0.0.1:24001` |
| `CASCADE_A3_BUYER_ROLE` | `buyer` |
| `LISAN_PAYMENT_SERVICE_URL` | `http://localhost:23101/api/v1` |
| `CASCADE_A3_TIMEOUT_MIN` | `60` |

Each run spends about 20 tADA (Lisan's price is 10 ADA) and one Lisan job.
