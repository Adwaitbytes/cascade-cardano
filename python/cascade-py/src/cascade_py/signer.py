"""Agent signing. Handlers never see key material; the server asks an ``AgentSigner`` for a
``COSE_Sign1`` over a 32-byte hash. ``LocalKeySigner`` is for development and tests."""

from __future__ import annotations

from typing import Protocol

from .address import blake2b_224, enterprise_address, payment_key_hash
from .cose import cose_key, public_key_of, sign_cose1


class AgentSigner(Protocol):
    address: str
    key_hash: str
    cose_key: str

    async def sign_hash(self, payload: bytes) -> str: ...


class LocalKeySigner:
    def __init__(self, seed: bytes, address: str | None = None, network_id: int = 0) -> None:
        if len(seed) != 32:
            raise ValueError("secret key must be a 32-byte Ed25519 seed")
        self._seed = bytes(seed)
        public_key = public_key_of(self._seed)
        self.address = address or enterprise_address(public_key, network_id)
        self.key_hash = payment_key_hash(self.address)
        if self.key_hash != blake2b_224(public_key).hex():
            raise ValueError("secret key does not control the given address")
        self.cose_key = cose_key(public_key).hex()

    async def sign_hash(self, payload: bytes) -> str:
        return sign_cose1(payload, self._seed, self.address).signature
