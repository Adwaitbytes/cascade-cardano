"""Shelley key addresses: raw bytes, payment key hash, and enterprise addresses (CIP-19)."""

from __future__ import annotations

import hashlib

from . import bech32

_KEY_PAYMENT_TYPES = {0, 2, 6}  # base key/key, base key/script, enterprise key
_BASE_TYPES = {0, 1, 2, 3}
_ENTERPRISE_TYPES = {6, 7}


def blake2b_224(data: bytes) -> bytes:
    return hashlib.blake2b(data, digest_size=28).digest()


def address_bytes(address: str) -> bytes:
    hrp, raw = bech32.decode(address)
    if hrp not in ("addr", "addr_test"):
        raise ValueError(f"not a payment address prefix: {hrp}")
    if not raw:
        raise ValueError("empty address")
    network = raw[0] & 0x0F
    if (hrp == "addr") != (network == 1):
        raise ValueError(f"address prefix {hrp} does not match network id {network}")
    kind = raw[0] >> 4
    if kind in _BASE_TYPES and len(raw) != 57:
        raise ValueError("base address must be 57 bytes")
    if kind in _ENTERPRISE_TYPES and len(raw) != 29:
        raise ValueError("enterprise address must be 29 bytes")
    if kind not in _BASE_TYPES | _ENTERPRISE_TYPES:
        raise ValueError(f"unsupported address type {kind}")
    return raw


def payment_key_hash(address: str | bytes) -> str:
    raw = address_bytes(address) if isinstance(address, str) else address
    if raw[0] >> 4 not in _KEY_PAYMENT_TYPES:
        raise ValueError("address has a script payment credential")
    return raw[1:29].hex()


def enterprise_address(public_key: bytes, network_id: int = 0) -> str:
    raw = bytes([0x60 | network_id]) + blake2b_224(public_key)
    return bech32.encode("addr" if network_id == 1 else "addr_test", raw)
