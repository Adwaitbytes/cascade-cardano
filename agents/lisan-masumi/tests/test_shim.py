"""The shim changes exactly two fields of POST /payment and nothing else."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "shim"))
from payment_shim import create_app, rewrite_payment_body  # noqa: E402

PIP_MASUMI_BODY = {
    "agentIdentifier": "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b0102",
    "network": "Preprod",
    "paymentType": "Web3CardanoV1",
    "payByTime": "2026-10-01T11:27:54.711Z",
    "submitResultTime": "2026-10-01T23:27:54.711Z",
    "identifierFromPurchaser": "abcdef0123456789",
    "inputHash": "a9" * 32,
}


def recording_upstream() -> tuple[httpx.AsyncClient, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"status": "success", "data": {"echo": json.loads(request.content or b"null")}})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler)), seen


def test_rewrite_is_minimal() -> None:
    out = rewrite_payment_body(PIP_MASUMI_BODY, 0)
    assert "paymentType" not in out
    assert out["paymentSourceType"] == "Web3CardanoV2"
    assert out["supportedPaymentSourceIndex"] == 0
    assert {k: v for k, v in out.items() if k not in ("paymentSourceType", "supportedPaymentSourceIndex")} == {k: v for k, v in PIP_MASUMI_BODY.items() if k != "paymentType"}


def test_forwards_payment_rewritten_and_everything_else_verbatim() -> None:
    client, seen = recording_upstream()
    app = TestClient(create_app("http://pay.test/api/v1", 1, client))
    res = app.post("/api/v1/payment/", json=PIP_MASUMI_BODY, headers={"token": "k"})
    assert res.status_code == 200
    sent = json.loads(seen[0].content)
    assert sent["paymentSourceType"] == "Web3CardanoV2" and sent["supportedPaymentSourceIndex"] == 1 and "paymentType" not in sent
    assert seen[0].headers["token"] == "k"
    other = {"network": "Preprod", "blockchainIdentifier": "bid", "submitResultHash": "ab" * 32}
    app.post("/api/v1/payment/submit-result", json=other, headers={"token": "k"})
    assert json.loads(seen[1].content) == other
    app.get("/api/v1/payment", params={"network": "Preprod"})
    assert seen[2].url.params["network"] == "Preprod" and seen[2].method == "GET"


def test_payment_list_asks_for_v2_payments() -> None:
    """pip-masumi polls GET /payment/ with no source filter; a V2 service then lists V1 payments only (none)."""
    client, seen = recording_upstream()
    app = TestClient(create_app("http://pay.test/api/v1", 0, client))
    app.get("/api/v1/payment/", params={"network": "Preprod", "limit": "100"})
    assert dict(seen[0].url.params) == {"network": "Preprod", "limit": "100", "filterPaymentSourceType": "Web3CardanoV2"}
    app.get("/api/v1/payment/", params={"network": "Preprod", "filterPaymentSourceType": "Web3CardanoV1"})
    assert seen[1].url.params["filterPaymentSourceType"] == "Web3CardanoV1"
    app.get("/api/v1/payment/resolve-blockchain-identifier", params={"network": "Preprod"})
    assert "filterPaymentSourceType" not in seen[2].url.params
