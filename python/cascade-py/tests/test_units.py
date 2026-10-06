from __future__ import annotations

import json
from pathlib import Path

import pytest

from cascade_py.input_schema import assert_input_schema, validate_input_data
from cascade_py.status import InvalidTransitionError, assert_transition, is_terminal
from export_schemas import quote_request_schema

SCHEMA = {
    "input_data": [
        {"id": "text", "type": "string", "name": "Text", "validations": [{"validation": "format", "value": "nonempty"}]},
        {"id": "count", "type": "number", "name": "Count", "validations": [{"validation": "format", "value": "integer"}, {"validation": "min", "value": "1"}]},
        {"id": "lang", "type": "option", "name": "Language", "data": {"values": ["ar", "en"]}, "validations": [{"validation": "max", "value": "1"}]},
        {"id": "site", "type": "url", "name": "Site", "validations": [{"validation": "optional", "value": "true"}]},
        {"id": "note", "type": "none", "name": "Note"},
    ]
}


def test_validation_matches_the_typescript_rules() -> None:
    assert validate_input_data(SCHEMA, {"text": "hello", "count": 2, "lang": ["ar"]}) == []
    assert validate_input_data(SCHEMA, {"text": "hello", "count": "3", "lang": "en", "site": "https://x.org"}) == []
    errors = validate_input_data(SCHEMA, {"text": " ", "count": 1.5, "lang": ["fr"], "site": "ftp://x", "junk": 1})
    for expected in [
        "input_data.junk is not in the input schema",
        "input_data.text must not be empty",
        "input_data.count must be an integer",
        "input_data.lang must be one of ar, en",
        "input_data.site must be an http(s) URL",
    ]:
        assert expected in errors
    assert validate_input_data(SCHEMA, []) == ["input_data must be an object"]
    assert "input_data.text is required" in validate_input_data(SCHEMA, {})
    with pytest.raises(ValueError, match="duplicated"):
        assert_input_schema({"input_data": [{"id": "a", "type": "string", "name": "A"}, {"id": "a", "type": "string", "name": "B"}]})


def test_status_machine() -> None:
    assert_transition("awaiting_payment", "running")
    assert_transition("running", "awaiting_input")
    with pytest.raises(InvalidTransitionError):
        assert_transition("completed", "failed")
    assert is_terminal("failed") and not is_terminal("running")


def test_vendored_quote_schema_matches_agent_yaml() -> None:
    vendored = json.loads((Path(__file__).parents[1] / "src" / "cascade_py" / "schemas" / "quote_request.json").read_text())
    assert vendored == quote_request_schema(), "run: uv run python tests/export_schemas.py"
