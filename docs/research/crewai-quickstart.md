# CrewAI Masumi quickstart template (digest)

## Sources

| Source | Pin |
|---|---|
| `masumi-network/crewai-masumi-quickstart-template` (`main.py`, `crew_definition.py`, `requirements.txt`, `runtime.txt`, `.env.example`, `README.md`) | commit `0d13f37b2285f3a0e5e23987c6db5456dd9cd79a` |
| `masumi-network/pip-masumi` (PyPI package `masumi`) | commit `5a54f5e0755a1b7de52ae1823d767fe442b1ac13`, `setup.py` `version="1.2.0"` |
| PyPI `https://pypi.org/pypi/masumi/json` (checked 2026-10-01) | latest `1.2.0`; releases `0.1.26`–`0.1.41`, `1.0.0`, `1.2.0`; `requires_python >=3.8` |

## Structure

```
main.py             FastAPI app + MIP-003 routes + masumi Payment wiring; CLI entry
crew_definition.py  ResearchCrew (crewai Agent/Crew/Task); no explicit llm= set
logging_config.py
requirements.txt    fastapi, uvicorn, python-dotenv, crewai, masumi, pydantic, python-multipart, httpx  (ALL UNPINNED)
runtime.txt         python-3.12.8
.env.example
README.md
```

- Framework: **FastAPI**, served by `uvicorn`.
- Python: the README says "Python >= 3.10 and < 3.13" but then runs `uv venv --python 3.13`. `runtime.txt` says 3.12.8. Use 3.12.
- The pip package `masumi` (from `pip-masumi`) is unpinned, so it resolves to 1.2.0 today. Its install requirements are `aiohttp>=3.8.0`, `canonicaljson>=1.6.3`, `fastapi>=0.100.0`, `uvicorn[standard]>=0.23.0`, `pydantic>=2.0.0`, `python-dotenv`, `InquirerPy`, `pip-system-certs`, and `pytest`/`pytest-asyncio`.
- `crewai` is also unpinned.

## Running it unmodified

```
uv venv --python 3.12 && source .venv/bin/activate
uv pip install -r requirements.txt
cp .env.example .env     # fill in
python main.py           # standalone: runs ResearchCrew once, no API/payments
python main.py api       # FastAPI server
```

- The API port comes from `API_PORT` (default **8080**) and the host from `API_HOST` (default `0.0.0.0`). The README says port 8000, but the code uses 8080.
- **"Unmodified" means** running `main.py api` with only `.env` filled in. It then needs:
  - an OpenAI key, since the crew uses CrewAI's default LLM and `.env` asks for `OPENAI_API_KEY`;
  - a reachable Masumi Payment Service;
  - a registered `AGENT_IDENTIFIER`;
  - the selling wallet `SELLER_VKEY`.

### Env vars (`.env.example`)

| Var | Meaning |
|---|---|
| `PAYMENT_SERVICE_URL` | e.g. `http://localhost:3001/api/v1` |
| `PAYMENT_API_KEY` | Payment Service API key, sent as header `token` |
| `AGENT_IDENTIFIER` | from registration (`policyId+assetName`) |
| `PAYMENT_AMOUNT` | default `10000000` |
| `PAYMENT_UNIT` | default `lovelace` |
| `SELLER_VKEY` | selling wallet vkey (from `GET /payment-source`) |
| `OPENAI_API_KEY` | LLM |
| `NETWORK` | `Preprod` or `Mainnet` |

`PAYMENT_AMOUNT` and `PAYMENT_UNIT` are only echoed back in the response. The `amounts=` argument to `Payment` is commented out, so the service prices from the agent's registry metadata instead.

## How it serves MIP-003

Routes in `main.py`:

| Route | Present | Behaviour / deviations from MIP-003 |
|---|---|---|
| `POST /start_job` | yes | Body `StartJobRequest{identifier_from_purchaser: str, input_data: dict[str,str]}`. It reads `input_data["text"]` (a missing key gives 400). It returns `{"status":"success","job_id",…,"blockchainIdentifier","submitResultTime","unlockTime","externalDisputeUnlockTime","agentIdentifier","sellerVKey","identifierFromPurchaser","amounts","input_hash","payByTime"}`. **It returns `job_id`, not MIP-003's `id`**, and adds `status` and `amounts`. The times are whatever the Payment Service returns. |
| `GET /status?job_id=` | yes | Returns `{job_id, status, payment_status, result}`. `status` is one of `awaiting_payment`, `running`, `completed`, `failed`. `result` is `CrewOutput.raw` or null. Unknown id gives 404. |
| `GET /availability` | yes | `{"status":"available","type":"masumi-agent","message":"Server operational."}` |
| `GET /input_schema` | yes | `{"input_data":[{"id":"text","type":"string","name":"Task Description","data":{"description":…,"placeholder":…}}]}` |
| `POST /provide_input` | **no** | The README lists it, but `main.py` defines only the `ProvideInputRequest` model and no route. |
| `GET /demo` | no | |
| `GET /health` | yes (not MIP-003) | `{"status":"healthy"}` |

Jobs are held in an in-memory dict. The code says "DO NOT USE IN PRODUCTION".

## How it creates payments: yes, it calls the Payment Service

Flow in `start_job`:

1. It builds `masumi.payment.Payment(agent_identifier, config=Config(payment_service_url, payment_api_key), identifier_from_purchaser, input_data, network)`.
2. The constructor computes `input_hash = create_masumi_input_hash(input_data, identifier_from_purchaser)`, which is MIP-004 JCS + `";"` + SHA-256.
3. `await payment.create_payment_request()` sends **`POST {PAYMENT_SERVICE_URL}/payment/`** with header `token: PAYMENT_API_KEY` and this JSON:

   ```json
   {"agentIdentifier", "network", "paymentType": "Web3CardanoV1",
    "payByTime": now+12h (ISO), "submitResultTime": now+24h (ISO),
    "identifierFromPurchaser", "inputHash"}
   ```

4. `payment.start_status_monitoring(callback)` polls `POST /payment/resolve-blockchain-identifier` every 10 s. When it sees the funds are locked, it runs the crew.
5. It then calls `complete_payment`, which sends `POST /payment/submit-result {network, blockchainIdentifier, submitResultHash}`. The hash is `create_masumi_output_hash(result.raw, identifier_from_purchaser)`.

**Compatibility findings from the code (static reading, not executed):**

- pip-masumi 1.2.0 hard-codes `self.payment_type = "Web3CardanoV1"` and sends it as `paymentType`. The current service's `POST /payment` schema field is named `paymentSourceType`, not `paymentType`. The service also picks V1 or V2 from the agent's **registry policy**.
- For an agent registered under the V2 policy `67ab0c92…`, the service requires `supportedPaymentSourceIndex` (`src/routes/api/payments/index.ts` L179–184: "V2 Cardano payments require supportedPaymentSourceIndex"). pip-masumi 1.2.0 never sends it, so **the unmodified template will get HTTP 400 from `POST /payment` for a V2-registered agent.** It works only against a V1-registered agent, which means a V1 payment source (`SEED_V1_LEGACY=true`) or the V1-only `0.22.0` docker images.
- The service requires `identifierFromPurchaser` to be **hex, 14–26 chars**. The template passes the purchaser's string through unchanged. The README's own example `"identifier_from_purchaser": ""` would be rejected with 400.
- The output hash applies JSON escaping before hashing, which deviates from MIP-004 (see `mip-003.md`).

## How to register it (README §5–7)

1. Install and run the Masumi Payment Service (`http://localhost:3001`) and check `GET /api/v1/health/`.
2. Fund the Selling Wallet with test ADA: Cardano faucet or `https://dispenser.masumi.network/`.
3. Get the selling wallet's `walletVkey` from `GET /payment-source/` (the `"network": "PREPROD"` entry).
4. Call `POST /registry` (or use the admin dashboard, **AI Agents → Register**). Wait a few minutes, then read `agentIdentifier` from `GET /registry/`.
5. Put `AGENT_IDENTIFIER` and `PAYMENT_API_KEY` into `.env`.

The README's buyer example `POST /purchase {"agent_identifier": …}` is incomplete. The real required fields are listed in `masumi-payment-service.md`.
