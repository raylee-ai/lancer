"""Subprocess helper that records timeout without raising it."""

from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ProcessResult:
    args: list[str]
    returncode: int | None
    stdout: str
    stderr: str
    seconds: float
    timed_out: bool

    @property
    def combined(self) -> str:
        parts = [part for part in (self.stdout, self.stderr) if part]
        return "\n".join(parts)


def _as_text(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def run_process(
    args: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
    stdin: str | None = None,
) -> ProcessResult:
    started = time.monotonic()
    try:
        completed = subprocess.run(
            args,
            cwd=None if cwd is None else str(cwd),
            env=env,
            input=stdin,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        return ProcessResult(
            args=list(args),
            returncode=completed.returncode,
            stdout=completed.stdout or "",
            stderr=completed.stderr or "",
            seconds=time.monotonic() - started,
            timed_out=False,
        )
    except subprocess.TimeoutExpired as exc:
        return ProcessResult(
            args=list(args),
            returncode=None,
            stdout=_as_text(exc.stdout),
            stderr=_as_text(exc.stderr),
            seconds=time.monotonic() - started,
            timed_out=True,
        )


def git_env(base: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if base is None else base)
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_PAGER"] = "cat"
    return env


def child_env(updates: dict[str, str | None] | None = None) -> dict[str, str]:
    env = dict(os.environ)
    for key, value in (updates or {}).items():
        if value:
            env[key] = value
        elif key in env and value == "":
            del env[key]
    return env
