from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from jsonschema import Draft202012Validator, FormatChecker

from export_schemas import AGENT_YAML, deref

VECTORS = json.loads((Path(__file__).parent / "vectors.json").read_text())


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(scope="session")
def vectors() -> dict[str, Any]:
    return VECTORS


_API = yaml.safe_load(AGENT_YAML.read_text())


def assert_contract(path: str, method: str, status: int, body: Any) -> None:
    """Validates a response body against packages/shared/openapi/agent.yaml."""
    response = _API["paths"][path][method]["responses"][str(status)]
    response = deref(response, _API)
    schema = response.get("content", {}).get("application/json", {}).get("schema")
    if schema is None:
        return
    errors = [e.message for e in Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(body)]
    assert not errors, f"{method.upper()} {path} {status} violates agent.yaml: {errors}"
