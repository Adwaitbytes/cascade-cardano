"""x402 v2 wire helpers for ``/jobs`` and the payment plug points. ``PaymentVerifier`` is the
facilitator side (implemented by the Cascade facilitator client); ``PaymentRequirementsProvider``
builds the ``accepts`` list. Mirrors ``packages/agent/src/payment.ts``."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from .hashing import jcs

X402_VERSION = 2
NONCE_RE = re.compile(r"^[0-9a-f]{64}#\d+$")


@dataclass
class VerifyResult:
    is_valid: bool
    invalid_reason: str | None = None
    payer: str | None = None
    node: dict[str, str] | None = None


@dataclass
class SettleResponse:
    success: bool
    network: str
    transaction: str
    error_reason: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"success": self.success, "network": self.network, "transaction": self.transaction}
        if self.error_reason is not None:
            out["errorReason"] = self.error_reason
        if self.extra:
            out["extra"] = self.extra
        return out


class PaymentVerifier(Protocol):
    async def verify(self, payload: dict[str, Any], requirements: dict[str, Any]) -> VerifyResult: ...

    async def settle(self, payload: dict[str, Any], requirements: dict[str, Any]) -> SettleResponse: ...


class PaymentRequirementsProvider(Protocol):
    async def offer(self, ctx: dict[str, Any]) -> list[dict[str, Any]]: ...

    async def match(self, accepted: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any] | None: ...

    def discovery(self) -> list[dict[str, Any]]: ...


class StaticRequirements:
    """Requirements that depend only on the price; ``match`` accepts only a JCS-equal copy."""

    def __init__(self, build: Callable[[str, str], list[dict[str, Any]]], list_amount: str, list_asset: str) -> None:
        self._build = build
        self._amount = list_amount
        self._asset = list_asset

    async def offer(self, ctx: dict[str, Any]) -> list[dict[str, Any]]:
        return self._build(ctx["amount"], ctx["asset"])

    async def match(self, accepted: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any] | None:
        try:
            wanted = jcs(accepted)
        except (ValueError, TypeError):
            # Not canonicalisable (e.g. NaN or a non-JSON type): it cannot equal any offer.
            return None
        return next((r for r in self._build(ctx["amount"], ctx["asset"]) if jcs(r) == wanted), None)

    def discovery(self) -> list[dict[str, Any]]:
        return self._build(self._amount, self._asset)


def default_rail_requirement(network: str, pay_to: str, amount: str, asset: str, max_timeout_seconds: int = 600) -> dict[str, Any]:
    return {
        "scheme": "exact",
        "network": network,
        "amount": amount,
        "asset": asset,
        "payTo": pay_to,
        "maxTimeoutSeconds": max_timeout_seconds,
        "extra": {"assetTransferMethod": "default"},
    }


def encode_header(value: Any) -> str:
    return base64.b64encode(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()).decode()


def decode_header(header: str) -> Any:
    try:
        return json.loads(base64.b64decode(header, validate=True).decode())
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ValueError("header is not base64 JSON") from e


def parse_payment_payload(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("payment payload must be an object")
    if value.get("x402Version") != X402_VERSION:
        raise ValueError("unsupported x402Version")
    accepted = value.get("accepted")
    if not isinstance(accepted, dict) or accepted.get("scheme") != "exact" or not isinstance(accepted.get("payTo"), str) or not isinstance(accepted.get("amount"), str):
        raise ValueError("payment payload `accepted` is malformed")
    payload = value.get("payload")
    if not isinstance(payload, dict) or not isinstance(payload.get("transaction"), str) or not isinstance(payload.get("nonce"), str):
        raise ValueError("payment payload needs `payload.transaction` and `payload.nonce`")
    if not NONCE_RE.match(payload["nonce"]):
        raise ValueError("payload.nonce must be txHash#index")
    return value


def payment_key(header: str) -> str:
    return hashlib.sha256(header.encode()).hexdigest()
