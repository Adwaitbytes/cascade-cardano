# Lisan (unmodified Masumi agent)

Lisan is the Masumi leaf in the demo (PRD 21.1, 21.2 step 5): the Arabic translation contingency
the Conductor hires after Flaky Lisan's refund. It is the stock
[crewai-masumi-quickstart-template](https://github.com/masumi-network/crewai-masumi-quickstart-template),
not a Cascade agent. We do not edit its code. Everything here configures and runs it.

| File | What it does |
| --- | --- |
| `fetch.sh` | Checks out the template at commit `0d13f37b2285f3a0e5e23987c6db5456dd9cd79a` into `template/` (git-ignored). |
| `verify.sh` | Fails unless `template/` is at that commit with no changed or added code files. `fetch.sh` and `run.sh` call it. |
| `requirements.lock` | The template's unpinned `requirements.txt` resolved with `uv pip compile` (crewai 1.15.23, masumi 1.2.0, Python 3.12). |
| `configure.py` | Writes `template/.env` from the repo environment (see below). Never prints values. |
| `shim/payment_shim.py` | The V1-to-V2 payment shim (see below). Cascade infrastructure, not part of the agent. |
| `run.sh` | fetch, verify, install, configure, start the shim, start the template with `python main.py api`. |
| `tests/test_shim.py` | Proves the shim changes exactly two fields of `POST /payment` and forwards everything else verbatim. |

What the template does is fixed by its code: a two-agent CrewAI `ResearchCrew` that researches and
summarises the text in `input_data.text`. The Conductor sends the task ("Translate the executive
summary into Arabic") and the upstream summary in that field (`mip003Input` in
`packages/orchestrator/src/activities.ts`). The quality of the translation is whatever that crew
produces; we do not tune it.

## The V1/V2 payment-source problem

From `docs/research/crewai-quickstart.md` (static reading of the template and `pip-masumi`, pinned
commits there), confirmed against the code installed here:

- The template's `masumi` dependency is unpinned and resolves to `masumi==1.2.0` (latest on PyPI;
  upstream `pip-masumi` HEAD `5a54f5e` is the same). `masumi/payment.py` hard-codes
  `self.payment_type = "Web3CardanoV1"` and sends it as `paymentType`.
- The current Masumi Payment Service names that field `paymentSourceType`, and picks V1 or V2 from
  the agent's registry policy. For an agent registered under the V2 policy
  `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b`, `POST /payment` requires
  `supportedPaymentSourceIndex` (`src/routes/api/payments/index.ts` L179 to 184: "V2 Cardano payments
  require supportedPaymentSourceIndex"). `pip-masumi` 1.2.0 never sends it, so the unmodified
  template gets HTTP 400 from `POST /payment` for a V2-registered agent.
- The template therefore works only against a V1-registered agent: a V1 payment source
  (`SEED_V1_LEGACY=true`) or the V1-only `0.22.0` Docker images.
- Two smaller gaps: the service requires `identifierFromPurchaser` to be 14 to 26 hex characters
  (the Conductor always sends 24 hex characters), and `pip-masumi` JSON-escapes the output before
  hashing it for `submitResultHash`, which differs from MIP-004 for outputs with quotes, backslashes
  or newlines. Cascade verifiers use `pipMasumiOutputHash` (`packages/agent/src/mip004.ts`) for
  Masumi leaves.

Observed on 2026-10-01 against the Lisan operator's payment service from
`infra/docker-compose.masumi.yml` (`http://localhost:23101`, built from upstream commit `69297f30`):

- It has one payment source: `Preprod`, `Web3CardanoV2`, contract
  `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g`. There is no V1 source.
- The installed `masumi` 1.2.0 `Payment` sends `"paymentType": "Web3CardanoV1"` and no source index.
- No agent is registered on that service yet, so `POST /payment` currently answers 500 for every body
  shape (V1 as sent by `pip-masumi`, V1 through the shim, V2 without an index). The 400 above and the
  shim's fix can only be observed after Lisan is registered under the V2 policy (acceptance test A3).

## How we run it

Cascade's Masumi leaf is the V2 `vested_pay` contract: the Tree Config pins
`masumi_script_hash = a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad` and `cascade_node`
checks the 19-field V2 datum on Draw (ADR 0001 section 8). A V1-registered Lisan would lock into a
different contract that the Draw rejects. So we keep Lisan on V2 and close the gap outside the agent:

1. Lisan is registered under the V2 registry policy through its operator's payment service
   (W6, PRD 12.5). Its registry asset id goes in `CASCADE_AGENT_ID_LISAN`.
2. `configure.py` points the template's `PAYMENT_SERVICE_URL` at the shim on `127.0.0.1:23111`.
   The shim rewrites `POST /payment` only: it drops `paymentType` and adds
   `paymentSourceType: "Web3CardanoV2"` and `supportedPaymentSourceIndex` (default 0, set with
   `LISAN_SHIM_SOURCE_INDEX`). Status polling (`resolve-blockchain-identifier`), `submit-result` and
   every other call pass through unchanged, with the same `token` header.
3. The template runs byte-for-byte as published. `verify.sh` proves it before every start.

This is a deviation from "no changes at all": the agent's code is unchanged, but its payment backend
is reached through a shim that fixes the client library's out-of-date request shape. The alternative,
a V1 source, would keep the request unshimmed but break Cascade's on-chain Masumi receipt checks.
When `pip-masumi` ships V2 support, drop the shim by pointing `PAYMENT_SERVICE_URL` at the service.

### Environment

`configure.py` writes only these variables to `template/.env` (mode 600):

| Variable | Source |
| --- | --- |
| `PAYMENT_SERVICE_URL` | the shim, `http://127.0.0.1:${LISAN_SHIM_PORT:-23111}/api/v1` |
| `PAYMENT_API_KEY` | `LISAN_PAYMENT_API_KEY`, else `MASUMI_LISAN_ADMIN_KEY` |
| `AGENT_IDENTIFIER` | `CASCADE_AGENT_ID_LISAN` (required) |
| `SELLER_VKEY` | the selling wallet's `walletVkey` from the service's `GET /wallet/list` |
| `NETWORK` | `Preprod` |
| `MODEL`, `OPENROUTER_API_KEY` | `openrouter/openai/gpt-4.1-nano` through CrewAI's native OpenRouter provider (no OpenAI key exists) |
| `API_HOST`, `API_PORT` | `127.0.0.1`, `24009` |
| `CREWAI_DISABLE_TELEMETRY`, `OTEL_SDK_DISABLED` | `true` |

Why a file and not only exported variables: `main.py` calls `load_dotenv(override=True)`, which
searches upward from `main.py`. Without `template/.env` it would find the repo-root `.env` and load
every Cascade secret, treasury mnemonic included, into the template's process. The file beside
`main.py` is found first, so the repo `.env` is never read.

Spend: CrewAI calls OpenRouter directly and bypasses Cascade's LLM spend guard. `configure.py`
refuses to start when OpenRouter usage has reached 2.50 USD, and the default model is the cheapest
one we use. A running Lisan is not metered per call; stop it when the demo is recorded.

### Commands

```sh
agents/lisan-masumi/run.sh                     # fetch, verify, install, configure, shim, start
agents/lisan-masumi/verify.sh                  # prove the template is unmodified
agents/lisan-masumi/.venv/bin/python -m pytest -q agents/lisan-masumi/tests
```

Third-party record (for `THIRD_PARTY.md`): masumi-network/crewai-masumi-quickstart-template at
`0d13f37b2285f3a0e5e23987c6db5456dd9cd79a`, fetched at run time, not copied into the repo; its
dependencies are pinned in `requirements.lock`.
