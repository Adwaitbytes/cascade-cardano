"""Bech32 (BIP-173) without the 90-character limit, as Cardano addresses need."""

from __future__ import annotations

CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_GEN = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)


def _polymod(values: list[int]) -> int:
    chk = 1
    for v in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            chk ^= _GEN[i] if (top >> i) & 1 else 0
    return chk


def _hrp_expand(hrp: str) -> list[int]:
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _convert(data: bytes | list[int], from_bits: int, to_bits: int, pad: bool) -> list[int]:
    acc = 0
    bits = 0
    out: list[int] = []
    maxv = (1 << to_bits) - 1
    for value in data:
        if value < 0 or value >> from_bits:
            raise ValueError("invalid data for bit conversion")
        acc = (acc << from_bits) | value
        bits += from_bits
        while bits >= to_bits:
            bits -= to_bits
            out.append((acc >> bits) & maxv)
    if pad:
        if bits:
            out.append((acc << (to_bits - bits)) & maxv)
    elif bits >= from_bits or ((acc << (to_bits - bits)) & maxv):
        raise ValueError("invalid padding")
    return out


def encode(hrp: str, data: bytes) -> str:
    words = _convert(data, 8, 5, True)
    checksum = _polymod(_hrp_expand(hrp) + words + [0] * 6) ^ 1
    words += [(checksum >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(CHARSET[w] for w in words)


def decode(text: str) -> tuple[str, bytes]:
    if text.lower() != text and text.upper() != text:
        raise ValueError("mixed case bech32")
    text = text.lower()
    pos = text.rfind("1")
    if pos < 1 or pos + 7 > len(text):
        raise ValueError("invalid bech32 separator position")
    hrp, rest = text[:pos], text[pos + 1 :]
    try:
        words = [CHARSET.index(c) for c in rest]
    except ValueError as e:
        raise ValueError("invalid bech32 character") from e
    if _polymod(_hrp_expand(hrp) + words) != 1:
        raise ValueError("invalid bech32 checksum")
    return hrp, bytes(_convert(words[:-6], 5, 8, False))
