"""``cascade_agent(...)``: a FastAPI app serving the six MIP-003 endpoints unchanged plus the
Cascade extensions (PRD 9.1, 9.2), matching ``packages/shared/openapi/agent.yaml`` and the
TypeScript server in ``packages/agent``."""

from __future__ import annotations

import asyncio
import inspect
import json
import time
import uuid
from dataclasses import dataclass, field
from importlib import resources
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from jsonschema import Draft202012Validator, FormatChecker

from .hashing import input_hash, jcs, jcs_sha256, jcs_sha256_hex, mip004_output_hash, result_hash
from .input_schema import assert_input_schema, input_schema_hash, validate_input_data
from .payment import (
    X402_VERSION,
    PaymentRequirementsProvider,
    PaymentVerifier,
    decode_header,
    encode_header,
    parse_payment_payload,
    payment_key,
)
from .signer import AgentSigner
from .start_job import StartJobPayments
from .status import assert_transition
from .store import DuplicateJobError, InMemoryJobStore, JobStore

MAX_ERROR_CHARS = 500


@dataclass
class Pricing:
    asset: str
    amount: str
    eta_ms: int
    quote_ttl_ms: int = 10 * 60_000
    max_sub_budget_share_bps: int = 0


@dataclass
class Capabilities:
    roles: list[str]
    categories: list[str]
    max_depth: int
    bond_lovelace: str
    tags: list[str] = field(default_factory=list)


@dataclass
class HandlerResult:
    result: Any
    sources: list[dict[str, Any]] = field(default_factory=list)


class JobContext:
    """Passed to handlers. Handlers never see keys; they log tool calls by hash only."""

    def __init__(self, agent: "CascadeAgent", job: dict[str, Any]) -> None:
        self._agent = agent
        self.job_id: str = job["job_id"]
        self.identifier_from_purchaser: str = job["identifier_from_purchaser"]
        self.input_hash: str = job["input_hash"]
        self.node: dict[str, str] | None = job["node"]
        self.tool_log: list[dict[str, Any]] = []
        self.sources: list[dict[str, Any]] = []
        self.children: dict[str, dict[str, Any]] = {}

    def log(self, tool: str, input_sha256: str, output_sha256: str, meta: dict[str, Any] | None = None) -> None:
        entry: dict[str, Any] = {"at": self._agent.now(), "tool": tool, "input_sha256": input_sha256, "output_sha256": output_sha256}
        if meta:
            entry["meta"] = meta
        self.tool_log.append(entry)

    def add_source(self, url: str, quote: str | None = None) -> None:
        self.sources.append({"url": url} if quote is None else {"url": url, "quote": quote})

    def report_child(self, child: dict[str, Any]) -> None:
        self.children[child["node_id"]] = child

    async def request_input(self, schema: dict[str, Any]) -> dict[str, Any]:
        return await self._agent._await_input(self.job_id, schema)


Handler = Callable[[dict[str, Any], JobContext], Awaitable[HandlerResult] | HandlerResult]


def _journal(job: dict[str, Any], at: int, event: str, detail: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    entry: dict[str, Any] = {"seq": len(job["journal"]), "at": at, "event": event}
    if detail is not None:
        entry["detail"] = detail
    return [*job["journal"], entry]


def _transition(job: dict[str, Any], target: str, at: int, detail: dict[str, Any] | None = None) -> dict[str, Any]:
    assert_transition(job["status"], target)
    return {**job, "status": target, "updated_at": at, "journal": _journal(job, at, f"status.{target}", detail)}


def _error(status: int, error: str, detail: str | None = None) -> JSONResponse:
    return JSONResponse({"error": error} if detail is None else {"error": error, "detail": detail}, status_code=status)


def _load_quote_request_schema() -> Draft202012Validator:
    text = resources.files("cascade_py").joinpath("schemas/quote_request.json").read_text()
    return Draft202012Validator(json.loads(text), format_checker=FormatChecker())


def _quote_request_errors(body: Any, validator: Draft202012Validator) -> list[str]:
    errors = [f"{'/'.join(str(p) for p in e.absolute_path)}: {e.message}" for e in validator.iter_errors(body)]
    if errors:
        return errors[:20]
    spec = body["spec"]
    if int(spec["price"]["max_fee"]) > int(spec["price"]["max_budget"]):
        errors.append("max_fee must be <= max_budget")
    if (spec["acceptance"] == "VerifierQuorum") != (spec["verifier"]["quorum"] is not None):
        errors.append("verifier.quorum is set exactly for VerifierQuorum")
    if spec["rail"] != "native" and spec["may_sub_hire"]:
        errors.append("only native nodes may sub-hire")
    if (spec["rail"] == "address") != ("payee_hash" in spec):
        errors.append("payee_hash is set exactly for the address rail")
    if jcs_sha256_hex(spec) != body["spec_hash"]:
        errors.append("spec_hash must equal SHA-256(JCS(spec))")
    return errors


class CascadeAgent:
    def __init__(
        self,
        *,
        name: str,
        description: str,
        base_url: str,
        registry_asset: str,
        network: str,
        input_schema: dict[str, Any],
        output_schema: dict[str, Any],
        handler: Handler,
        pricing: Pricing,
        rails: list[str],
        capabilities: Capabilities,
        signer: AgentSigner,
        store: JobStore | None = None,
        payments: tuple[PaymentRequirementsProvider, PaymentVerifier] | None = None,
        start_job_payments: StartJobPayments | None = None,
        demo: dict[str, Any] | None = None,
        notice: str | None = None,
        version: str = "0.1.0",
        job_timeout_s: float = 30 * 60,
        payment_poll_s: float = 10,
        max_body_bytes: int = 256 * 1024,
        now_ms: Callable[[], int] | None = None,
    ) -> None:
        assert_input_schema(input_schema)
        Draft202012Validator.check_schema(output_schema)
        self.name = name
        self.description = description
        self.base_url = base_url
        self.registry_asset = registry_asset
        self.network = network
        self.input_schema = input_schema
        self.output_schema = output_schema
        self.handler = handler
        self.pricing = pricing
        self.rails = rails
        self.capabilities = capabilities
        self.signer = signer
        self.store: JobStore = store or InMemoryJobStore()
        self.payments = payments
        self.start_job_payments = start_job_payments
        self.demo = demo
        self.notice = notice
        self.version = version
        self.job_timeout_s = job_timeout_s
        self.payment_poll_s = payment_poll_s
        self.max_body_bytes = max_body_bytes
        self.now: Callable[[], int] = now_ms or (lambda: int(time.time() * 1000))
        self._output_validator = Draft202012Validator(output_schema, format_checker=FormatChecker())
        self._quote_validator = _load_quote_request_schema()
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._pollers: dict[str, asyncio.Task[None]] = {}
        self._input_waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.errors: list[tuple[str, BaseException]] = []
        self.app = self._build_app()

    # ------------------------------------------------------------------ jobs

    def _new_job(self, identifier: str, data: dict[str, Any], channel: str, spec_hash: str | None = None, quote_id: str | None = None, key: str | None = None) -> dict[str, Any]:
        now = self.now()
        job: dict[str, Any] = {
            "job_id": str(uuid.uuid4()),
            "status": "awaiting_payment",
            "identifier_from_purchaser": identifier,
            "input_data": data,
            "input_hash": input_hash(identifier, data),
            "spec_hash": spec_hash,
            "quote_id": quote_id,
            "node": None,
            "payment": {
                "channel": channel,
                "blockchain_identifier": None,
                "pay_by_time": None,
                "submit_result_time": None,
                "unlock_time": None,
                "external_dispute_unlock_time": None,
                "payment_key": key,
                "tx_id": None,
                "network": None,
            },
            "awaiting_input_schema": None,
            "result": None,
            "result_hash": None,
            "error": None,
            "sources": [],
            "tool_log": [],
            "journal": [],
            "children": [],
            "created_at": now,
            "updated_at": now,
        }
        job["journal"] = _journal(job, now, "job.created", {"input_hash": job["input_hash"], "channel": channel})
        return job

    def _record_error(self, where: str, error: BaseException) -> None:
        self.errors.append((where, error))

    async def _fail(self, job_id: str, reason: str) -> None:
        reason = reason[:MAX_ERROR_CHARS]

        def mutate(j: dict[str, Any]) -> dict[str, Any]:
            if j["status"] in ("completed", "failed"):
                return j
            return {**_transition(j, "failed", self.now(), {"reason": reason}), "error": reason}

        await self.store.update(job_id, mutate)

    async def _await_input(self, job_id: str, schema: dict[str, Any]) -> dict[str, Any]:
        await self.store.update(job_id, lambda j: {**_transition(j, "awaiting_input", self.now()), "awaiting_input_schema": schema})
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._input_waiters[job_id] = future
        try:
            data = await future
        finally:
            self._input_waiters.pop(job_id, None)
        await self.store.update(job_id, lambda j: {**_transition(j, "running", self.now(), {"input": "provided"}), "awaiting_input_schema": None})
        return data

    async def _run(self, job_id: str) -> None:
        job = await self.store.update(job_id, lambda j: _transition(j, "running", self.now()))
        ctx = JobContext(self, job)
        try:
            if inspect.iscoroutinefunction(self.handler):
                outcome = await asyncio.wait_for(self.handler(job["input_data"], ctx), timeout=self.job_timeout_s)
            else:
                # Blocking handlers (e.g. a CrewAI kickoff) run in a worker thread.
                outcome = await asyncio.wait_for(asyncio.to_thread(self.handler, job["input_data"], ctx), timeout=self.job_timeout_s)
            if not isinstance(outcome, HandlerResult):
                raise TypeError("handler must return a HandlerResult")
        except asyncio.TimeoutError:
            await self._fail(job_id, f"job exceeded {self.job_timeout_s} s")
            return
        except Exception as e:  # noqa: BLE001 - any handler failure fails the job and is recorded
            self._record_error(f"job {job_id}", e)
            await self._fail(job_id, str(e) or type(e).__name__)
            return
        schema_errors = [f"/{'/'.join(str(p) for p in e.absolute_path)} {e.message}" for e in self._output_validator.iter_errors(outcome.result)]
        if schema_errors:
            await self._fail(job_id, "result does not match the output schema: " + "; ".join(schema_errors[:20]))
            return
        digest = result_hash(outcome.result)

        def complete(j: dict[str, Any]) -> dict[str, Any]:
            done = _transition(j, "completed", self.now(), {"result_hash": digest})
            return {
                **done,
                "result": outcome.result,
                "result_hash": digest,
                "sources": [*ctx.sources, *outcome.sources],
                "tool_log": [*j["tool_log"], *ctx.tool_log],
                "children": list(ctx.children.values()),
            }

        completed = await self.store.update(job_id, complete)
        await self._submit_to_masumi(completed)

    async def _submit_to_masumi(self, job: dict[str, Any]) -> None:
        backend = self.start_job_payments
        identifier = job["payment"]["blockchain_identifier"]
        if backend is None or job["payment"]["channel"] != "masumi" or identifier is None:
            return
        digest = mip004_output_hash(job["identifier_from_purchaser"], jcs(job["result"]).decode())
        try:
            await backend.submit_result(identifier, digest)
            event, detail = "masumi.result_submitted", {"submit_result_hash": digest}
        except Exception as e:  # noqa: BLE001 - recorded in the journal and the error list
            self._record_error(f"masumi submit {job['job_id']}", e)
            event, detail = "masumi.submit_failed", {"reason": str(e)[:MAX_ERROR_CHARS]}
        await self.store.update(job["job_id"], lambda j: {**j, "journal": _journal(j, self.now(), event, detail)})

    def start(self, job_id: str) -> asyncio.Task[None]:
        task = self._tasks.get(job_id)
        if task is None:
            task = asyncio.create_task(self._run(job_id))
            self._tasks[job_id] = task
        return task

    async def when_done(self, job_id: str) -> None:
        task = self._tasks.get(job_id)
        if task is not None:
            await task

    async def confirm_payment(self, job_id: str, tx_id: str | None = None, node: dict[str, str] | None = None) -> None:
        def mutate(j: dict[str, Any]) -> dict[str, Any]:
            if j["status"] != "awaiting_payment":
                return j
            return {
                **j,
                "node": node or j["node"],
                "payment": {**j["payment"], "tx_id": tx_id or j["payment"]["tx_id"]},
                "journal": _journal(j, self.now(), "payment.confirmed", None if tx_id is None else {"tx_id": tx_id}),
            }

        job = await self.store.update(job_id, mutate)
        if job["status"] == "awaiting_payment":
            self.start(job_id)

    def _watch_payment(self, job: dict[str, Any]) -> None:
        backend = self.start_job_payments
        identifier = job["payment"]["blockchain_identifier"]
        if backend is None or identifier is None or job["job_id"] in self._pollers:
            return

        async def poll() -> None:
            while True:
                try:
                    state = await backend.state(identifier)
                except Exception as e:  # noqa: BLE001 - transient backend errors are retried
                    self._record_error(f"payment poll {job['job_id']}", e)
                    await asyncio.sleep(self.payment_poll_s)
                    continue
                pay_by = job["payment"]["pay_by_time"]
                if state == "pending" and (pay_by is None or self.now() <= pay_by):
                    await asyncio.sleep(self.payment_poll_s)
                    continue
                if state == "paid":
                    await self.confirm_payment(job["job_id"])
                else:
                    reason = f"payment {state}"

                    def mutate(j: dict[str, Any]) -> dict[str, Any]:
                        return {**_transition(j, "failed", self.now(), {"reason": reason}), "error": reason} if j["status"] == "awaiting_payment" else j

                    await self.store.update(job["job_id"], mutate)
                return

        self._pollers[job["job_id"]] = asyncio.create_task(poll())

    async def recover(self) -> None:
        """Fails jobs a crashed process left running and resumes Masumi payment polling."""
        reason = "agent restarted before the job finished"
        for job in await self.store.list_by_status(("running", "awaiting_input")):
            await self.store.update(job["job_id"], lambda j: {**_transition(j, "failed", self.now(), {"reason": reason}), "error": reason} if j["status"] in ("running", "awaiting_input") else j)
        for job in await self.store.list_by_status(("awaiting_payment",)):
            if job["payment"]["channel"] == "masumi":
                self._watch_payment(job)

    async def close(self) -> None:
        for task in [*self._pollers.values(), *self._tasks.values()]:
            task.cancel()
        await asyncio.gather(*self._pollers.values(), *self._tasks.values(), return_exceptions=True)

    async def _sign_body(self, body: dict[str, Any]) -> dict[str, Any]:
        with_key = {**body, "key": self.signer.cose_key}
        return {**with_key, "signature": await self.signer.sign_hash(jcs_sha256(with_key))}

    def _result_bundle(self, job: dict[str, Any]) -> dict[str, Any]:
        bundle: dict[str, Any] = {
            "job_id": job["job_id"],
            "result": job["result"],
            "result_hash": job["result_hash"],
            "evidence": {
                "sources": job["sources"],
                "tool_log_hash": jcs_sha256_hex(job["tool_log"]),
                "journal_hash": jcs_sha256_hex(job["journal"]),
                "tool_log": job["tool_log"],
                "journal": job["journal"],
            },
        }
        if self.notice is not None:
            bundle["notice"] = self.notice
        return bundle

    # ------------------------------------------------------------------ HTTP

    def _build_app(self) -> FastAPI:
        app = FastAPI(title=self.name, description=self.description, version=self.version, docs_url=None, redoc_url=None, openapi_url=None)
        agent = self

        async def read_json(request: Request) -> dict[str, Any] | None:
            raw = await request.body()
            if len(raw) > agent.max_body_bytes:
                return None
            try:
                body = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                return None
            return body if isinstance(body, dict) else None

        @app.exception_handler(Exception)
        async def on_error(_request: Request, exc: Exception) -> JSONResponse:
            agent._record_error("http", exc)
            return _error(500, "internal_error")

        @app.post("/start_job")
        async def start_job(request: Request) -> Response:
            body = await read_json(request)
            if body is None:
                return _error(400, "invalid_json")
            identifier = body.get("identifier_from_purchaser")
            data = body.get("input_data", {})
            if not isinstance(identifier, str) or not 0 < len(identifier) <= 256:
                return _error(400, "invalid_identifier_from_purchaser")
            if not isinstance(data, dict):
                return _error(400, "invalid_input_data")
            problems = validate_input_data(agent.input_schema, data)
            if problems:
                return _error(400, "invalid_input_data", "; ".join(problems))
            backend = agent.start_job_payments
            if backend is None:
                return _error(500, "payment_backend_not_configured", "this agent sells through /jobs (x402)")
            job = agent._new_job(identifier, data, "masumi")
            try:
                terms = await backend.create(job["job_id"], identifier, job["input_hash"])
            except Exception as e:  # noqa: BLE001 - reported to the caller as MIP-003 500
                agent._record_error("start_job payment", e)
                return _error(500, "payment_request_failed", str(e)[:200])
            job["payment"].update(
                blockchain_identifier=terms.blockchain_identifier,
                pay_by_time=terms.pay_by_time,
                submit_result_time=terms.submit_result_time,
                unlock_time=terms.unlock_time,
                external_dispute_unlock_time=terms.external_dispute_unlock_time,
            )
            await agent.store.create(job)
            agent._watch_payment(job)
            return JSONResponse(
                {
                    "id": job["job_id"],
                    "job_id": job["job_id"],
                    "status": "success",
                    "blockchainIdentifier": terms.blockchain_identifier,
                    "payByTime": terms.pay_by_time,
                    "submitResultTime": terms.submit_result_time,
                    "unlockTime": terms.unlock_time,
                    "externalDisputeUnlockTime": terms.external_dispute_unlock_time,
                    "agentIdentifier": terms.agent_identifier,
                    "sellerVKey": terms.seller_vkey,
                    "identifierFromPurchaser": identifier,
                    "input_hash": job["input_hash"],
                }
            )

        @app.get("/status")
        async def status(job_id: str | None = None) -> Response:
            if not job_id:
                return _error(400, "missing_job_id")
            job = await agent.store.get(job_id)
            if job is None:
                return _error(404, "job_not_found")
            out: dict[str, Any] = {"job_id": job["job_id"], "status": job["status"]}
            if job["status"] == "awaiting_input" and job["awaiting_input_schema"] is not None:
                out["input_schema"] = job["awaiting_input_schema"]
            if job["status"] == "completed" and job["result"] is not None:
                out["result"] = job["result"] if isinstance(job["result"], str) else jcs(job["result"]).decode()
            if job["result_hash"] is not None:
                out["result_hash"] = job["result_hash"]
            if job["error"] is not None:
                out["message"] = job["error"]
            return JSONResponse(out)

        @app.post("/provide_input")
        async def provide_input(request: Request) -> Response:
            body = await read_json(request)
            if body is None:
                return _error(400, "invalid_json")
            job_id, schema_hash, data = body.get("job_id"), body.get("input_schema_hash"), body.get("input_data")
            if not isinstance(job_id, str) or not isinstance(data, dict):
                return _error(400, "invalid_request", "job_id and input_data are required")
            job = await agent.store.get(job_id)
            if job is None:
                return _error(404, "job_not_found")
            schema = job["awaiting_input_schema"]
            if job["status"] != "awaiting_input" or schema is None:
                return _error(400, "job_not_awaiting_input")
            if schema_hash != input_schema_hash(schema):
                return _error(400, "input_schema_hash_mismatch")
            problems = validate_input_data(schema, data)
            if problems:
                return _error(400, "invalid_input_data", "; ".join(problems))
            waiter = agent._input_waiters.get(job_id)
            if waiter is None or waiter.done():
                return _error(500, "handler_not_waiting", "the process that ran this job restarted")
            digest = input_hash(job["identifier_from_purchaser"], data)
            waiter.set_result(data)
            signed = await agent._sign_body({"job_id": job_id, "input_hash": digest})
            return JSONResponse({"input_hash": digest, "signature": signed["signature"], "key": signed["key"]})

        @app.get("/availability")
        async def availability() -> Response:
            return JSONResponse({"status": "available", "type": "masumi-agent", "message": agent.notice or "Server operational."})

        @app.get("/input_schema")
        async def get_input_schema() -> Response:
            return JSONResponse(agent.input_schema)

        @app.get("/demo")
        async def demo() -> Response:
            return JSONResponse(agent.demo) if agent.demo is not None else _error(404, "no_demo")

        @app.post("/cascade/quote")
        async def quote(request: Request) -> Response:
            body = await read_json(request)
            if body is None:
                return _error(400, "invalid_json")
            problems = _quote_request_errors(body, agent._quote_validator)
            if problems:
                return _error(400, "invalid_quote_request", "; ".join(problems))
            spec, window = body["spec"], body["window"]
            now = agent.now()
            decline = None
            if spec["rail"] not in agent.rails:
                decline = f"rail {spec['rail']} is not accepted"
            elif spec["category"] not in agent.capabilities.categories:
                decline = f"category {spec['category']} is not offered"
            elif spec["price"]["asset"] != agent.pricing.asset:
                decline = f"asset {spec['price']['asset']} is not accepted"
            elif int(agent.pricing.amount) > int(spec["price"]["max_budget"]):
                decline = "list price exceeds max_budget"
            elif window["submit_by"] - max(now, window["start_by"]) < agent.pricing.eta_ms:
                decline = "deadline window is shorter than the delivery time"
            if decline is not None:
                return _error(409, "declined", decline)
            sub_hire = "orchestrator" in agent.capabilities.roles and bool(spec["may_sub_hire"])
            unsigned = {
                "version": "1",
                "quote_id": str(uuid.uuid4()),
                "agent_id": agent.registry_asset,
                "spec_hash": body["spec_hash"],
                "price": agent.pricing.amount,
                "asset": agent.pricing.asset,
                "eta_ms": agent.pricing.eta_ms,
                "rails": [spec["rail"]],
                "may_sub_hire": sub_hire,
                "max_sub_budget_share_bps": agent.pricing.max_sub_budget_share_bps if sub_hire else 0,
                "operator": agent.signer.key_hash,
                "payee": agent.signer.address,
                "issued_at": now,
                "expires_at": now + agent.pricing.quote_ttl_ms,
            }
            signed = await agent._sign_body(unsigned)
            await agent.store.put_quote(signed)
            return JSONResponse(signed)

        @app.post("/jobs")
        async def jobs(request: Request) -> Response:
            if agent.payments is None:
                return _error(503, "payments_not_configured")
            provider, verifier = agent.payments
            body = await read_json(request)
            if body is None:
                return _error(400, "invalid_json")
            identifier, data = body.get("identifier_from_purchaser"), body.get("input_data")
            spec_hash, quote_id = body.get("spec_hash"), body.get("quote_id")
            if not isinstance(identifier, str) or not 0 < len(identifier) <= 256:
                return _error(400, "invalid_identifier_from_purchaser")
            if not isinstance(data, dict):
                return _error(400, "invalid_input_data")
            if spec_hash is not None and (not isinstance(spec_hash, str) or len(spec_hash) != 64 or any(c not in "0123456789abcdef" for c in spec_hash)):
                return _error(400, "invalid_spec_hash")
            if quote_id is not None and not isinstance(quote_id, str):
                return _error(400, "invalid_quote_id")
            problems = validate_input_data(agent.input_schema, data)
            if problems:
                return _error(400, "invalid_input_data", "; ".join(problems))
            amount, asset = agent.pricing.amount, agent.pricing.asset
            if quote_id is not None:
                q = await agent.store.get_quote(quote_id)
                if q is None:
                    return _error(400, "unknown_quote")
                if q["expires_at"] < agent.now():
                    return _error(400, "quote_expired")
                if spec_hash != q["spec_hash"]:
                    return _error(400, "spec_hash_does_not_match_quote")
                amount, asset = q["price"], q["asset"]
            digest = input_hash(identifier, data)
            ctx = {"resource": f"{agent.base_url}/jobs", "identifier_from_purchaser": identifier, "input_hash": digest, "spec_hash": spec_hash, "quote_id": quote_id, "amount": amount, "asset": asset}

            async def payment_required(error: str) -> Response:
                required = {
                    "x402Version": X402_VERSION,
                    "error": error,
                    "resource": {"url": ctx["resource"], "description": agent.description, "mimeType": "application/json"},
                    "accepts": await provider.offer(ctx),
                }
                return JSONResponse(required, status_code=402, headers={"PAYMENT-REQUIRED": encode_header(required)})

            header = request.headers.get("PAYMENT-SIGNATURE")
            if header is None:
                return await payment_required("PAYMENT-SIGNATURE header is required")
            try:
                payload = parse_payment_payload(decode_header(header))
            except ValueError as e:
                return await payment_required(f"invalid PAYMENT-SIGNATURE: {e}")
            requirements = await provider.match(payload["accepted"], ctx)
            if requirements is None:
                return await payment_required("accepted requirements do not match an offer for this purchase")
            key = payment_key(header)
            job = await agent.store.find_by_payment_key(key)
            if job is not None and (job["input_hash"] != digest or job["identifier_from_purchaser"] != identifier):
                return await payment_required("payment_reused_for_different_job")
            if job is None:
                verified = await verifier.verify(payload, requirements)
                if not verified.is_valid:
                    return await payment_required(verified.invalid_reason or "payment verification failed")
                fresh = agent._new_job(identifier, data, "x402", spec_hash, quote_id, key)
                fresh["node"] = verified.node
                try:
                    await agent.store.create(fresh)
                    job = fresh
                except DuplicateJobError:
                    job = await agent.store.find_by_payment_key(key)
                    if job is None:
                        raise
            headers: dict[str, str] = {}
            if job["status"] == "awaiting_payment":
                settled = await verifier.settle(payload, requirements)
                if not settled.success:
                    if settled.error_reason == "settlement_pending":
                        return await payment_required("settlement_pending")
                    reason = settled.error_reason or "settle failed"
                    await agent.store.update(job["job_id"], lambda j: {**_transition(j, "failed", agent.now(), {"reason": reason}), "error": reason} if j["status"] == "awaiting_payment" else j)
                    return await payment_required(reason)
                headers["PAYMENT-RESPONSE"] = encode_header(settled.to_wire())
                await agent.store.update(job["job_id"], lambda j: {**j, "payment": {**j["payment"], "tx_id": settled.transaction, "network": settled.network}})
                await agent.confirm_payment(job["job_id"], settled.transaction)
            current = await agent.store.get(job["job_id"]) or job
            out = {"job_id": current["job_id"], "input_hash": current["input_hash"]}
            if current["payment"]["tx_id"] is not None:
                out["tx_id"] = current["payment"]["tx_id"]
            return JSONResponse(out, headers=headers)

        @app.get("/cascade/subtree")
        async def subtree(job_id: str | None = None) -> Response:
            if not job_id:
                return _error(400, "missing_job_id")
            job = await agent.store.get(job_id)
            if job is None:
                return _error(404, "job_not_found")
            if job["node"] is None:
                return _error(404, "job_has_no_tree_node", "the job was not paid through a Cascade tree node")
            report = {"agent_id": agent.registry_asset, "tree_id": job["node"]["tree_id"], "node_id": job["node"]["node_id"], "children": job["children"], "reported_at": agent.now()}
            return JSONResponse(await agent._sign_body(report))

        @app.get("/cascade/result")
        async def result(job_id: str | None = None) -> Response:
            if not job_id:
                return _error(400, "missing_job_id")
            job = await agent.store.get(job_id)
            if job is None:
                return _error(404, "job_not_found")
            if job["status"] != "completed" or job["result_hash"] is None:
                return _error(409, "no_result", f"job status is {job['status']}")
            return JSONResponse(agent._result_bundle(job))

        @app.post("/cascade/challenge")
        async def challenge(request: Request) -> Response:
            body = await read_json(request)
            if body is None:
                return _error(400, "invalid_json")
            tree_id, node_id, reason_hash, reason = body.get("tree_id"), body.get("node_id"), body.get("reason_hash"), body.get("reason")
            hex_ok = lambda v, n: isinstance(v, str) and len(v) == n and all(c in "0123456789abcdef" for c in v)  # noqa: E731
            if not hex_ok(tree_id, 56) or not hex_ok(node_id, 56):
                return _error(400, "invalid_node")
            if not hex_ok(reason_hash, 64) or not isinstance(reason, dict):
                return _error(400, "invalid_reason")
            if jcs_sha256_hex(reason) != reason_hash:
                return _error(400, "reason_hash_mismatch", "reason_hash must be SHA-256 of JCS(reason)")
            job = await agent.store.find_by_node(tree_id, node_id)
            if job is None:
                return _error(404, "node_not_found")
            bundle = {"result_hash": job["result_hash"], "output_schema_hash": jcs_sha256_hex(agent.output_schema), "evidence": agent._result_bundle(job)["evidence"]}
            await agent.store.update(job["job_id"], lambda j: {**j, "journal": _journal(j, agent.now(), "challenge.received", {"reason_hash": reason_hash, "concede": False})})
            return JSONResponse(await agent._sign_body({"node_id": node_id, "concede": False, "rebuttal_hash": jcs_sha256_hex(bundle), "bundle": bundle}))

        @app.get("/output_schema")
        async def output_schema() -> Response:
            return JSONResponse(agent.output_schema)

        @app.get("/.well-known/x402.json")
        async def x402_discovery() -> Response:
            resources_list = []
            if agent.payments is not None:
                resources_list.append({"resource": f"{agent.base_url}/jobs", "method": "POST", "description": agent.description, "accepts": agent.payments[0].discovery()})
            return JSONResponse({"x402Version": X402_VERSION, "resources": resources_list})

        @app.get("/.well-known/cascade.json")
        async def cascade_json() -> Response:
            out: dict[str, Any] = {
                "version": "1",
                "name": agent.name,
                "roles": agent.capabilities.roles,
                "categories": agent.capabilities.categories,
                "max_depth": agent.capabilities.max_depth,
                "rails": agent.rails,
                "bond_lovelace": agent.capabilities.bond_lovelace,
                "registry_asset_id": agent.registry_asset,
                "payment_address": agent.signer.address,
                "operator": agent.signer.key_hash,
                "pricing": {"asset": agent.pricing.asset, "amount": agent.pricing.amount, "eta_ms": agent.pricing.eta_ms},
            }
            if agent.notice is not None:
                out["notice"] = agent.notice
            return JSONResponse(out)

        @app.get("/.well-known/agent-card.json")
        async def agent_card() -> Response:
            return JSONResponse(
                {
                    "name": agent.name,
                    "description": agent.description if agent.notice is None else f"{agent.description} {agent.notice}",
                    "url": agent.base_url,
                    "version": agent.version,
                    "protocolVersion": "0.3.0",
                    "preferredTransport": "HTTP+JSON",
                    "capabilities": {"streaming": False, "pushNotifications": False, "stateTransitionHistory": True},
                    "defaultInputModes": ["application/json"],
                    "defaultOutputModes": ["application/json"],
                    "skills": [{"id": c, "name": c, "description": agent.description, "tags": [*agent.capabilities.tags, *agent.capabilities.roles]} for c in agent.capabilities.categories],
                }
            )

        return app


def cascade_agent(**kwargs: Any) -> CascadeAgent:
    """Three-line upgrade (PRD 15.2): ``app = cascade_agent(...).app`` serves MIP-003 + Cascade."""
    return CascadeAgent(**kwargs)
