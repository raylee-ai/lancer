"""Lancer adapter. Uses scripts/lancer-ctl, the desktop local control API.

The running Lancer app owns the Pi session. This adapter does not read
session JSONL files and does not start a second Pi process.
"""

from __future__ import annotations

import json
from pathlib import Path

from lancer_eval.process import run_process
from lancer_eval.prompt import build_prompt
from lancer_eval.types import AgentResult, Availability, InstanceSpec


def default_lancer_ctl() -> Path:
    return Path(__file__).resolve().parents[3] / "scripts" / "lancer-ctl"


def parse_new_result(text: str) -> str:
    payload = json.loads(text)
    session = payload.get("session") or {}
    session_id = session.get("sessionId") or payload.get("sessionId")
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("lancer-ctl new did not return a sessionId")
    return session_id


def parse_tail(text: str) -> tuple[str, int | None]:
    payload = json.loads(text)
    last = payload.get("lastAssistant")
    assistant = last if isinstance(last, str) else ""
    messages = payload.get("messages")
    turns = None
    if isinstance(messages, list):
        turns = sum(
            1
            for item in messages
            if isinstance(item, dict) and item.get("role") == "assistant"
        )
    return assistant, turns


def parse_logs(text: str) -> tuple[int | None, bool]:
    """Count toolStarted events. A toolFinished failure is reported separately."""

    payload = json.loads(text)
    events = payload.get("events")
    if not isinstance(events, list):
        return None, False
    tool_calls = sum(1 for event in events if isinstance(event, dict) and event.get("kind") == "toolStarted")
    failed = any(
        isinstance(event, dict)
        and event.get("kind") == "toolFinished"
        and event.get("success") is False
        for event in events
    )
    return tool_calls, failed


class LancerAdapter:
    name = "lancer"

    def __init__(
        self,
        *,
        ctl: Path | None = None,
        model: str | None = None,
        include_hints: bool = False,
        user_data_dir: str | None = None,
    ) -> None:
        self.ctl = ctl or default_lancer_ctl()
        self.model = model
        self.include_hints = include_hints
        self.user_data_dir = user_data_dir

    def _command(self, args: list[str]) -> list[str]:
        command = [str(self.ctl), *args]
        if self.user_data_dir:
            command.extend(["--user-data-dir", self.user_data_dir])
        return command

    def available(self) -> Availability:
        if not self.ctl.is_file():
            return Availability(False, "not_installed", f"lancer-ctl not found at {self.ctl}")
        probe = run_process(self._command(["sessions", "--json"]), timeout=15)
        if probe.returncode == 0 and not probe.timed_out:
            return Availability(True, "ok", str(self.ctl))
        detail = (probe.stderr or probe.stdout or "lancer-ctl sessions failed").strip()
        return Availability(False, "not_running", detail)

    def run(self, task: InstanceSpec, workspace: Path, timeout: float) -> AgentResult:
        prompt = build_prompt(task, include_hints=self.include_hints)
        prompt_path = workspace.parent / f"{task.instance_id}.prompt.txt"
        prompt_path.write_text(prompt, encoding="utf-8")
        try:
            return self._run_submitted(task, workspace, timeout, prompt_path)
        finally:
            prompt_path.unlink(missing_ok=True)

    def _run_submitted(
        self, task: InstanceSpec, workspace: Path, timeout: float, prompt_path: Path
    ) -> AgentResult:
        new_args = [
            "new",
            "--cwd",
            str(workspace),
            "--name",
            f"eval {task.instance_id}",
            "--file",
            str(prompt_path),
        ]
        if self.model:
            new_args.extend(["--model", self.model])
        created = run_process(self._command(new_args), timeout=60)
        log = created.combined
        if created.timed_out or created.returncode != 0:
            return AgentResult(
                patch=None,
                log=log,
                wall_time_seconds=created.seconds,
                timed_out=created.timed_out,
                error=log.strip() or "lancer-ctl new failed",
            )
        try:
            session_id = parse_new_result(created.stdout)
        except (json.JSONDecodeError, ValueError) as exc:
            return AgentResult(
                patch=None,
                log=log,
                wall_time_seconds=created.seconds,
                error=str(exc),
            )
        waited = run_process(
            self._command(["wait", session_id, "--timeout", str(max(int(timeout), 1))]),
            timeout=timeout + 30,
        )
        log = f"{log}\n{waited.combined}"
        timed_out = waited.timed_out or waited.returncode == 2
        if timed_out:
            run_process(self._command(["stop", session_id]), timeout=20)
        tail = run_process(self._command(["tail", session_id, "-n", "1000", "--json"]), timeout=60)
        logs = run_process(self._command(["logs", session_id, "--since", "0", "--json"]), timeout=60)
        log = f"{log}\n{tail.combined}\n{logs.combined}"
        assistant = ""
        turns = None
        tool_calls = None
        tool_failed = False
        if tail.returncode == 0:
            try:
                assistant, turns = parse_tail(tail.stdout)
            except json.JSONDecodeError:
                assistant = tail.stdout
        if logs.returncode == 0:
            try:
                tool_calls, tool_failed = parse_logs(logs.stdout)
            except json.JSONDecodeError:
                tool_calls = None
        if assistant:
            log = f"{log}\n{assistant}"
        if tool_failed:
            log += '\n{"success": false, "kind": "toolFinished"}\n'
        error = None
        if timed_out:
            error = "lancer-ctl wait timed out"
        elif waited.returncode not in {0, None}:
            error = (waited.stderr or "lancer-ctl wait failed").strip()
        return AgentResult(
            patch=None,
            log=log,
            wall_time_seconds=waited.seconds,
            tool_calls=tool_calls,
            turns=turns,
            timed_out=timed_out,
            error=error,
        )
