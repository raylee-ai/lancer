"""Run adapters, grade patches, attribute failures, and write the report."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from lancer_eval.adapters.claude_code import ClaudeCodeAdapter
from lancer_eval.adapters.codex import CodexAdapter
from lancer_eval.adapters.lancer import LancerAdapter
from lancer_eval.adapters.mock import MockAdapter
from lancer_eval.diffutil import extract_unified_diff, files_in_diff, redact, secret_values, sha256_text
from lancer_eval.failures import apply_judge, attribute_failure, judge_failure, tool_error_in_log
from lancer_eval.grading import (
    grade_lightweight,
    grade_local_command,
    parse_swebench_reports,
    run_swebench,
    select_grade_mode,
    write_predictions,
)
from lancer_eval.grading import grade_from_report
from lancer_eval.metrics import summarize_adapter
from lancer_eval.process import git_env
from lancer_eval.prompt import build_prompt
from lancer_eval.report import write_reports
from lancer_eval.types import GradeResult, InstanceSpec
from lancer_eval.workspace import WorkspaceError, collect_patch, prepare_workspace

ADAPTER_NAMES = ("mock", "lancer", "claude-code", "codex")


@dataclass
class RunConfig:
    adapters: list[str]
    output_dir: Path
    timeout_seconds: float = 900
    grade: str = "auto"
    run_local_tests: bool = False
    model: str | None = None
    base_url: str | None = None
    include_hints: bool = False
    judge: bool = False
    judge_override: bool = False
    judge_model: str | None = None
    judge_base_url: str | None = None
    judge_api_key: str | None = None
    input_usd_per_million: float | None = None
    output_usd_per_million: float | None = None
    dataset_name: str | None = None
    split: str = "test"
    run_id: str = "run"
    grade_timeout: int = 1800
    workers: int = 1
    clone_timeout: float = 900
    mock_spec: dict | None = None
    lancer_ctl: Path | None = None
    quiet: bool = False


def build_adapters(config: RunConfig) -> dict[str, object]:
    return {
        "mock": MockAdapter(config.mock_spec),
        "lancer": LancerAdapter(
            ctl=config.lancer_ctl,
            model=config.model,
            include_hints=config.include_hints,
        ),
        "claude-code": ClaudeCodeAdapter(
            model=config.model,
            base_url=config.base_url,
            include_hints=config.include_hints,
        ),
        "codex": CodexAdapter(
            model=config.model,
            base_url=config.base_url,
            include_hints=config.include_hints,
        ),
    }


def execute(
    config: RunConfig,
    tasks: list[InstanceSpec],
    *,
    adapters: dict[str, object] | None = None,
    docker: bool | None = None,
    swebench: bool | None = None,
    judge_complete=None,
) -> dict:
    if not tasks:
        raise ValueError("no tasks")
    adapter_map = adapters or build_adapters(config)
    unknown = [name for name in config.adapters if name not in adapter_map]
    if unknown:
        raise ValueError("unknown adapters: " + ", ".join(unknown))
    config.output_dir.mkdir(parents=True, exist_ok=True)
    secrets = secret_values(dict(os.environ))
    if config.judge_api_key:
        secrets.append(config.judge_api_key)

    skipped = []
    selected = []
    for name in config.adapters:
        adapter = adapter_map[name]
        availability = adapter.available()
        if availability.ready:
            selected.append(adapter)
        else:
            skipped.append(
                {
                    "adapter": name,
                    "reason": availability.reason,
                    "detail": redact(availability.detail, secrets),
                }
            )
            _log(config, f"skip {name}: {availability.reason}")

    tasks_are_swebench = all(task.swebench for task in tasks) and bool(config.dataset_name)
    if docker is None:
        from lancer_eval.grading import docker_available

        docker = docker_available()
    if swebench is None:
        from lancer_eval.grading import swebench_package_available

        swebench = swebench_package_available()
    grade_mode, fallback = select_grade_mode(
        config.grade,
        docker=docker,
        swebench=swebench,
        tasks_are_swebench=tasks_are_swebench,
    )
    if grade_mode != "official" and config.run_local_tests and any(task.test_command for task in tasks):
        grade_mode = "local_commands"
        fallback = None

    records: list[dict] = []
    for adapter in selected:
        adapter_records = []
        for task in tasks:
            record = _run_one(config, adapter, task, grade_mode, secrets)
            adapter_records.append(record)
            _log(
                config,
                f"{adapter.name} {task.instance_id}: grade={record['grade_mode']} "
                f"applies={record['patch_applies']} resolved={record['resolved']}",
            )
        if grade_mode == "official":
            _apply_official(config, adapter.name, adapter_records)
        for record in adapter_records:
            _attribute(config, record, secrets, judge_complete)
            instance_dir = config.output_dir / adapter.name / record["instance_id"]
            _write_instance(instance_dir, record, secrets)
        records.extend(adapter_records)

    summary = _summary(config, records, skipped, grade_mode, fallback)
    (config.output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    write_reports(config.output_dir, summary)
    return summary


def _run_one(config: RunConfig, adapter, task: InstanceSpec, grade_mode: str, secrets: list[str]) -> dict:
    instance_dir = config.output_dir / adapter.name / task.instance_id
    instance_dir.mkdir(parents=True, exist_ok=True)
    workspace = instance_dir / "repo"
    prompt = build_prompt(task, include_hints=config.include_hints)
    (instance_dir / "prompt.txt").write_text(prompt, encoding="utf-8")
    base = {
        "adapter": adapter.name,
        "instance_id": task.instance_id,
        "repo": task.repo,
        "gold_files": list(task.gold_files),
        "patch": "",
        "patch_applies": False,
        "resolved": None,
        "grade_mode": grade_mode if grade_mode != "official" else "lightweight",
        "official": False,
        "tests_executed": False,
        "infra_error": False,
        "setup_failed": False,
        "timed_out": False,
        "wall_time_seconds": None,
        "input_tokens": None,
        "output_tokens": None,
        "cost_usd": None,
        "cost_source": None,
        "tool_calls": None,
        "turns": None,
        "error": None,
        "log": "",
        "touched_files": [],
    }
    try:
        prepare_workspace(task, workspace, timeout=config.clone_timeout)
    except (WorkspaceError, OSError) as exc:
        base["setup_failed"] = True
        base["grade_mode"] = "setup"
        base["error"] = str(exc)
        base["log"] = str(exc)
        _write_instance(instance_dir, base, secrets)
        return base
    try:
        result = adapter.run(task, workspace, config.timeout_seconds)
    except Exception as exc:  # adapter bugs should not abort the rest of the run
        from lancer_eval.types import AgentResult

        result = AgentResult(patch=None, log=str(exc), wall_time_seconds=0.0, error=str(exc))
    patch = result.patch
    if patch is None:
        try:
            patch = collect_patch(workspace, task.base_commit)
        except WorkspaceError as exc:
            patch = ""
            result.log += f"\ncollect_patch failed: {exc}\n"
            result.error = result.error or str(exc)
    if not (patch or "").strip():
        patch = extract_unified_diff(result.log)
    patch = patch or ""
    if patch and not patch.endswith("\n"):
        patch += "\n"
    cost, cost_source = _cost(result, config)
    usage = result.usage.as_dict() if result.usage else {}
    base.update(
        {
            "patch": patch,
            "timed_out": result.timed_out,
            "wall_time_seconds": result.wall_time_seconds,
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "cost_usd": cost,
            "cost_source": cost_source,
            "tool_calls": result.tool_calls,
            "turns": result.turns,
            "error": result.error,
            "log": result.log,
            "touched_files": files_in_diff(patch),
        }
    )
    if grade_mode == "local_commands" and task.test_command:
        grade = grade_local_command(workspace, task, patch, timeout=config.grade_timeout)
    else:
        grade = grade_lightweight(workspace, task, patch)
    _apply_grade(base, grade)
    _write_instance(instance_dir, base, secrets)
    return base


def _apply_official(config: RunConfig, adapter_name: str, records: list[dict]) -> None:
    ready = [record for record in records if not record["setup_failed"]]
    if not ready:
        return
    predictions = config.output_dir / adapter_name / "predictions.jsonl"
    write_predictions(predictions, adapter_name, ready)
    run_id = f"{config.run_id}-{adapter_name}".replace("/", "-")
    try:
        returncode, log = run_swebench(
            predictions=predictions,
            dataset_name=config.dataset_name or "princeton-nlp/SWE-bench_Lite",
            split=config.split,
            instance_ids=[record["instance_id"] for record in ready],
            run_id=run_id,
            timeout=config.grade_timeout,
            workers=config.workers,
            cwd=config.output_dir / adapter_name,
        )
    except OSError as exc:
        returncode, log = None, str(exc)
    reports = parse_swebench_reports(config.output_dir / adapter_name)
    for record in ready:
        grade = grade_from_report(record["instance_id"], reports.get(record["instance_id"]), log=log or "")
        if returncode not in {0, None} and grade.infra_error:
            grade.detail = f"swebench exited {returncode}. {grade.detail}"
        if grade.infra_error:
            grade.patch_applies = record["patch_applies"]
        _apply_grade(record, grade)


def _apply_grade(record: dict, grade: GradeResult) -> None:
    record["grade_mode"] = grade.grade_mode
    record["official"] = grade.official
    record["resolved"] = grade.resolved
    record["patch_applies"] = grade.patch_applies
    record["tests_executed"] = grade.tests_executed
    record["infra_error"] = grade.infra_error
    record["grade_detail"] = grade.detail
    if grade.fail_to_pass is not None:
        record["fail_to_pass"] = grade.fail_to_pass
    if grade.pass_to_pass is not None:
        record["pass_to_pass"] = grade.pass_to_pass


def _attribute(config: RunConfig, record: dict, secrets: list[str], judge_complete) -> None:
    log = record.get("log") or ""
    if record.get("grade_detail"):
        log = f"{log}\n{record['grade_detail']}"
    failure = attribute_failure(
        timed_out=bool(record.get("timed_out")),
        setup_failed=bool(record.get("setup_failed")),
        patch=record.get("patch") or "",
        patch_applies=bool(record.get("patch_applies")),
        official=bool(record.get("official")),
        resolved=record.get("resolved"),
        tests_executed=bool(record.get("tests_executed")),
        infra_error=bool(record.get("infra_error")),
        tool_error=tool_error_in_log(record.get("log") or ""),
        gold_files=list(record.get("gold_files") or []),
        touched_files=list(record.get("touched_files") or []),
    )
    judged = None
    if config.judge and failure.get("bucket") and judge_complete is not None:
        judged = judge_failure(
            heuristic=failure,
            instance_id=record["instance_id"],
            log_excerpt=redact(record.get("log") or "", secrets),
            touched_files=list(record.get("touched_files") or []),
            gold_files=list(record.get("gold_files") or []),
            complete=judge_complete,
        )
        failure = apply_judge(failure, judged, override=config.judge_override)
    elif config.judge and failure.get("bucket") and judge_complete is None:
        judged = {"source": "llm_judge", "bucket": None, "reason": None, "error": "judge client was not configured", "raw": None}
        failure = apply_judge(failure, judged, override=False)
    record["failure_bucket"] = failure.get("bucket")
    record["failure_source"] = failure.get("source")
    record["failure_reasons"] = failure.get("reasons") or []
    record["llm_judge"] = failure.get("llm_judge")


def _summary(config: RunConfig, records: list[dict], skipped: list[dict], grade_mode: str, fallback: str | None) -> dict:
    public = [_public_record(record) for record in records]
    by_adapter: dict[str, list[dict]] = {}
    for record in public:
        by_adapter.setdefault(record["adapter"], []).append(record)
    return {
        "schema_version": 1,
        "generated_by": "lancer_eval",
        "note": "Generated by a run. Not a published benchmark score.",
        "run_id": config.run_id,
        "dataset": config.dataset_name,
        "split": config.split if config.dataset_name else None,
        "requested_grade": config.grade,
        "grade_mode": grade_mode,
        "grade_fallback_reason": fallback,
        "adapters": [summarize_adapter(name, rows) for name, rows in by_adapter.items()],
        "skipped_adapters": skipped,
        "instances": public,
    }


def _public_record(record: dict) -> dict:
    hidden = {"patch", "log", "gold_files"}
    return {key: value for key, value in record.items() if key not in hidden}


def _write_instance(directory: Path, record: dict, secrets: list[str]) -> None:
    patch = record.get("patch") or ""
    (directory / "patch.diff").write_text(patch, encoding="utf-8")
    (directory / "agent.log").write_text(redact(record.get("log") or "", secrets), encoding="utf-8")
    public = _public_record(record)
    public["patch_bytes"] = len(patch.encode("utf-8"))
    public["patch_sha256"] = sha256_text(patch)
    (directory / "result.json").write_text(
        json.dumps(public, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    record["patch_bytes"] = public["patch_bytes"]
    record["patch_sha256"] = public["patch_sha256"]


def _cost(result, config: RunConfig) -> tuple[float | None, str | None]:
    if result.cost_usd is not None:
        return float(result.cost_usd), result.cost_source or "adapter"
    usage = result.usage
    if (
        usage
        and config.input_usd_per_million is not None
        and config.output_usd_per_million is not None
        and usage.input_tokens is not None
        and usage.output_tokens is not None
    ):
        cost = (
            usage.input_tokens * config.input_usd_per_million
            + usage.output_tokens * config.output_usd_per_million
        ) / 1_000_000
        return cost, "token_price"
    return None, None


def _log(config: RunConfig, message: str) -> None:
    if not config.quiet:
        print(f"lancer-eval: {message}")


def git_identity_env() -> dict[str, str]:
    """Exposed for tests that commit fixture repositories."""

    env = git_env()
    env.setdefault("GIT_AUTHOR_NAME", "Lancer Eval")
    env.setdefault("GIT_AUTHOR_EMAIL", "eval@example.com")
    env.setdefault("GIT_COMMITTER_NAME", "Lancer Eval")
    env.setdefault("GIT_COMMITTER_EMAIL", "eval@example.com")
    return env
