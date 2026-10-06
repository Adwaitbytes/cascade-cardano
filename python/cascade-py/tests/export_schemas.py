"""Writes src/cascade_py/schemas/quote_request.json, the dereferenced ``QuoteRequest`` schema from
packages/shared/openapi/agent.yaml. Run: uv run python tests/export_schemas.py"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[3]
AGENT_YAML = ROOT / "packages" / "shared" / "openapi" / "agent.yaml"
OUT = Path(__file__).resolve().parents[1] / "src" / "cascade_py" / "schemas" / "quote_request.json"


def deref(node: Any, spec: dict[str, Any]) -> Any:
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/"):
            target: Any = spec
            for part in ref[2:].split("/"):
                target = target[part]
            merged = {**deref(target, spec), **{k: deref(v, spec) for k, v in node.items() if k != "$ref"}}
            return merged
        return {k: deref(v, spec) for k, v in node.items()}
    if isinstance(node, list):
        return [deref(v, spec) for v in node]
    return node


def quote_request_schema() -> dict[str, Any]:
    spec = yaml.safe_load(AGENT_YAML.read_text())
    return deref(spec["components"]["schemas"]["QuoteRequest"], spec)


if __name__ == "__main__":
    OUT.write_text(json.dumps(quote_request_schema(), indent=2, sort_keys=True) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}")
