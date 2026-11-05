"""Deterministic adapter for tests and CI. It does not call a model."""

from __future__ import annotations

import time
from pathlib import Path

from lancer_eval.types import AgentResult, Availability, InstanceSpec, TokenUsage


class MockAdapter:
    name = "mock"

    def __init__(self, spec: dict | None = None) -> None:
        self.spec = spec or {}

    def available(self) -> Availability:
        return Availability(True, "ok", "deterministic mock, no API key")

    def _case(self, task: InstanceSpec) -> dict:
        instances = self.spec.get("instances") or {}
        case = instances.get(task.instance_id)
        if isinstance(case, dict):
            return case
        return {"mode": self.spec.get("default", "empty")}

    def run(self, task: InstanceSpec, workspace: Path, timeout: float) -> AgentResult:
        case = self._case(task)
        mode = case.get("mode", "empty")
        usage = None
        if "input_tokens" in case or "output_tokens" in case:
            usage = TokenUsage(
                input_tokens=case.get("input_tokens"),
                output_tokens=case.get("output_tokens"),
            )
        cost = case.get("cost_usd")
        log = f"mock adapter mode={mode} instance={task.instance_id}\n{case.get('extra_log') or ''}"
        if mode == "empty":
            return AgentResult(
                patch="",
                log=log + "mock adapter produced no code changes\n",
                wall_time_seconds=0.0,
                usage=usage,
                cost_usd=cost,
                cost_source="adapter" if cost is not None else None,
                tool_calls=case.get("tool_calls"),
                turns=case.get("turns"),
                error=case.get("error"),
            )
        if mode == "edit":
            _edit(workspace, case["relpath"], case["old"], case["new"])
            return AgentResult(
                patch=None,
                log=log,
                wall_time_seconds=float(case.get("wall_time_seconds", 0.01)),
                usage=usage,
                cost_usd=cost,
                cost_source="adapter" if cost is not None else None,
                tool_calls=case.get("tool_calls", 1),
                turns=case.get("turns", 1),
            )
        if mode == "patch":
            return AgentResult(
                patch=case.get("patch") or "",
                log=log,
                wall_time_seconds=float(case.get("wall_time_seconds", 0.01)),
                usage=usage,
                cost_usd=cost,
                cost_source="adapter" if cost is not None else None,
                tool_calls=case.get("tool_calls"),
                turns=case.get("turns"),
            )
        if mode == "timeout":
            budget = min(float(case.get("sleep", 0)), timeout)
            if budget > 0:
                time.sleep(budget)
            return AgentResult(
                patch=case.get("patch") or "",
                log=log + "timed out\n",
                wall_time_seconds=timeout,
                timed_out=True,
                error="agent timed out",
                usage=usage,
                cost_usd=cost,
                cost_source="adapter" if cost is not None else None,
            )
        if mode == "command_error":
            _edit(workspace, case["relpath"], case["old"], case["new"])
            log += 'toolFinished {"success": false, "exitCode": 1}\ncommand failed: pytest\n'
            return AgentResult(
                patch=None,
                log=log,
                wall_time_seconds=float(case.get("wall_time_seconds", 0.02)),
                tool_calls=case.get("tool_calls", 2),
                turns=case.get("turns", 1),
                error="command failed",
            )
        raise ValueError(f"unknown mock mode: {mode}")


def _edit(workspace: Path, relpath: str, old: str, new: str) -> None:
    path = (workspace / relpath).resolve()
    root = workspace.resolve()
    if not path.is_relative_to(root):
        raise ValueError(f"mock edit escapes the workspace: {relpath}")
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise ValueError(f"mock edit could not find text in {relpath}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
