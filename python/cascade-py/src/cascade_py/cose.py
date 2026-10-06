"""CIP-8 ``COSE_Sign1`` over a 32-byte hash with an Ed25519 key, byte-compatible with
``packages/shared/src/cose.ts``: protected ``{1: -8, "address": raw}``, unprotected
``{"hashed": false}``, attached payload, and ``COSE_Key {1: 1, 3: -8, -1: 6, -2: pk}``.
Verification includes the Blake2b-224 key-to-address check."""

from __future__ import annotations

from dataclasses import dataclass

import cbor2
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .address import address_bytes, blake2b_224

ALG_EDDSA = -8
KTY_OKP = 1
CRV_ED25519 = 6


def public_key_of(seed: bytes) -> bytes:
    return Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)


def cose_key(public_key: bytes) -> bytes:
    if len(public_key) != 32:
        raise ValueError("Ed25519 public key must be 32 bytes")
    return cbor2.dumps({1: KTY_OKP, 3: ALG_EDDSA, -1: CRV_ED25519, -2: public_key})


def _sig_structure(protected: bytes, payload: bytes) -> bytes:
    return cbor2.dumps(["Signature1", protected, b"", payload])


def _key_matches_address(public_key: bytes, raw_address: bytes) -> str | None:
    if raw_address[0] >> 4 not in (0, 2, 6):
        return "address has a script payment credential"
    if blake2b_224(public_key) != raw_address[1:29]:
        return "blake2b_224(public key) does not match the address payment key hash"
    return None


@dataclass(frozen=True)
class CoseSignature:
    signature: str
    key: str


def sign_cose1(payload: bytes, seed: bytes, address: str) -> CoseSignature:
    if len(payload) != 32:
        raise ValueError("payload must be a 32-byte hash")
    if len(seed) != 32:
        raise ValueError("secret key must be a 32-byte Ed25519 seed")
    raw = address_bytes(address)
    public_key = public_key_of(seed)
    problem = _key_matches_address(public_key, raw)
    if problem is not None:
        raise ValueError(problem)
    protected = cbor2.dumps({1: ALG_EDDSA, "address": raw})
    signature = Ed25519PrivateKey.from_private_bytes(seed).sign(_sig_structure(protected, payload))
    sign1 = cbor2.dumps([protected, {"hashed": False}, payload, signature])
    return CoseSignature(signature=sign1.hex(), key=cose_key(public_key).hex())


def verify_cose1(signature_hex: str, key_hex: str, payload: bytes, address: str) -> tuple[bool, str]:
    """Returns ``(True, public_key_hex)`` or ``(False, reason)``."""
    try:
        expected_address = address_bytes(address)
        sign1 = cbor2.loads(bytes.fromhex(signature_hex))
        key = cbor2.loads(bytes.fromhex(key_hex))
    except (ValueError, cbor2.CBORDecodeError) as e:
        return False, f"malformed input: {e}"
    if isinstance(sign1, cbor2.CBORTag):
        if sign1.tag != 18:
            return False, f"unexpected CBOR tag {sign1.tag}"
        sign1 = sign1.value
    if not isinstance(sign1, list) or len(sign1) != 4:
        return False, "COSE_Sign1 must be an array of 4"
    protected, unprotected, body, signature = sign1
    if not isinstance(protected, bytes) or not isinstance(signature, bytes) or not isinstance(body, bytes):
        return False, "COSE_Sign1 fields must be byte strings with an attached payload"
    if not isinstance(unprotected, dict) or unprotected.get("hashed") is not False:
        return False, 'unprotected header must carry "hashed": false'
    try:
        header = cbor2.loads(protected)
    except cbor2.CBORDecodeError as e:
        return False, f"malformed protected header: {e}"
    if not isinstance(header, dict) or header.get(1) != ALG_EDDSA:
        return False, "protected header alg must be EdDSA (-8)"
    if header.get("address") != expected_address:
        return False, "protected header address does not match the claimed address"
    if body != payload:
        return False, "payload does not match the expected hash"
    if not isinstance(key, dict) or key.get(1) != KTY_OKP or key.get(3) != ALG_EDDSA or key.get(-1) != CRV_ED25519 or -4 in key:
        return False, "COSE_Key must be an Ed25519 OKP public key"
    public_key = key.get(-2)
    if not isinstance(public_key, bytes) or len(public_key) != 32:
        return False, "COSE_Key x must be a 32-byte public key"
    problem = _key_matches_address(public_key, expected_address)
    if problem is not None:
        return False, problem
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, _sig_structure(protected, body))
    except InvalidSignature:
        return False, "invalid Ed25519 signature"
    return True, public_key.hex()
