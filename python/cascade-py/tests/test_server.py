"""Endpoint behaviour and contract checks against packages/shared/openapi/agent.yaml."""

from __future__ import annotations

import asyncio
import hashlib
from typing import Any

import httpx
import pytest

from cascade_py import (
    Capabilities,
    HandlerResult,
    LocalKeySigner,
    Pricing,
    SettleResponse,
    StaticRequirements,
    VerifyResult,
    cascade_agent,
    decode_header,
    default_rail_requirement,
    encode_header,
    jcs_sha256_hex,
    verify_cose1,
)
from cascade_py.hashing import jcs_sha256
from cascade_py.input_schema import input_schema_hash
from cascade_py.start_job import StartJobTerms
from conftest import assert_contract

pytestmark = pytest.mark.anyio

ASSET = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d"
AGENT_ID = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b0002"
TREE, NODE, TX = "11" * 28, "22" * 28, "ab" * 32
SIGNER = LocalKeySigner(bytes(32 * [5]))
OUTPUT = {"type": "object", "required": ["summary"], "additionalProperties": False, "properties": {"summary": {"type": "string", "minLength": 1}}}
INPUT = {"input_data": [{"id": "topic", "type": "string", "name": "Topic", "validations": [{"validation": "min", "value": "2"}]}]}


class FakeVerifier:
    def __init__(self) -> None:
        self.verify_calls = 0
        self.settle_calls = 0
        self.valid = True
        self.settles: list[SettleResponse] = []

    async def verify(self, payload: dict[str, Any], requirements: dict[str, Any]) -> VerifyResult:
        self.verify_calls += 1
        return VerifyResult(True, node={"tree_id": TREE, "node_id": NODE}) if self.valid else VerifyResult(False, "amount_too_low")

    async def settle(self, payload: dict[str, Any], requirements: dict[str, Any]) -> SettleResponse:
        self.settle_calls += 1
        return self.settles.pop(0) if self.settles else SettleResponse(True, "cardano:preprod", TX, extra={"status": "confirmed", "confirmations": 1})


async def summarise(data: dict[str, Any], ctx: Any) -> HandlerResult:
    ctx.log("echo", "00" * 32, "11" * 32, {"llm": "deterministic-fallback"})
    ctx.add_source("https://example.org/source")
    return HandlerResult({"summary": f"About {data['topic']}"})


def make(**overrides: Any) -> tuple[Any, FakeVerifier]:
    verifier = FakeVerifier()
    provider = StaticRequirements(lambda amount, asset: [default_rail_requirement("cardano:preprod", SIGNER.address, amount, asset)], "2000000", ASSET)
    kwargs: dict[str, Any] = dict(
        name="Py Agent",
        description="Summarises a topic.",
        base_url="https://py.agent.test",
        registry_asset=AGENT_ID,
        network="cardano:preprod",
        input_schema=INPUT,
        output_schema=OUTPUT,
        handler=summarise,
        pricing=Pricing(asset=ASSET, amount="2000000", eta_ms=60_000),
        rails=["native", "masumi"],
        capabilities=Capabilities(roles=["specialist"], categories=["research"], max_depth=1, bond_lovelace="0"),
        signer=SIGNER,
        payments=(provider, verifier),
        demo={"input": {"topic": "juice"}, "output": {"result": "About juice"}},
    )
    kwargs.update(overrides)
    return cascade_agent(**kwargs), verifier


def client(agent: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=agent.app), base_url="https://py.agent.test")


async def buy(c: httpx.AsyncClient, topic: str = "juice") -> tuple[httpx.Response, dict[str, Any], str, dict[str, Any]]:
    body = {"identifier_from_purchaser": "buyer-1", "input_data": {"topic": topic}}
    first = await c.post("/jobs", json=body)
    accepted = first.json()["accepts"][0]
    header = encode_header({"x402Version": 2, "accepted": accepted, "payload": {"transaction": "84a4", "nonce": f"{'cd' * 32}#0"}})
    paid = await c.post("/jobs", json=body, headers={"PAYMENT-SIGNATURE": header})
    return paid, first.json(), header, body


def spec(**over: Any) -> dict[str, Any]:
    s = {
        "version": "1",
        "id": "research",
        "task": "Research",
        "category": "research",
        "input_schema": {"type": "object"},
        "output_schema": OUTPUT,
        "acceptance": "ParentAccept",
        "rail": "native",
        "price": {"asset": ASSET, "max_budget": "5000000", "max_fee": "2000000"},
        "deadlines": {"work_ms": 1_200_000, "compose_ms": 0, "challenge_window_ms": 600_000, "dispute_window_ms": 600_000},
        "may_sub_hire": False,
        "max_sub_budget_share_bps": 0,
        "verifier": {"deterministic": ["schema", "result_hash"], "quorum": None, "challenge": True, "arbitration": True},
    }
    s.update(over)
    return s


async def test_mip003_static_endpoints_follow_the_contract() -> None:
    agent, _ = make()
    async with client(agent) as c:
        for path in ["/availability", "/input_schema", "/demo"]:
            res = await c.get(path)
            assert res.status_code == 200
            assert_contract(path, "get", 200, res.json())
        assert (await c.get("/status", params={"job_id": "nope"})).status_code == 404
        assert (await c.get("/status")).status_code == 400
        assert (await c.post("/start_job", json={"identifier_from_purchaser": "abcdef0123456789", "input_data": {"topic": "juice"}})).status_code == 500
        assert (await c.post("/start_job", json={"identifier_from_purchaser": "abcdef0123456789", "input_data": {"topic": "j"}})).status_code == 400


async def test_start_job_with_masumi_backend_polls_runs_and_submits_mip004_hash() -> None:
    submitted: list[tuple[str, str]] = []
    polls = {"n": 0}

    class Backend:
        async def create(self, job_id: str, identifier: str, digest: str) -> StartJobTerms:
            return StartJobTerms("bid-1", 1_800_000_000_000, 1_800_000_900_000, 1_800_001_800_000, 1_800_002_700_000, AGENT_ID, SIGNER.key_hash)

        async def state(self, identifier: str) -> str:
            polls["n"] += 1
            return "pending" if polls["n"] < 2 else "paid"

        async def submit_result(self, identifier: str, digest: str) -> None:
            submitted.append((identifier, digest))

    agent, _ = make(start_job_payments=Backend(), payment_poll_s=0.01, now_ms=lambda: 1_799_999_000_000)
    async with client(agent) as c:
        res = await c.post("/start_job", json={"identifier_from_purchaser": "abcdef0123456789", "input_data": {"topic": "juice"}})
        assert res.status_code == 200
        body = res.json()
        assert_contract("/start_job", "post", 200, body)
        assert body["input_hash"] == hashlib.sha256(b'abcdef0123456789;{"topic":"juice"}').hexdigest()
        for _ in range(200):
            if (await c.get("/status", params={"job_id": body["id"]})).json()["status"] == "completed":
                break
            await asyncio.sleep(0.01)
        status = (await c.get("/status", params={"job_id": body["id"]})).json()
        assert_contract("/status", "get", 200, status)
        assert status["result"] == '{"summary":"About juice"}'
        for _ in range(100):
            if submitted:
                break
            await asyncio.sleep(0.01)
        assert submitted == [("bid-1", hashlib.sha256(b'abcdef0123456789;{"summary":"About juice"}').hexdigest())]
    await agent.close()


async def test_jobs_x402_flow_is_idempotent_and_contract_clean() -> None:
    agent, verifier = make()
    async with client(agent) as c:
        paid, required, header, body = await buy(c)
        assert_contract("/jobs", "post", 402, required)
        assert paid.status_code == 200
        assert_contract("/jobs", "post", 200, paid.json())
        assert decode_header(paid.headers["PAYMENT-RESPONSE"])["transaction"] == TX
        job_id = paid.json()["job_id"]
        await agent.when_done(job_id)
        again = await c.post("/jobs", json=body, headers={"PAYMENT-SIGNATURE": header})
        assert again.json()["job_id"] == job_id and verifier.settle_calls == 1
        other = await c.post("/jobs", json={**body, "input_data": {"topic": "another"}}, headers={"PAYMENT-SIGNATURE": header})
        assert other.status_code == 402
        result = await c.get("/cascade/result", params={"job_id": job_id})
        bundle = result.json()
        assert_contract("/cascade/result", "get", 200, bundle)
        assert bundle["result_hash"] == jcs_sha256_hex({"summary": "About juice"})
        assert bundle["evidence"]["journal_hash"] == jcs_sha256_hex(bundle["evidence"]["journal"])


async def test_settlement_pending_and_invalid_payments() -> None:
    agent, verifier = make()
    verifier.settles = [SettleResponse(False, "cardano:preprod", TX, "settlement_pending")]
    async with client(agent) as c:
        paid, _, header, body = await buy(c)
        assert paid.status_code == 402 and paid.json()["error"] == "settlement_pending"
        retry = await c.post("/jobs", json=body, headers={"PAYMENT-SIGNATURE": header})
        assert retry.status_code == 200 and verifier.verify_calls == 1 and verifier.settle_calls == 2
    agent2, verifier2 = make()
    verifier2.valid = False
    async with client(agent2) as c:
        paid, _, _, body = await buy(c)
        assert paid.status_code == 402 and paid.json()["error"] == "amount_too_low"
        assert (await c.post("/jobs", json=body, headers={"PAYMENT-SIGNATURE": "not base64!"})).status_code == 402


async def test_quote_is_signed_and_verifiable() -> None:
    now = 1_800_000_000_000
    agent, _ = make(now_ms=lambda: now)
    async with client(agent) as c:
        s = spec()
        req = {"spec": s, "spec_hash": jcs_sha256_hex(s), "window": {"start_by": now, "submit_by": now + 3_600_000}}
        res = await c.post("/cascade/quote", json=req)
        assert res.status_code == 200
        quote = res.json()
        assert_contract("/cascade/quote", "post", 200, quote)
        unsigned = {k: v for k, v in quote.items() if k != "signature"}
        ok, detail = verify_cose1(quote["signature"], quote["key"], jcs_sha256(unsigned), quote["payee"])
        assert ok, detail
        declined = await c.post("/cascade/quote", json={**req, "spec": spec(category="translation"), "spec_hash": jcs_sha256_hex(spec(category="translation"))})
        assert declined.status_code == 409
        assert_contract("/cascade/quote", "post", 409, declined.json())
        assert (await c.post("/cascade/quote", json={**req, "spec_hash": "00" * 32})).status_code == 400


async def test_awaiting_input_round_trip() -> None:
    extra = {"input_data": [{"id": "region", "type": "string", "name": "Region"}]}

    async def ask(data: dict[str, Any], ctx: Any) -> HandlerResult:
        more = await ctx.request_input(extra)
        return HandlerResult({"summary": f"Region {more['region']}"})

    agent, _ = make(handler=ask)
    async with client(agent) as c:
        paid, _, _, _ = await buy(c)
        job_id = paid.json()["job_id"]
        for _ in range(200):
            if (await c.get("/status", params={"job_id": job_id})).json()["status"] == "awaiting_input":
                break
            await asyncio.sleep(0.01)
        status = (await c.get("/status", params={"job_id": job_id})).json()
        assert_contract("/status", "get", 200, status)
        res = await c.post("/provide_input", json={"job_id": job_id, "input_schema_hash": input_schema_hash(extra), "input_data": {"region": "Dubai"}})
        assert res.status_code == 200
        assert_contract("/provide_input", "post", 200, res.json())
        await agent.when_done(job_id)
        assert (await c.get("/status", params={"job_id": job_id})).json()["status"] == "completed"


async def test_output_schema_violation_and_sync_handlers() -> None:
    async def bad(data: dict[str, Any], ctx: Any) -> HandlerResult:
        return HandlerResult({"wrong": True})

    agent, _ = make(handler=bad)
    async with client(agent) as c:
        paid, _, _, _ = await buy(c)
        await agent.when_done(paid.json()["job_id"])
        status = (await c.get("/status", params={"job_id": paid.json()["job_id"]})).json()
        assert status["status"] == "failed" and "output schema" in status["message"]
        assert (await c.get("/cascade/result", params={"job_id": paid.json()["job_id"]})).status_code == 409

    def blocking(data: dict[str, Any], ctx: Any) -> HandlerResult:
        return HandlerResult({"summary": "from a thread"})

    agent2, _ = make(handler=blocking)
    async with client(agent2) as c:
        paid, _, _, _ = await buy(c)
        await agent2.when_done(paid.json()["job_id"])
        assert (await c.get("/status", params={"job_id": paid.json()["job_id"]})).json()["status"] == "completed"


async def test_subtree_challenge_and_discovery() -> None:
    agent, _ = make(notice="Test agent: fails on purpose to demonstrate refunds.")
    async with client(agent) as c:
        paid, _, _, _ = await buy(c)
        job_id = paid.json()["job_id"]
        await agent.when_done(job_id)
        sub = await c.get("/cascade/subtree", params={"job_id": job_id})
        assert sub.status_code == 200
        report = sub.json()
        assert_contract("/cascade/subtree", "get", 200, report)
        unsigned = {k: v for k, v in report.items() if k != "signature"}
        assert verify_cose1(report["signature"], report["key"], jcs_sha256(unsigned), SIGNER.address)[0]
        reason = {"schema_errors": ["x"]}
        bad = await c.post("/cascade/challenge", json={"tree_id": TREE, "node_id": NODE, "reason_hash": "00" * 32, "reason": reason})
        assert bad.status_code == 400
        res = await c.post("/cascade/challenge", json={"tree_id": TREE, "node_id": NODE, "reason_hash": jcs_sha256_hex(reason), "reason": reason})
        assert res.status_code == 200
        assert_contract("/cascade/challenge", "post", 200, res.json())
        for path in ["/output_schema", "/.well-known/x402.json", "/.well-known/cascade.json", "/.well-known/agent-card.json"]:
            r = await c.get(path)
            assert r.status_code == 200
            assert_contract(path, "get", 200, r.json())
        assert (await c.get("/.well-known/cascade.json")).json()["notice"].startswith("Test agent")
        assert (await c.get("/availability")).json()["message"].startswith("Test agent")
        assert (await c.post("/cascade/quote", content=b"x" * (300 * 1024))).status_code == 400


async def test_recover_fails_jobs_left_running() -> None:
    async def forever(data: dict[str, Any], ctx: Any) -> HandlerResult:
        await asyncio.sleep(3600)
        raise AssertionError("unreachable")

    agent, _ = make(handler=forever)
    async with client(agent) as c:
        paid, _, _, _ = await buy(c)
        job_id = paid.json()["job_id"]
        await asyncio.sleep(0.05)
        restarted, _ = make(store=agent.store)
        await restarted.recover()
        assert (await restarted.store.get(job_id))["status"] == "failed"
    await agent.close()
