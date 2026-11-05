"""Claude Code CLI adapter (`claude --print`). Skipped when the binary is absent."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from lancer_eval.diffutil import extract_unified_diff
from lancer_eval.process import child_env, run_process
from lancer_eval.prompt import build_prompt
from lancer_eval.types import AgentResult, Availability, InstanceSpec, TokenUsage


def claude_command(prompt: str, model: str | None) -> list[str]:
    command = [
        "claude",
        "--print",
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
    ]
    if model:
        command.extend(["--model", model])
    command.append(prompt)
    return command


def claude_env(base_url: str | None) -> dict[str, str]:
    updates: dict[str, str | None] = {}
    if base_url:
        updates["ANTHROPIC_BASE_URL"] = base_url
    return child_env(updates)


def parse_claude_output(text: str) -> tuple[str, TokenUsage | None, float | None, int | None]:
    """Parse Claude Code JSON. Missing usage stays null."""

    raw = text.strip()
    if not raw:
        return "", None, None, None
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return text, None, None, None
    if isinstance(payload, dict) and payload.get("type") != "result":
        # Some builds print logs before the result object. Use the last JSON object.
        payload = _last_json_object(raw) or payload
    result_text = ""
    usage = None
    cost = None
    turns = None
    if isinstance(payload, dict):
        result_text = str(payload.get("result") or "")
        raw_usage = payload.get("usage")
        if isinstance(raw_usage, dict):
            usage = TokenUsage(
                input_tokens=_int_or_none(raw_usage.get("input_tokens")),
                output_tokens=_int_or_none(raw_usage.get("output_tokens")),
            )
        cost_value = payload.get("total_cost_usd")
        if isinstance(cost_value, (int, float)):
            cost = float(cost_value)
        turns = _int_or_none(payload.get("num_turns"))
    return result_text or text, usage, cost, turns


class ClaudeCodeAdapter:
    name = "claude-code"

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
        path = self.binary or self._which("claude")
        if not path:
            return Availability(False, "not_installed", "claude is not on PATH")
        return Availability(True, "ok", str(path))

    def run(self, task: InstanceSpec, workspace: Path, timeout: float) -> AgentResult:
        prompt = build_prompt(task, include_hints=self.include_hints)
        command = claude_command(prompt, self.model)
        if self.binary:
            command[0] = self.binary
        elif found := self._which("claude"):
            command[0] = found
        result = run_process(
            command,
            cwd=workspace,
            env=claude_env(self.base_url),
            timeout=timeout,
        )
        text, usage, cost, turns = parse_claude_output(result.stdout)
        log = result.combined
        if text and text not in log:
            log = f"{log}\n{text}"
        patch = extract_unified_diff(text) or None
        # Prefer workspace edits. A transcript diff is only a fallback when the
        # runner finds no git diff; returning None asks the runner to collect one
        # and still keeps the transcript in the log.
        if patch and not _workspace_dirty(workspace):
            explicit = patch
        else:
            explicit = None
        return AgentResult(
            patch=explicit,
            log=log,
            wall_time_seconds=result.seconds,
            usage=usage,
            cost_usd=cost,
            cost_source="adapter" if cost is not None else None,
            turns=turns,
            timed_out=result.timed_out,
            error=None if result.returncode in {0, None} and not result.timed_out else (result.stderr or "claude failed"),
        )


def _workspace_dirty(workspace: Path) -> bool:
    from lancer_eval.process import git_env, run_process as run

    status = run(["git", "status", "--porcelain"], cwd=workspace, env=git_env(), timeout=30)
    return bool(status.stdout.strip())


def _last_json_object(text: str) -> dict | None:
    decoder = json.JSONDecoder()
    found = None
    for index, character in enumerate(text):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            found = value
    return found


def _int_or_none(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None
