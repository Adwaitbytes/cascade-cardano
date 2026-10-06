"""Job and quote store. ``update`` is atomic per job (an asyncio lock per store)."""

from __future__ import annotations

import asyncio
import copy
from typing import Any, Callable, Protocol


class JobNotFoundError(KeyError):
    pass


class DuplicateJobError(ValueError):
    pass


class JobStore(Protocol):
    async def create(self, job: dict[str, Any]) -> None: ...

    async def get(self, job_id: str) -> dict[str, Any] | None: ...

    async def update(self, job_id: str, mutate: Callable[[dict[str, Any]], dict[str, Any]]) -> dict[str, Any]: ...

    async def find_by_payment_key(self, key: str) -> dict[str, Any] | None: ...

    async def find_by_node(self, tree_id: str, node_id: str) -> dict[str, Any] | None: ...

    async def list_by_status(self, statuses: tuple[str, ...]) -> list[dict[str, Any]]: ...

    async def put_quote(self, quote: dict[str, Any]) -> None: ...

    async def get_quote(self, quote_id: str) -> dict[str, Any] | None: ...


class InMemoryJobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, dict[str, Any]] = {}
        self._quotes: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    async def create(self, job: dict[str, Any]) -> None:
        async with self._lock:
            key = job["payment"]["payment_key"]
            if job["job_id"] in self._jobs or (key is not None and any(j["payment"]["payment_key"] == key for j in self._jobs.values())):
                raise DuplicateJobError(key or job["job_id"])
            self._jobs[job["job_id"]] = copy.deepcopy(job)

    async def get(self, job_id: str) -> dict[str, Any] | None:
        job = self._jobs.get(job_id)
        return copy.deepcopy(job) if job is not None else None

    async def update(self, job_id: str, mutate: Callable[[dict[str, Any]], dict[str, Any]]) -> dict[str, Any]:
        async with self._lock:
            current = self._jobs.get(job_id)
            if current is None:
                raise JobNotFoundError(job_id)
            nxt = mutate(copy.deepcopy(current))
            self._jobs[job_id] = copy.deepcopy(nxt)
            return copy.deepcopy(nxt)

    async def find_by_payment_key(self, key: str) -> dict[str, Any] | None:
        return next((copy.deepcopy(j) for j in self._jobs.values() if j["payment"]["payment_key"] == key), None)

    async def find_by_node(self, tree_id: str, node_id: str) -> dict[str, Any] | None:
        for j in self._jobs.values():
            node = j.get("node")
            if node is not None and node["tree_id"] == tree_id and node["node_id"] == node_id:
                return copy.deepcopy(j)
        return None

    async def list_by_status(self, statuses: tuple[str, ...]) -> list[dict[str, Any]]:
        return [copy.deepcopy(j) for j in self._jobs.values() if j["status"] in statuses]

    async def put_quote(self, quote: dict[str, Any]) -> None:
        self._quotes[quote["quote_id"]] = copy.deepcopy(quote)

    async def get_quote(self, quote_id: str) -> dict[str, Any] | None:
        q = self._quotes.get(quote_id)
        return copy.deepcopy(q) if q is not None else None
