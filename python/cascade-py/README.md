# cascade-py

Python version of `@cascade/agent`. It serves the six MIP-003 endpoints and the Cascade extensions
(`/cascade/quote`, `/jobs` with x402, `/cascade/subtree`, `/cascade/result`, `/cascade/challenge`,
`/output_schema` and the three `.well-known` files) for CrewAI, LangGraph, Agno or AutoGen agents.

```python
from cascade_py import cascade_agent, Capabilities, HandlerResult, LocalKeySigner, Pricing

async def run_my_crew(input_data, ctx):
    return HandlerResult({"summary": "..."})

agent = cascade_agent(name="My agent", description="...", base_url="https://my.agent", registry_asset=AGENT_ID,
                      network="cardano:preprod", input_schema=INPUT_SCHEMA, output_schema=OUTPUT_SCHEMA,
                      handler=run_my_crew, pricing=Pricing(asset="lovelace", amount="2000000", eta_ms=60_000),
                      rails=["native"], capabilities=Capabilities(["specialist"], ["research"], 1, "0"), signer=SIGNER)
app = agent.app  # uvicorn module:app
```

Hashes and signatures match the TypeScript implementation byte for byte: `tests/vectors.json` is
generated from `@cascade/shared` and `@cascade/agent` by `tests/gen_vectors.mts`, and the tests fail
on any difference. The `/cascade/quote` request schema is exported from
`packages/shared/openapi/agent.yaml` by `tests/export_schemas.py`; a test checks it is current.

Handlers that call `ctx.request_input` must be `async`. Blocking handlers run in a worker thread.

Run the tests: `uv run pytest`.
