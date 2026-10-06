"""Payment backend for MIP-003 ``/start_job``. Mirrors ``packages/agent/src/start-job-payments.ts``."""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal, Protocol

import httpx

PaymentState = Literal["pending", "paid", "expired", "refunded"]
MINUTE_MS = 60_000
PURCHASER_ID_RE = re.compile(r"^[0-9a-fA-F]{14,26}$")


@dataclass
class StartJobTerms:
    blockchain_identifier: str
    pay_by_time: int
    submit_result_time: int
    unlock_time: int
    external_dispute_unlock_time: int
    agent_identifier: str
    seller_vkey: str


class StartJobPayments(Protocol):
    async def create(self, job_id: str, identifier_from_purchaser: str, input_hash: str) -> StartJobTerms: ...

    async def state(self, blockchain_identifier: str) -> PaymentState: ...

    async def submit_result(self, blockchain_identifier: str, result_hash: str) -> None: ...


def is_masumi_purchaser_id(value: str) -> bool:
    """The Masumi Payment Service requires 14 to 26 hex characters."""
    return bool(PURCHASER_ID_RE.match(value))


_PAID = {"FundsLocked", "ResultSubmitted", "Withdrawn", "Disputed", "DisputedWithdrawn"}
_REFUNDED = {"RefundRequested", "RefundWithdrawn"}


class MasumiPaymentServiceBackend:
    """Talks to the seller's own Masumi Payment Service (``/api/v1``). V2 sources need
    ``supported_payment_source_index`` (docs/research/crewai-quickstart.md)."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        agent_identifier: str,
        seller_vkey: str,
        network: Literal["Preprod", "Mainnet"],
        payment_source_type: Literal["Web3CardanoV1", "Web3CardanoV2"],
        work_ms: int,
        supported_payment_source_index: int | None = None,
        client: httpx.AsyncClient | None = None,
        now_ms: Any = None,
    ) -> None:
        if payment_source_type == "Web3CardanoV2" and supported_payment_source_index is None:
            raise ValueError("Web3CardanoV2 payment sources need supported_payment_source_index")
        self._base = base_url.rstrip("/")
        self._key = api_key
        self._agent = agent_identifier
        self._vkey = seller_vkey
        self._network = network
        self._source_type = payment_source_type
        self._index = supported_payment_source_index
        self._work_ms = work_ms
        self._client = client or httpx.AsyncClient(timeout=30)
        self._now = now_ms or (lambda: int(time.time() * 1000))

    async def _call(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        res = await self._client.post(f"{self._base}{path}", json=body, headers={"token": self._key})
        if res.status_code >= 400:
            raise RuntimeError(f"Masumi Payment Service {path} returned {res.status_code}: {res.text[:300]}")
        data = res.json().get("data")
        if not isinstance(data, dict):
            raise RuntimeError(f"Masumi Payment Service {path} returned no data")
        return data

    async def create(self, job_id: str, identifier_from_purchaser: str, input_hash: str) -> StartJobTerms:
        if not is_masumi_purchaser_id(identifier_from_purchaser):
            raise ValueError("identifier_from_purchaser must be 14 to 26 hex characters for Masumi")
        now = self._now()
        pay_by = now + 10 * MINUTE_MS
        submit = max(pay_by + 5 * MINUTE_MS, now + 15 * MINUTE_MS, pay_by + self._work_ms)
        unlock = submit + 15 * MINUTE_MS
        dispute = unlock + 15 * MINUTE_MS

        def iso(ms: int) -> str:
            return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")

        body: dict[str, Any] = {
            "inputHash": input_hash,
            "network": self._network,
            "agentIdentifier": self._agent,
            "identifierFromPurchaser": identifier_from_purchaser,
            "paymentSourceType": self._source_type,
            "payByTime": iso(pay_by),
            "submitResultTime": iso(submit),
            "unlockTime": iso(unlock),
            "externalDisputeUnlockTime": iso(dispute),
        }
        if self._index is not None:
            body["supportedPaymentSourceIndex"] = self._index
        data = await self._call("/payment", body)

        def ms(key: str) -> int:
            value = data.get(key)
            if isinstance(value, (int, float)):
                return int(value)
            if isinstance(value, str) and value.isdigit():
                return int(value)
            if isinstance(value, str):
                return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
            raise RuntimeError(f"Masumi Payment Service returned no {key}")

        identifier = data.get("blockchainIdentifier")
        if not isinstance(identifier, str) or not identifier:
            raise RuntimeError("Masumi Payment Service returned no blockchainIdentifier")
        return StartJobTerms(identifier, ms("payByTime"), ms("submitResultTime"), ms("unlockTime"), ms("externalDisputeUnlockTime"), self._agent, self._vkey)

    async def state(self, blockchain_identifier: str) -> PaymentState:
        data = await self._call("/payment/resolve-blockchain-identifier", {"blockchainIdentifier": blockchain_identifier, "network": self._network})
        on_chain = data.get("onChainState")
        if on_chain is None:
            return "pending"
        if on_chain in _PAID:
            return "paid"
        if on_chain in _REFUNDED:
            return "refunded"
        if on_chain == "FundsOrDatumInvalid":
            return "expired"
        raise RuntimeError(f"unknown Masumi onChainState {on_chain}")

    async def submit_result(self, blockchain_identifier: str, result_hash: str) -> None:
        await self._call("/payment/submit-result", {"network": self._network, "blockchainIdentifier": blockchain_identifier, "submitResultHash": result_hash})
