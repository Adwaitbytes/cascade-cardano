"""MIP-003 job status machine; the enum strings are exactly the MIP-003 values."""

from __future__ import annotations

from typing import Literal

JobStatus = Literal["awaiting_payment", "awaiting_input", "running", "completed", "failed"]
JOB_STATUSES: tuple[JobStatus, ...] = ("awaiting_payment", "awaiting_input", "running", "completed", "failed")

TRANSITIONS: dict[str, tuple[str, ...]] = {
    "awaiting_payment": ("running", "failed"),
    "running": ("awaiting_input", "completed", "failed"),
    "awaiting_input": ("running", "failed"),
    "completed": (),
    "failed": (),
}


class InvalidTransitionError(Exception):
    def __init__(self, source: str, target: str) -> None:
        super().__init__(f"job status cannot move from {source} to {target}")
        self.source = source
        self.target = target


def is_terminal(status: str) -> bool:
    return TRANSITIONS[status] == ()


def assert_transition(source: str, target: str) -> None:
    if target not in TRANSITIONS[source]:
        raise InvalidTransitionError(source, target)
