"""cascade-py must match the TypeScript implementation byte for byte (tests/vectors.json)."""

from __future__ import annotations

import asyncio
from typing import Any

from cascade_py import LocalKeySigner, input_hash, jcs, mip004_output_hash, pip_masumi_output_hash, result_hash, verify_cose1
from cascade_py.cose import sign_cose1
from cascade_py.hashing import jcs_sha256, jcs_sha256_hex
from cascade_py.input_schema import input_schema_hash


def test_hashes_match_typescript(vectors: dict[str, Any]) -> None:
    assert jcs(vectors["input"]).decode() == vectors["input_jcs"]
    assert input_hash(vectors["identifier"], vectors["input"]) == vectors["input_hash"]
    assert mip004_output_hash(vectors["identifier"], vectors["output_text"]) == vectors["mip004_output_hash"]
    assert pip_masumi_output_hash(vectors["identifier"], vectors["output_text"]) == vectors["pip_masumi_output_hash"]
    assert result_hash(vectors["result"]) == vectors["result_hash"]
    assert input_schema_hash(vectors["input_schema"]) == vectors["input_schema_hash"]
    assert jcs_sha256_hex(vectors["spec"]) == vectors["spec_hash"]
    body = dict(vectors["verdict_body"])
    assert jcs_sha256(body).hex() == vectors["verdict_signing_hash"]


def test_signer_and_cose_bytes_match_typescript(vectors: dict[str, Any]) -> None:
    signer = LocalKeySigner(bytes.fromhex(vectors["seed_hex"]))
    assert signer.address == vectors["address"]
    assert signer.key_hash == vectors["key_hash"]
    assert signer.cose_key == vectors["cose_key"]
    payload = bytes.fromhex(vectors["payload_hex"])
    assert asyncio.run(signer.sign_hash(payload)) == vectors["cose_sign1"]
    ok, detail = verify_cose1(vectors["cose_sign1"], vectors["cose_key"], payload, vectors["address"])
    assert ok, detail


def test_quote_signature_matches_typescript(vectors: dict[str, Any]) -> None:
    quote = vectors["quote"]
    unsigned = {k: v for k, v in quote.items() if k != "signature"}
    sig = sign_cose1(jcs_sha256(unsigned), bytes.fromhex(vectors["seed_hex"]), quote["payee"])
    assert sig.signature == quote["signature"]
    assert sig.key == quote["key"]


def test_verify_rejects_tampering_and_wrong_addresses(vectors: dict[str, Any]) -> None:
    payload = bytes.fromhex(vectors["payload_hex"])
    other = LocalKeySigner(bytes(32 * [1])).address
    assert verify_cose1(vectors["cose_sign1"], vectors["cose_key"], payload, other) == (False, "protected header address does not match the claimed address")
    ok, reason = verify_cose1(vectors["cose_sign1"], vectors["cose_key"], bytes(32), vectors["address"])
    assert not ok and "payload" in reason
    ok, _ = verify_cose1("zz", vectors["cose_key"], payload, vectors["address"])
    assert not ok


def test_signer_refuses_a_key_that_does_not_control_the_address(vectors: dict[str, Any]) -> None:
    try:
        LocalKeySigner(bytes(32 * [2]), vectors["address"])
    except ValueError as e:
        assert "does not control" in str(e)
    else:
        raise AssertionError("expected ValueError")
