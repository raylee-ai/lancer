"""Agent prompt. Gold patches and hidden tests are not included."""

from __future__ import annotations

from lancer_eval.types import InstanceSpec


def build_prompt(task: InstanceSpec, *, include_hints: bool) -> str:
    hints = ""
    if include_hints and task.hints_text.strip():
        hints = f"\nHints (may be incomplete):\n{task.hints_text.strip()}\n"
    statement = task.problem_statement.strip()
    return (
        "You are fixing a repository in the current working directory.\n"
        f"Repository: {task.repo}\n"
        f"Instance: {task.instance_id}\n"
        "\n"
        "Issue:\n"
        f"{statement}\n"
        f"{hints}\n"
        "Edit the code so the issue is fixed. Leave the change as uncommitted "
        "edits in the working tree. Do not commit. Do not only describe the "
        "fix. Do not modify tests unless the issue cannot be fixed otherwise.\n"
    )
