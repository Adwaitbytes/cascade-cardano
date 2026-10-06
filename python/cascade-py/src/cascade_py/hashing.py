"""JCS (RFC 8785) hashing, MIP-004 input and output hashes, and the Cascade result hash (PRD 9.5)."""

from __future__ import annotations

import hashlib
import json
from typing import Any

import rfc8785


def jcs(value: Any) -> bytes:
    """Canonical JSON bytes of ``value`` (RFC 8785)."""
    return rfc8785.dumps(value)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def jcs_sha256(value: Any) -> bytes:
    return hashlib.sha256(jcs(value)).digest()


def jcs_sha256_hex(value: Any) -> str:
    return jcs_sha256(value).hex()


def input_hash(identifier_from_purchaser: str, input_data: Any) -> str:
    """MIP-004: ``sha256(identifier ; JCS(input_data))`` as lowercase hex."""
    return sha256_hex(identifier_from_purchaser.encode() + b";" + jcs(input_data))


def mip004_output_hash(identifier_from_purchaser: str, output: str) -> str:
    """MIP-004 output hash over the raw UTF-8 output text."""
    return sha256_hex(f"{identifier_from_purchaser};{output}".encode())


def pip_masumi_output_hash(identifier_from_purchaser: str, output: str) -> str:
    """The pip-masumi 1.2.0 variant, which JSON-escapes the output before hashing."""
    return mip004_output_hash(identifier_from_purchaser, json.dumps(output, ensure_ascii=False)[1:-1])


def result_hash(result: Any) -> str:
    """Cascade ``result_hash``: ``sha256(JCS(result))``, the 32 bytes that go into ``Submit``."""
    return jcs_sha256_hex(result)
