"""Command line for the coding-agent eval harness."""

from __future__ import annotations

import argparse
import json
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

from lancer_eval.dataset import fetch_swebench_instances, filter_tasks, load_task_set
from lancer_eval.failures import openai_compatible_complete
from lancer_eval.manifest import default_manifest_path
from lancer_eval.report import render_html, render_markdown
from lancer_eval.runner import ADAPTER_NAMES, RunConfig, build_adapters, execute

EVALS_ROOT = Path(__file__).resolve().parents[1]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lancer-eval",
        description="Run a small SWE-bench Lite subset through Lancer, Claude Code, Codex, or a mock agent.",
    )
    sub = parser.add_subparsers(dest="command")

    run = sub.add_parser("run", help="prepare repos, run adapters, grade, and write a report")
    run.add_argument("--adapter", action="append", dest="adapters", help="adapter name; repeat to compare")
    run.add_argument("--all", action="store_true", help="run lancer, claude-code, and codex; skip any that are not installed")
    run.add_argument("--include-mock", action="store_true", help="with --all, also run the mock adapter")
    run.add_argument("--task-set", type=Path, help="custom task JSON instead of the SWE-bench manifest")
    run.add_argument("--manifest", type=Path, default=None, help="SWE-bench subset manifest")
    run.add_argument("--instances", help="comma-separated instance ids")
    run.add_argument("--limit", type=int, help="run only the first N selected instances")
    run.add_argument("--output", type=Path, help="run directory (default: evals/runs/<timestamp>)")
    run.add_argument("--timeout", type=float, default=900, help="agent wall-time limit in seconds")
    run.add_argument("--grade", choices=("auto", "official", "lightweight"), default="auto")
    run.add_argument("--strict-grade", action="store_true", help="exit 1 when official grading was requested but is unavailable")
    run.add_argument("--run-local-tests", action="store_true", help="for a custom task set, run each test_command on the host")
    run.add_argument("--model", help="model id passed to the selected adapter")
    run.add_argument("--base-url", help="OpenAI-compatible or Anthropic gateway base URL for Claude Code and Codex")
    run.add_argument("--include-hints", action="store_true", help="include SWE-bench hints_text in the prompt")
    run.add_argument("--judge", action="store_true", help="optional LLM judge; labeled separately from the heuristic")
    run.add_argument("--judge-override", action="store_true", help="replace the heuristic bucket with the judge label")
    run.add_argument("--judge-model", default=os.environ.get("LANCER_EVAL_JUDGE_MODEL") or "gpt-4.1-mini")
    run.add_argument("--judge-base-url", default=os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1")
    run.add_argument("--input-usd-per-million", type=float, help="optional token price; unused when the adapter reports cost")
    run.add_argument("--output-usd-per-million", type=float)
    run.add_argument("--mock-spec", type=Path, help="JSON spec for the mock adapter")
    run.add_argument("--lancer-ctl", type=Path, help="path to lancer-ctl (default: scripts/lancer-ctl)")
    run.add_argument("--workers", type=int, default=1, help="SWE-bench harness workers")
    run.add_argument("--grade-timeout", type=int, default=1800, help="per-instance official test timeout in seconds")
    run.add_argument("--quiet", action="store_true")

    adapters = sub.add_parser("adapters", help="show which adapters can run on this machine")
    report = sub.add_parser("report", help="rebuild Markdown and HTML from a summary.json")
    report.add_argument("--run", type=Path, required=True, help="run directory that contains summary.json")
    parser.add_argument("--self-test", action="store_true", help="run the offline unit tests")
    # The subparsers above are created so --help lists them. `adapters` takes no options.
    del adapters
    return parser


def main(argv: list[str] | None = None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    if "--self-test" in raw:
        return _self_test()
    if not raw or raw[0] in {"-h", "--help"}:
        build_parser().print_help()
        return 0 if raw else 2
    if raw[0] not in {"run", "adapters", "report"}:
        raw = ["run", *raw]
    parser = build_parser()
    args = parser.parse_args(raw)
    if args.command == "adapters":
        return _print_adapters()
    if args.command == "report":
        return _rebuild_report(args.run)
    return _run(args)


def _print_adapters() -> int:
    config = RunConfig(adapters=list(ADAPTER_NAMES), output_dir=Path("."))
    for name, adapter in build_adapters(config).items():
        availability = adapter.available()
        state = "ready" if availability.ready else availability.reason
        detail = availability.detail.replace("\n", " ")
        print(f"{name}\t{state}\t{detail}")
    return 0


def _rebuild_report(run_dir: Path) -> int:
    summary_path = run_dir / "summary.json"
    if not summary_path.is_file():
        print(f"lancer-eval: no summary.json in {run_dir}", file=sys.stderr)
        return 1
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    (run_dir / "report.md").write_text(render_markdown(summary), encoding="utf-8")
    (run_dir / "report.html").write_text(render_html(summary), encoding="utf-8")
    print(run_dir / "report.md")
    return 0


def _run(args: argparse.Namespace) -> int:
    adapters = _selected_adapters(args)
    instance_ids = [item for item in (args.instances or "").split(",") if item]
    manifest = args.manifest or default_manifest_path()
    if args.task_set:
        tasks = filter_tasks(
            load_task_set(args.task_set),
            instance_ids=instance_ids or None,
            limit=args.limit,
        )
        dataset_name = None
        split = "test"
    else:
        tasks = fetch_swebench_instances(
            manifest,
            instance_ids=instance_ids or None,
            limit=args.limit,
        )
        manifest_data = json.loads(manifest.read_text(encoding="utf-8"))
        dataset_name = manifest_data.get("huggingface_id") or manifest_data["dataset"]
        split = manifest_data["split"]
    if args.judge and not os.environ.get("OPENAI_API_KEY"):
        print("lancer-eval: --judge ignored because OPENAI_API_KEY is not set", file=sys.stderr)
        args.judge = False
    mock_spec = None
    if args.mock_spec:
        mock_spec = json.loads(args.mock_spec.read_text(encoding="utf-8"))
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = args.output or (EVALS_ROOT / "runs" / run_id)
    config = RunConfig(
        adapters=adapters,
        output_dir=output,
        timeout_seconds=args.timeout,
        grade=args.grade,
        run_local_tests=args.run_local_tests,
        model=args.model,
        base_url=args.base_url,
        include_hints=args.include_hints,
        judge=args.judge,
        judge_override=args.judge_override,
        judge_model=args.judge_model,
        judge_base_url=args.judge_base_url,
        judge_api_key=os.environ.get("OPENAI_API_KEY"),
        input_usd_per_million=args.input_usd_per_million,
        output_usd_per_million=args.output_usd_per_million,
        dataset_name=dataset_name,
        split=split,
        run_id=run_id,
        grade_timeout=args.grade_timeout,
        workers=args.workers,
        mock_spec=mock_spec,
        lancer_ctl=args.lancer_ctl,
        quiet=args.quiet,
    )
    judge_complete = None
    if config.judge and config.judge_api_key and config.judge_base_url and config.judge_model:
        key = config.judge_api_key
        base_url = config.judge_base_url
        model = config.judge_model

        def judge_complete(prompt: str, key=key, base_url=base_url, model=model) -> str:
            return openai_compatible_complete(prompt, base_url=base_url, api_key=key, model=model)

    summary = execute(config, tasks, judge_complete=judge_complete)
    print(output / "report.md")
    if args.strict_grade and summary["requested_grade"] == "official" and summary["grade_mode"] != "official":
        print("lancer-eval: official grading was unavailable", file=sys.stderr)
        return 1
    if summary["adapters"] or summary["skipped_adapters"]:
        return 0
    return 1


def _selected_adapters(args: argparse.Namespace) -> list[str]:
    if args.all:
        names = ["lancer", "claude-code", "codex"]
        if args.include_mock:
            names.append("mock")
        return names
    names = list(args.adapters or ["mock"])
    unknown = [name for name in names if name not in ADAPTER_NAMES]
    if unknown:
        raise SystemExit("unknown adapter: " + ", ".join(unknown))
    return names


def _self_test() -> int:
    suite = unittest.defaultTestLoader.discover(str(EVALS_ROOT / "tests"), pattern="test_*.py")
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    return 0 if result.wasSuccessful() else 1
