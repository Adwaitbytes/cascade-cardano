"""MIP-003 input schema (Attachment 01) and server-side validation of ``input_data``.
Mirrors ``packages/agent/src/input-schema.ts``."""

from __future__ import annotations

import math
import re
from typing import Any
from urllib.parse import urlparse

from .hashing import jcs_sha256_hex

TEXT_TYPES = {"string", "text", "textarea", "email", "password", "tel", "url", "search", "hidden", "color"}
DATE_TYPES = {"date", "datetime-local", "time", "month", "week"}
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
TEL_RE = re.compile(r"^\+?[0-9 ()-]{3,32}$")


def input_fields(schema: dict[str, Any]) -> list[dict[str, Any]]:
    if "input_data" in schema:
        return list(schema["input_data"])
    return [f for group in schema["input_groups"] for f in group["input_data"]]


def input_schema_hash(schema: dict[str, Any]) -> str:
    return jcs_sha256_hex(schema)


def assert_input_schema(schema: dict[str, Any]) -> None:
    if ("input_data" in schema) == ("input_groups" in schema):
        raise ValueError("input schema must have exactly one of input_data or input_groups")
    seen: set[str] = set()
    for field in input_fields(schema):
        fid = field.get("id")
        if not fid or fid in seen:
            raise ValueError(f'input field id "{fid}" is empty or duplicated')
        seen.add(fid)
        if not field.get("name"):
            raise ValueError(f"input field {fid} needs a name")


def _values(field: dict[str, Any], name: str) -> list[str]:
    return [v["value"] for v in field.get("validations", []) if v.get("validation") == name]


def _bound(field: dict[str, Any], name: str) -> float | None:
    numbers: list[float] = []
    for v in _values(field, name):
        try:
            n = float(v)
        except ValueError:
            continue
        if math.isfinite(n):
            numbers.append(n)
    if not numbers:
        return None
    return max(numbers) if name == "min" else min(numbers)


def _fmt(n: float) -> str:
    return str(int(n)) if float(n).is_integer() else str(n)


def _field_errors(field: dict[str, Any], value: Any) -> list[str]:
    at = f"input_data.{field['id']}"
    lo, hi = _bound(field, "min"), _bound(field, "max")
    formats = _values(field, "format")
    kind = field["type"]
    errors: list[str] = []
    if kind in TEXT_TYPES or kind in DATE_TYPES:
        if not isinstance(value, str):
            return [f"{at} must be a string"]
        if kind not in DATE_TYPES:
            if lo is not None and len(value) < lo:
                errors.append(f"{at} must be at least {_fmt(lo)} characters")
            if hi is not None and len(value) > hi:
                errors.append(f"{at} must be at most {_fmt(hi)} characters")
        if "nonempty" in formats and not value.strip():
            errors.append(f"{at} must not be empty")
        if (kind == "email" or "email" in formats) and not EMAIL_RE.match(value):
            errors.append(f"{at} must be an email address")
        if kind == "url" or "url" in formats:
            parsed = urlparse(value)
            if parsed.scheme not in ("http", "https") or not parsed.netloc:
                errors.append(f"{at} must be an http(s) URL")
        if "tel-pattern" in formats and not TEL_RE.match(value):
            errors.append(f"{at} must be a phone number")
        return errors
    if kind in ("number", "range"):
        n: Any = value
        if isinstance(value, str) and value.strip():
            try:
                n = float(value)
            except ValueError:
                n = None
        if isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n):
            return [f"{at} must be a number"]
        if "integer" in formats and not float(n).is_integer():
            errors.append(f"{at} must be an integer")
        if lo is not None and n < lo:
            errors.append(f"{at} must be >= {_fmt(lo)}")
        if hi is not None and n > hi:
            errors.append(f"{at} must be <= {_fmt(hi)}")
        return errors
    if kind in ("boolean", "checkbox"):
        return [] if isinstance(value, bool) else [f"{at} must be a boolean"]
    if kind in ("option", "radio"):
        allowed = [v for v in (field.get("data") or {}).get("values", []) if isinstance(v, str)]
        picked = value if isinstance(value, list) else [value]
        if not all(isinstance(v, str) and v in allowed for v in picked):
            return [f"{at} must be one of {', '.join(allowed)}"]
        if lo is not None and len(picked) < lo:
            errors.append(f"{at} needs at least {_fmt(lo)} selections")
        if hi is not None and len(picked) > hi:
            errors.append(f"{at} allows at most {_fmt(hi)} selections")
        return errors
    if kind == "file":
        return [] if isinstance(value, str) else [f"{at} must be a URL string"]
    if kind == "none":
        return []
    return [f"{at} has unsupported input type {kind}"]


def validate_input_data(schema: dict[str, Any], data: Any) -> list[str]:
    """Validates ``input_data``; unknown keys are rejected so ``input_hash`` covers only known fields."""
    if not isinstance(data, dict):
        return ["input_data must be an object"]
    fields = input_fields(schema)
    known = {f["id"] for f in fields}
    errors = [f"input_data.{k} is not in the input schema" for k in data if k not in known]
    for field in fields:
        if field["type"] == "none":
            continue
        value = data.get(field["id"])
        if value is None:
            if "true" not in _values(field, "optional"):
                errors.append(f"input_data.{field['id']} is required")
            continue
        errors.extend(_field_errors(field, value))
    return errors
