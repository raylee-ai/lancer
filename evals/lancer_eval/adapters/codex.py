"""OpenAI Codex CLI adapter (`codex exec`). Skipped when the binary is absent."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from lancer_eval.process import child_env, run_process
from lancer_eval.prompt import build_prompt
from lancer_eval.types import AgentResult, Availability, InstanceSpec, TokenUsage

_TOOL_ITEM_TYPES = {"command_execution", "mcp_tool_call", "file_change", "web_search"}


def codex_command(model: str | None, base_url: str | None) -> list[str]:
    command = [
        "codex",
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
    ]
    if model:
        command.extend(["-m", model])
    if base_url:
        command.extend(["-c", f"openai_base_url={base_url}"])
    command.append("-")
    return command


def codex_env(base_url: str | None) -> dict[str, str]:
    updates: dict[str, str | None] = {}
    if base_url:
        updates["OPENAI_BASE_URL"] = base_url
    return child_env(updates)


def parse_codex_jsonl(text: str) -> tuple[str, TokenUsage | None, int | None, int | None, str]:
    """Parse Codex JSONL events. Unknown events are ignored."""

    messages: list[str] = []
    usage = None
    tool_calls = 0
    turns = 0
    saw_tool = False
    saw_turn = False
    errors: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if kind == "turn.completed":
            saw_turn = True
            turns += 1
            raw_usage = event.get("usage")
            if isinstance(raw_usage, dict):
                usage = TokenUsage(
                    input_tokens=_int_or_none(raw_usage.get("input_tokens")),
                    output_tokens=_int_or_none(raw_usage.get("output_tokens")),
                )
        elif kind == "turn.failed":
            errors.append(str(event.get("error") or event.get("message") or "turn.failed"))
        elif kind in {"item.completed", "item.started"}:
            item = event.get("item")
            if not isinstance(item, dict):
                continue
            item_type = item.get("type")
            if item_type in _TOOL_ITEM_TYPES and kind == "item.completed":
                saw_tool = True
                tool_calls += 1
            if item_type == "agent_message" and kind == "item.completed":
                text_value = item.get("text") or item.get("message")
                if isinstance(text_value, str):
                    messages.append(text_value)
    transcript = "\n".join(messages)
    if errors:
        transcript = (transcript + "\n" + "\n".join(errors)).strip()
    return transcript, usage, tool_calls if saw_tool else None, turns if saw_turn else None, transcript


class CodexAdapter:
    name = "codex"

    def __init__(
        self,
        *,
        model: str | None = None,
        base_url: str | None = None,
        include_hints: bool = False,
        binary: str | None = None,
        which=shutil.which,
    ) -> None:
        self.model = model
        self.base_url = base_url
        self.include_hints = include_hints
        self.binary = binary
        self._which = which

    def available(self) -> Availability:
        path = self.binary or self._which("codex")
        if not path:
            return Availability(False, "not_installed", "codex is not on PATH")
        return Availability(True, "ok", str(path))

    def run(self, task: InstanceSpec, workspace: Path, timeout: float) -> AgentResult:
        prompt = build_prompt(task, include_hints=self.include_hints)
        command = codex_command(self.model, self.base_url)
        if self.binary:
            command[0] = self.binary
        elif found := self._which("codex"):
            command[0] = found
        result = run_process(
            command,
            cwd=workspace,
            env=codex_env(self.base_url),
            timeout=timeout,
            stdin=prompt,
        )
        transcript, usage, tool_calls, turns, _ = parse_codex_jsonl(result.stdout)
        log = result.combined
        if transcript and transcript not in log:
            log = f"{log}\n{transcript}"
        return AgentResult(
            patch=None,
            log=log,
            wall_time_seconds=result.seconds,
            usage=usage,
            cost_usd=None,
            tool_calls=tool_calls,
            turns=turns,
            timed_out=result.timed_out,
            error=None if result.returncode in {0, None} and not result.timed_out else (result.stderr or "codex failed"),
        )


def _int_or_none(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)
