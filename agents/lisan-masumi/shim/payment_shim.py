"""V1-to-V2 compatibility shim between the unmodified CrewAI Masumi template and a Masumi
Payment Service that has only a ``Web3CardanoV2`` payment source.

pip-masumi 1.2.0 (the template's ``masumi`` dependency, latest on PyPI and at upstream HEAD
5a54f5e) sends ``"paymentType": "Web3CardanoV1"`` and never sends ``supportedPaymentSourceIndex``.
The service needs ``paymentSourceType: "Web3CardanoV2"`` plus the index for V2 agents. This shim
rewrites exactly those two fields on ``POST /payment``. pip-masumi also polls ``GET /payment/`` with
no source filter, and a V2 service then lists only V1 payments (none), so the job never sees its
FundsLocked payment: the shim adds ``filterPaymentSourceType=Web3CardanoV2`` to that list request
when absent. Every other request, header and body is forwarded unchanged. It is Cascade infrastructure, not part of the agent; the template's code is
untouched (see ../verify.sh).
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import Response

HOP_HEADERS = {"host", "content-length", "connection", "transfer-encoding", "accept-encoding"}


def rewrite_payment_body(body: dict[str, Any], source_index: int) -> dict[str, Any]:
    """The only change the shim makes: V1 payment type to V2 source type plus the source index."""
    out = {k: v for k, v in body.items() if k != "paymentType"}
    out["paymentSourceType"] = "Web3CardanoV2"
    out["supportedPaymentSourceIndex"] = source_index
    return out


def create_app(upstream: str, source_index: int, client: httpx.AsyncClient | None = None) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    http = client or httpx.AsyncClient(timeout=60)
    upstream = upstream.rstrip("/")

    @app.api_route("/api/v1/{path:path}", methods=["GET", "POST", "PATCH", "DELETE"])
    async def forward(path: str, request: Request) -> Response:
        raw = await request.body()
        if request.method == "POST" and path.rstrip("/") == "payment" and raw:
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                body = None
            if isinstance(body, dict):
                raw = json.dumps(rewrite_payment_body(body, source_index)).encode()
        params = dict(request.query_params)
        if request.method == "GET" and path.rstrip("/") == "payment":
            params.setdefault("filterPaymentSourceType", "Web3CardanoV2")
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_HEADERS}
        res = await http.request(request.method, f"{upstream}/{path}", params=params, content=raw, headers=headers)
        passthrough = {k: v for k, v in res.headers.items() if k.lower() not in HOP_HEADERS | {"content-encoding"}}
        return Response(content=res.content, status_code=res.status_code, headers=passthrough)

    return app


def app_from_env() -> FastAPI:
    return create_app(os.environ["LISAN_SHIM_UPSTREAM"], int(os.environ.get("LISAN_SHIM_SOURCE_INDEX", "0")))
