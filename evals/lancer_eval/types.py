"""Shared records for a single eval run."""

from __future__ import annotations

from dataclasses import dataclass, field


FAILURE_BUCKETS = (
    "context_retrieval_miss",
    "tool_or_command_error",
    "environment_setup_error",
    "patch_does_not_apply",
    "tests_fail",
    "timeout",
    "empty_patch",
)


@dataclass
class TokenUsage:
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None

    def as_dict(self) -> dict[str, int | None]:
        total = self.total_tokens
        if total is None and self.input_tokens is not None and self.output_tokens is not None:
            total = self.input_tokens + self.output_tokens
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_tokens": total,
        }


@dataclass
class Availability:
    ready: bool
    reason: str
    detail: str = ""


@dataclass
class AgentResult:
    """What one adapter produced for one instance.

    `patch is None` means the runner should collect `git diff` from the
    workspace. An empty string means the agent produced no patch.
    """

    patch: str | None
    log: str
    wall_time_seconds: float
    usage: TokenUsage | None = None
    cost_usd: float | None = None
    cost_source: str | None = None
    tool_calls: int | None = None
    turns: int | None = None
    timed_out: bool = False
    error: str | None = None


@dataclass
class InstanceSpec:
    instance_id: str
    repo: str
    base_commit: str
    problem_statement: str
    repo_url: str | None = None
    version: str | None = None
    fail_to_pass: list[str] = field(default_factory=list)
    pass_to_pass: list[str] = field(default_factory=list)
    gold_files: list[str] = field(default_factory=list)
    test_command: str | None = None
    hints_text: str = ""
    swebench: bool = False

    def clone_url(self) -> str:
        if self.repo_url:
            return self.repo_url
        return f"https://github.com/{self.repo}.git"


@dataclass
class GradeResult:
    grade_mode: str
    official: bool
    resolved: bool | None
    patch_applies: bool
    tests_executed: bool
    infra_error: bool
    detail: str
    fail_to_pass: dict | None = None
    pass_to_pass: dict | None = None
