"""Adapter contract. Implementations talk to a real agent entry point."""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

from lancer_eval.types import AgentResult, Availability, InstanceSpec


class AgentAdapter(Protocol):
    name: str

    def available(self) -> Availability:
        """Return whether this adapter can run on this machine."""

    def run(self, task: InstanceSpec, workspace: Path, timeout: float) -> AgentResult:
        """Run one instance. Do not raise for an ordinary agent failure."""
