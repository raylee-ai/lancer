"""Official SWE-bench grading, with an explicit lightweight fallback."""

from __future__ import annotations

import importlib.util
import json
import shutil
import sys
from pathlib import Path

from lancer_eval.process import git_env, run_process
from lancer_eval.types import GradeResult, InstanceSpec
from lancer_eval.workspace import patch_applies


def docker_available() -> bool:
    if shutil.which("docker") is None:
        return False
    result = run_process(["docker", "info"], timeout=20)
    return result.returncode == 0 and not result.timed_out


def swebench_package_available() -> bool:
    return importlib.util.find_spec("swebench") is not None


def select_grade_mode(
    requested: str,
    *,
    docker: bool,
    swebench: bool,
    tasks_are_swebench: bool,
) -> tuple[str, str | None]:
    """Choose official Docker grading or the documented fallback.

    The fallback never reports a resolution. `resolved` stays null.
    """

    if requested == "lightweight":
        return "lightweight", None
    if not tasks_are_swebench:
        return (
            "lightweight",
            "this task set is not SWE-bench; the official harness was not used",
        )
    if docker and swebench:
        return "official", None
    missing = []
    if not docker:
        missing.append("Docker is not available")
    if not swebench:
        missing.append("the swebench package is not installed")
    return "lightweight", "; ".join(missing)


def grade_lightweight(repo: Path, task: InstanceSpec, patch: str) -> GradeResult:
    applies, detail = patch_applies(repo, task.base_commit, patch)
    note = (
        "Lightweight fallback: git apply --check on a clean checkout. "
        "FAIL_TO_PASS and PASS_TO_PASS were not executed, so resolved is null."
    )
    if detail:
        note = f"{note} {detail}"
    return GradeResult(
        grade_mode="lightweight",
        official=False,
        resolved=None,
        patch_applies=applies,
        tests_executed=False,
        infra_error=False,
        detail=note,
    )


def grade_local_command(
    repo: Path,
    task: InstanceSpec,
    patch: str,
    *,
    timeout: float,
) -> GradeResult:
    """Run a task-set command on the host after the patch applies.

    This is for a private business task set. It is not SWE-bench grading.
    """

    applies, detail = patch_applies(repo, task.base_commit, patch)
    if not applies:
        return GradeResult(
            grade_mode="local_commands",
            official=False,
            resolved=False,
            patch_applies=False,
            tests_executed=False,
            infra_error=False,
            detail=detail or "patch did not apply",
        )
    if not task.test_command:
        return GradeResult(
            grade_mode="local_commands",
            official=False,
            resolved=None,
            patch_applies=True,
            tests_executed=False,
            infra_error=False,
            detail="no test_command on this task",
        )
    scratch_parent = repo.parent / f".local-grade-{repo.name}"
    if scratch_parent.exists():
        shutil.rmtree(scratch_parent, ignore_errors=True)
    try:
        cloned = run_process(
            ["git", "clone", "--no-checkout", str(repo), str(scratch_parent)],
            env=git_env(),
            timeout=timeout,
        )
        if cloned.returncode != 0 or cloned.timed_out:
            return _local_setup_failure(cloned.combined or "git clone failed")
        checked = run_process(
            ["git", "checkout", "--force", task.base_commit],
            cwd=scratch_parent,
            env=git_env(),
            timeout=timeout,
        )
        if checked.returncode != 0 or checked.timed_out:
            return _local_setup_failure(checked.combined or "git checkout failed")
        applied = run_process(
            ["git", "apply", "--whitespace=nowarn", "-"],
            cwd=scratch_parent,
            env=git_env(),
            timeout=timeout,
            stdin=patch,
        )
        if applied.returncode != 0 or applied.timed_out:
            return GradeResult(
                grade_mode="local_commands",
                official=False,
                resolved=False,
                patch_applies=False,
                tests_executed=False,
                infra_error=False,
                detail=(applied.stderr or "git apply failed").strip(),
            )
        command = run_process(
            ["sh", "-c", task.test_command],
            cwd=scratch_parent,
            timeout=timeout,
        )
        if command.timed_out:
            return GradeResult(
                grade_mode="local_commands",
                official=False,
                resolved=None,
                patch_applies=True,
                tests_executed=False,
                infra_error=True,
                detail="local test command timed out",
            )
        passed = command.returncode == 0
        output = (command.stdout + "\n" + command.stderr).strip()
        return GradeResult(
            grade_mode="local_commands",
            official=False,
            resolved=passed,
            patch_applies=True,
            tests_executed=True,
            infra_error=False,
            detail=output[-4000:],
        )
    finally:
        shutil.rmtree(scratch_parent, ignore_errors=True)


def _local_setup_failure(detail: str) -> GradeResult:
    return GradeResult(
        grade_mode="local_commands",
        official=False,
        resolved=None,
        patch_applies=True,
        tests_executed=False,
        infra_error=True,
        detail=detail.strip()[-4000:],
    )


def write_predictions(path: Path, model_name: str, records: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(
                json.dumps(
                    {
                        "instance_id": record["instance_id"],
                        "model_name_or_path": model_name,
                        "model_patch": record.get("patch") or "",
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )


def swebench_command(
    *,
    predictions: Path,
    dataset_name: str,
    split: str,
    instance_ids: list[str],
    run_id: str,
    timeout: int,
    workers: int,
) -> list[str]:
    return [
        sys.executable,
        "-m",
        "swebench.harness.run_evaluation",
        "--dataset_name",
        dataset_name,
        "--split",
        split,
        "--predictions_path",
        str(predictions),
        "--instance_ids",
        *instance_ids,
        "--max_workers",
        str(workers),
        "--run_id",
        run_id,
        "--timeout",
        str(timeout),
    ]


def run_swebench(
    *,
    predictions: Path,
    dataset_name: str,
    split: str,
    instance_ids: list[str],
    run_id: str,
    timeout: int,
    workers: int,
    cwd: Path,
) -> tuple[int | None, str]:
    command = swebench_command(
        predictions=predictions,
        dataset_name=dataset_name,
        split=split,
        instance_ids=instance_ids,
        run_id=run_id,
        timeout=timeout,
        workers=workers,
    )
    result = run_process(command, cwd=cwd, timeout=max(timeout * max(len(instance_ids), 1) + 600, 600))
    log = result.combined
    (cwd / "swebench.log").write_text(log, encoding="utf-8")
    return result.returncode, log


def parse_swebench_reports(root: Path) -> dict[str, dict]:
    """Read report.json files written by the official harness.

    Accepts either a map of instance id to result, or a single-instance object
    that contains `resolved`. Unrecognized files are ignored.
    """

    found: dict[str, dict] = {}
    if not root.exists():
        return found
    for path in root.rglob("report.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and "resolved" in payload and "instance_id" in payload:
            found[str(payload["instance_id"])] = payload
            continue
        if isinstance(payload, dict) and "resolved" in payload:
            instance_id = path.parent.name
            found[instance_id] = payload
            continue
        if isinstance(payload, dict):
            for key, value in payload.items():
                if isinstance(value, dict) and ("resolved" in value or "tests_status" in value):
                    found[str(key)] = value
    return found


def grade_from_report(instance_id: str, report: dict | None, *, log: str) -> GradeResult:
    if report is None:
        return GradeResult(
            grade_mode="official",
            official=True,
            resolved=None,
            patch_applies=None,
            tests_executed=False,
            infra_error=True,
            detail=f"no SWE-bench report for {instance_id}. {log[-1000:]}",
        )
    tests = report.get("tests_status") or {}
    fail_to_pass = tests.get("FAIL_TO_PASS") if isinstance(tests, dict) else None
    pass_to_pass = tests.get("PASS_TO_PASS") if isinstance(tests, dict) else None
    resolved = report.get("resolved")
    if not isinstance(resolved, bool):
        resolved = None
    applied = report.get("patch_successfully_applied")
    if not isinstance(applied, bool):
        applied = None
    return GradeResult(
        grade_mode="official",
        official=True,
        resolved=resolved,
        patch_applies=applied,
        tests_executed=resolved is not None,
        infra_error=resolved is None,
        detail="official swebench report",
        fail_to_pass=fail_to_pass if isinstance(fail_to_pass, dict) else None,
        pass_to_pass=pass_to_pass if isinstance(pass_to_pass, dict) else None,
    )

