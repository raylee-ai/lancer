"""Offline pipeline tests. They use the mock adapter and local git repos."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lancer_eval.adapters.claude_code import claude_command, claude_env, parse_claude_output
from lancer_eval.adapters.codex import codex_command, codex_env, parse_codex_jsonl
from lancer_eval.adapters.lancer import parse_logs, parse_new_result, parse_tail
from lancer_eval.diffutil import extract_unified_diff, files_in_diff, redact
from lancer_eval.failures import (
    apply_judge,
    attribute_failure,
    judge_failure,
    openai_compatible_complete,
    tool_error_in_log,
)
from lancer_eval.grading import grade_from_report, parse_swebench_reports, select_grade_mode, swebench_command
from lancer_eval.metrics import summarize_adapter
from lancer_eval.prompt import build_prompt
from lancer_eval.report import render_markdown
from lancer_eval.runner import RunConfig, execute
from lancer_eval.types import InstanceSpec, TokenUsage


def _git(repo: Path, *args: str) -> str:
    env = dict(os.environ)
    env.update(
        {
            "GIT_AUTHOR_NAME": "Lancer Eval",
            "GIT_AUTHOR_EMAIL": "eval@example.com",
            "GIT_COMMITTER_NAME": "Lancer Eval",
            "GIT_COMMITTER_EMAIL": "eval@example.com",
            "GIT_TERMINAL_PROMPT": "0",
        }
    )
    completed = subprocess.run(
        ["git", *args],
        cwd=repo if repo.exists() else None,
        env=env,
        text=True,
        capture_output=True,
        check=True,
    )
    return completed.stdout.strip()


def _repo(root: Path) -> tuple[Path, str]:
    repo = root / "origin"
    repo.mkdir()
    _git(repo, "init")
    _git(repo, "config", "core.autocrlf", "false")
    _git(repo, "config", "commit.gpgsign", "false")
    (repo / "src").mkdir()
    (repo / "src" / "app.py").write_text("value = 1\n", encoding="utf-8")
    (repo / "README.md").write_text("hello\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "init")
    return repo, _git(repo, "rev-parse", "HEAD")


def _task(instance_id: str, repo: Path, commit: str, **overrides) -> InstanceSpec:
    data = dict(
        instance_id=instance_id,
        repo="local/demo",
        base_commit=commit,
        problem_statement="Change the returned value.",
        repo_url=str(repo),
        gold_files=["src/app.py"],
        swebench=False,
    )
    data.update(overrides)
    return InstanceSpec(**data)


class PipelineTest(unittest.TestCase):
    def test_mock_pipeline_grades_and_attributes(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            origin, commit = _repo(Path(tmp))
            spec = {
                "instances": {
                    "local__demo-1": {"mode": "edit", "relpath": "src/app.py", "old": "value = 1", "new": "value = 2", "input_tokens": 10, "output_tokens": 4, "cost_usd": 0.2, "wall_time_seconds": 1.5},
                    "local__demo-2": {"mode": "edit", "relpath": "README.md", "old": "hello", "new": "goodbye"},
                    "local__demo-3": {"mode": "empty"},
                    "local__demo-4": {
                        "mode": "patch",
                        "patch": "diff --git a/missing.py b/missing.py\n--- a/missing.py\n+++ b/missing.py\n@@ -1 +1 @@\n-nope\n+yep\n",
                    },
                    "local__demo-5": {"mode": "timeout"},
                    "local__demo-6": {"mode": "command_error", "relpath": "src/app.py", "old": "value = 1", "new": "value = 3"},
                }
            }
            tasks = [
                _task("local__demo-1", origin, commit),
                _task("local__demo-2", origin, commit),
                _task("local__demo-3", origin, commit),
                _task("local__demo-4", origin, commit),
                _task("local__demo-5", origin, commit),
                _task("local__demo-6", origin, commit),
                _task("local__demo-7", origin, commit, repo_url=str(Path(tmp) / "missing-repo")),
            ]
            output = Path(tmp) / "out"
            summary = execute(
                RunConfig(
                    adapters=["mock"],
                    output_dir=output,
                    mock_spec=spec,
                    timeout_seconds=5,
                    quiet=True,
                    grade="lightweight",
                    input_usd_per_million=2,
                    output_usd_per_million=8,
                ),
                tasks,
                docker=False,
                swebench=False,
            )
            by_id = {row["instance_id"]: row for row in summary["instances"]}
            self.assertTrue(by_id["local__demo-1"]["patch_applies"])
            self.assertIsNone(by_id["local__demo-1"]["resolved"])
            self.assertIsNone(by_id["local__demo-1"]["failure_bucket"])
            self.assertEqual(by_id["local__demo-1"]["grade_mode"], "lightweight")
            self.assertEqual(by_id["local__demo-1"]["cost_usd"], 0.2)
            self.assertEqual(by_id["local__demo-1"]["cost_source"], "adapter")
            self.assertEqual(by_id["local__demo-1"]["input_tokens"], 10)
            self.assertEqual(by_id["local__demo-2"]["failure_bucket"], "context_retrieval_miss")
            self.assertEqual(by_id["local__demo-3"]["failure_bucket"], "empty_patch")
            self.assertEqual(by_id["local__demo-4"]["failure_bucket"], "patch_does_not_apply")
            self.assertEqual(by_id["local__demo-5"]["failure_bucket"], "timeout")
            self.assertEqual(by_id["local__demo-6"]["failure_bucket"], "tool_or_command_error")
            self.assertEqual(by_id["local__demo-7"]["failure_bucket"], "environment_setup_error")
            self.assertTrue((output / "report.md").is_file())
            self.assertTrue((output / "report.html").is_file())
            report = (output / "report.md").read_text(encoding="utf-8")
            self.assertIn("local__demo-1", report)
            self.assertIn("Not a published benchmark score", report)
            adapter = summary["adapters"][0]
            self.assertIsNone(adapter["resolve_rate"])
            self.assertIsNone(by_id["local__demo-7"]["patch_applies"])
            self.assertEqual(adapter["patch_applies"], 3)
            self.assertEqual(adapter["patch_applies_observed"], 6)
            self.assertAlmostEqual(adapter["patch_applies_rate"], 0.5)
            self.assertIn("context_retrieval_miss", adapter["failure_buckets"])
            prompt = (output / "mock" / "local__demo-1" / "prompt.txt").read_text(encoding="utf-8")
            self.assertNotIn("src/app.py", prompt)

    def test_lightweight_report_does_not_invent_a_resolve_rate(self) -> None:
        summary = {
            "note": "Generated by a run. Not a published benchmark score.",
            "dataset": None,
            "split": None,
            "requested_grade": "auto",
            "grade_mode": "lightweight",
            "grade_fallback_reason": "Docker is not available",
            "run_id": "test",
            "adapters": [
                summarize_adapter(
                    "mock",
                    [{"resolved": None, "patch_applies": True, "wall_time_seconds": 1.0, "failure_bucket": None}],
                )
            ],
            "skipped_adapters": [{"adapter": "claude-code", "reason": "not_installed", "detail": "claude is not on PATH"}],
            "instances": [
                {
                    "adapter": "mock",
                    "instance_id": "local__demo-1",
                    "resolved": None,
                    "patch_applies": True,
                    "grade_mode": "lightweight",
                    "wall_time_seconds": 1.0,
                    "input_tokens": None,
                    "output_tokens": None,
                    "cost_usd": None,
                    "tool_calls": None,
                    "turns": None,
                    "failure_bucket": None,
                    "failure_source": "heuristic",
                    "llm_judge": None,
                }
            ],
        }
        markdown = render_markdown(summary)
        row = next(line for line in markdown.splitlines() if line.startswith("| mock |"))
        cells = [cell.strip() for cell in row.strip("|").split("|")]
        self.assertEqual(cells[3], "未运行")
        self.assertEqual(cells[4], "未运行")
        self.assertNotIn("0.0%", cells[4])
        self.assertIn("claude-code", markdown)
        self.assertIn("not_installed", markdown)

    def test_metrics_ignore_missing_usage(self) -> None:
        metrics = summarize_adapter(
            "codex",
            [
                {"resolved": True, "patch_applies": True, "wall_time_seconds": 10, "input_tokens": 100, "output_tokens": 20, "cost_usd": 1.5, "tool_calls": 3, "turns": 2},
                {"resolved": False, "patch_applies": True, "wall_time_seconds": 30, "input_tokens": None, "output_tokens": None, "cost_usd": None, "tool_calls": None, "turns": None},
                {"resolved": None, "patch_applies": False, "wall_time_seconds": 5},
                {"resolved": None, "patch_applies": None, "wall_time_seconds": None},
            ],
        )
        self.assertEqual(metrics["official_graded"], 2)
        self.assertEqual(metrics["resolved"], 1)
        self.assertAlmostEqual(metrics["resolve_rate"], 0.5)
        self.assertEqual(metrics["patch_applies"], 2)
        self.assertEqual(metrics["patch_applies_observed"], 3)
        self.assertAlmostEqual(metrics["patch_applies_rate"], 2 / 3)
        untouched = summarize_adapter("skipped", [{"resolved": None, "patch_applies": None}])
        self.assertIsNone(untouched["patch_applies"])
        self.assertIsNone(untouched["patch_applies_rate"])
        self.assertEqual(metrics["input_tokens"], 100)
        self.assertEqual(metrics["tokens_observed"], 1)
        self.assertEqual(metrics["cost_usd"], 1.5)
        self.assertEqual(metrics["mean_wall_time_seconds"], 15)
        self.assertEqual(metrics["median_wall_time_seconds"], 10)
        self.assertEqual(metrics["mean_tool_calls"], 3)
        self.assertEqual(metrics["mean_turns"], 2)

    def test_token_price_is_used_only_when_the_adapter_has_no_cost(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            origin, commit = _repo(Path(tmp))
            summary = execute(
                RunConfig(
                    adapters=["mock"],
                    output_dir=Path(tmp) / "out",
                    mock_spec={"instances": {"local__demo-1": {"mode": "empty", "input_tokens": 1000, "output_tokens": 500}}},
                    quiet=True,
                    input_usd_per_million=3,
                    output_usd_per_million=6,
                ),
                [_task("local__demo-1", origin, commit)],
                docker=False,
                swebench=False,
            )
            row = summary["instances"][0]
            self.assertEqual(row["cost_source"], "token_price")
            self.assertAlmostEqual(row["cost_usd"], 0.006)

    def test_skipped_adapter_is_reported(self) -> None:
        import tempfile

        from lancer_eval.types import AgentResult, Availability

        class Missing:
            name = "claude-code"

            def available(self) -> Availability:
                return Availability(False, "not_installed", "claude is not on PATH")

            def run(self, task, workspace, timeout) -> AgentResult:
                raise AssertionError("skipped adapter should not run")

        with tempfile.TemporaryDirectory() as tmp:
            origin, commit = _repo(Path(tmp))
            summary = execute(
                RunConfig(adapters=["claude-code"], output_dir=Path(tmp) / "out", quiet=True),
                [_task("local__demo-1", origin, commit)],
                adapters={"claude-code": Missing()},
                docker=False,
                swebench=False,
            )
            self.assertEqual(summary["instances"], [])
            self.assertEqual(summary["skipped_adapters"][0]["reason"], "not_installed")
            self.assertEqual(summary["adapters"], [])

    def test_secret_values_are_not_written(self) -> None:
        import tempfile

        key = "sk-test-eval-secret-value"
        os.environ["OPENAI_API_KEY"] = key
        self.addCleanup(os.environ.pop, "OPENAI_API_KEY", None)
        with tempfile.TemporaryDirectory() as tmp:
            origin, commit = _repo(Path(tmp))
            output = Path(tmp) / "out"
            execute(
                RunConfig(
                    adapters=["mock"],
                    output_dir=output,
                    mock_spec={
                        "instances": {
                            "local__demo-1": {
                                "mode": "empty",
                                "extra_log": f"leaked {key}\n",
                                "error": f"failed with {key}",
                            }
                        }
                    },
                    quiet=True,
                ),
                [_task("local__demo-1", origin, commit)],
                docker=False,
                swebench=False,
            )
            written = "\n".join(
                path.read_text(encoding="utf-8")
                for path in (
                    output / "summary.json",
                    output / "report.md",
                    output / "mock" / "local__demo-1" / "agent.log",
                    output / "mock" / "local__demo-1" / "result.json",
                )
            )
            self.assertNotIn(key, written)
            self.assertIn("[REDACTED]", written)

    def test_custom_task_can_run_a_host_command(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            origin, commit = _repo(Path(tmp))
            task = _task(
                "local__demo-1",
                origin,
                commit,
                test_command="python3 -c \"import pathlib; assert pathlib.Path('src/app.py').read_text() == 'value = 2\\n'\"",
            )
            summary = execute(
                RunConfig(
                    adapters=["mock"],
                    output_dir=Path(tmp) / "out",
                    mock_spec={"instances": {"local__demo-1": {"mode": "edit", "relpath": "src/app.py", "old": "value = 1", "new": "value = 2"}}},
                    run_local_tests=True,
                    quiet=True,
                    grade="lightweight",
                ),
                [task],
                docker=False,
                swebench=False,
            )
            row = summary["instances"][0]
            self.assertEqual(row["grade_mode"], "local_commands")
            self.assertTrue(row["resolved"])
            self.assertFalse(row["official"])
            self.assertIsNone(row["failure_bucket"])


class AttributionTest(unittest.TestCase):
    def test_official_wrong_fix_and_retrieval_miss(self) -> None:
        wrong_fix = attribute_failure(
            timed_out=False,
            setup_failed=False,
            patch="diff --git a/src/app.py b/src/app.py\n",
            patch_applies=True,
            official=True,
            resolved=False,
            tests_executed=True,
            infra_error=False,
            tool_error=True,
            gold_files=["src/app.py"],
            touched_files=["src/app.py"],
        )
        self.assertEqual(wrong_fix["bucket"], "tests_fail")
        resolved = attribute_failure(
            timed_out=False,
            setup_failed=False,
            patch="diff --git a/src/app.py b/src/app.py\n",
            patch_applies=False,
            official=True,
            resolved=True,
            tests_executed=True,
            infra_error=False,
            tool_error=False,
            gold_files=["src/app.py"],
            touched_files=["src/app.py"],
        )
        self.assertIsNone(resolved["bucket"])
        miss = attribute_failure(
            timed_out=False,
            setup_failed=False,
            patch="diff --git a/README.md b/README.md\n",
            patch_applies=True,
            official=True,
            resolved=False,
            tests_executed=True,
            infra_error=False,
            tool_error=False,
            gold_files=["src/app.py"],
            touched_files=["README.md"],
        )
        self.assertEqual(miss["bucket"], "context_retrieval_miss")
        echoed = "Traceback (most recent call last)\nValueError: sample"
        self.assertFalse(tool_error_in_log(f"prompt:\n{echoed}\nagent finished", ignore_text=echoed))
        self.assertTrue(tool_error_in_log(f"prompt:\n{echoed}\ncommand failed: pytest", ignore_text=echoed))

    def test_judge_is_labeled_and_optional(self) -> None:
        heuristic = {"bucket": "tests_fail", "reasons": ["tests failed"], "source": "heuristic"}
        judged = judge_failure(
            heuristic=heuristic,
            instance_id="local__demo-1",
            log_excerpt="command failed",
            touched_files=["src/app.py"],
            gold_files=["src/app.py"],
            complete=lambda prompt: '{"bucket": "tool_or_command_error", "reason": "the tool crashed"}',
        )
        kept = apply_judge(heuristic, judged, override=False)
        self.assertEqual(kept["bucket"], "tests_fail")
        self.assertEqual(kept["source"], "heuristic")
        self.assertEqual(kept["llm_judge"]["source"], "llm_judge")
        overridden = apply_judge(heuristic, judged, override=True)
        self.assertEqual(overridden["bucket"], "tool_or_command_error")
        self.assertEqual(overridden["source"], "llm_judge")

    def test_judge_http_client_posts_the_key_as_a_header(self) -> None:
        seen = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers["Content-Length"])
                seen["auth"] = self.headers["Authorization"]
                seen["body"] = self.rfile.read(length)
                body = json.dumps({"choices": [{"message": {"content": '{"bucket": "timeout", "reason": "slow"}'}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, fmt: str, *args) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_address[1]
            text = openai_compatible_complete(
                "classify",
                base_url=f"http://127.0.0.1:{port}/v1",
                api_key="sk-test-secret",
                model="judge",
            )
        finally:
            server.shutdown()
        self.assertIn("timeout", text)
        self.assertEqual(seen["auth"], "Bearer sk-test-secret")
        self.assertNotIn("sk-test-secret", seen["body"].decode())


class AdapterContractTest(unittest.TestCase):
    def test_claude_and_codex_keep_keys_out_of_argv(self) -> None:
        os.environ["ANTHROPIC_API_KEY"] = "sk-ant-test-secret"
        os.environ["OPENAI_API_KEY"] = "sk-openai-test-secret"
        self.addCleanup(os.environ.pop, "ANTHROPIC_API_KEY", None)
        self.addCleanup(os.environ.pop, "OPENAI_API_KEY", None)
        claude = claude_command("Fix the bug", "sonnet")
        codex = codex_command("gpt-test", "https://gateway.example/v1")
        self.assertNotIn("sk-ant-test-secret", claude)
        self.assertNotIn("sk-openai-test-secret", codex)
        self.assertEqual(claude[:5], ["claude", "--print", "--output-format", "json", "--dangerously-skip-permissions"])
        self.assertIn("--model", claude)
        self.assertIn("exec", codex)
        self.assertIn("--json", codex)
        self.assertIn("--sandbox", codex)
        self.assertIn("workspace-write", codex)
        self.assertIn("openai_base_url=https://gateway.example/v1", codex)
        self.assertEqual(claude_env("https://anthropic.example")["ANTHROPIC_BASE_URL"], "https://anthropic.example")
        self.assertEqual(codex_env("https://gateway.example/v1")["OPENAI_BASE_URL"], "https://gateway.example/v1")
        self.assertNotIn("sk-openai-test-secret", codex_env("https://gateway.example/v1").get("OPENAI_BASE_URL", ""))

    def test_claude_and_codex_usage_parsers(self) -> None:
        text, usage, cost, turns = parse_claude_output(
            json.dumps(
                {
                    "type": "result",
                    "result": "edited the file",
                    "total_cost_usd": 0.01,
                    "num_turns": 2,
                    "usage": {"input_tokens": 11, "output_tokens": 7},
                }
            )
        )
        self.assertEqual(text, "edited the file")
        self.assertEqual(usage, TokenUsage(11, 7))
        self.assertEqual(cost, 0.01)
        self.assertEqual(turns, 2)
        transcript, usage, tools, parsed_turns, _ = parse_codex_jsonl(
            "\n".join(
                [
                    json.dumps({"type": "turn.completed", "usage": {"input_tokens": 3, "output_tokens": 4}}),
                    json.dumps({"type": "item.completed", "item": {"type": "command_execution", "command": "ls"}}),
                    json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "done"}}),
                ]
            )
        )
        self.assertEqual(transcript, "done")
        self.assertEqual(usage.input_tokens, 3)
        self.assertEqual(tools, 1)
        self.assertEqual(parsed_turns, 1)

    def test_lancer_control_parsers(self) -> None:
        session = parse_new_result(
            json.dumps({"accepted": True, "session": {"workspaceId": "w", "sessionId": "s1"}, "mode": "send"})
        )
        self.assertEqual(session, "s1")
        assistant, turns = parse_tail(
            json.dumps(
                {
                    "lastAssistant": "done",
                    "messages": [
                        {"role": "user", "text": "fix"},
                        {"role": "assistant", "text": "done"},
                    ],
                }
            )
        )
        self.assertEqual(assistant, "done")
        self.assertEqual(turns, 1)
        tools, failed = parse_logs(
            json.dumps(
                {
                    "events": [
                        {"kind": "toolStarted", "toolName": "bash"},
                        {"kind": "toolFinished", "success": False, "exitCode": 1},
                    ]
                }
            )
        )
        self.assertEqual(tools, 1)
        self.assertTrue(failed)

    def test_diff_extraction_and_redaction(self) -> None:
        text = "I changed it.\n```diff\ndiff --git a/src/app.py b/src/app.py\n--- a/src/app.py\n+++ b/src/app.py\n@@ -1 +1 @@\n-value = 1\n+value = 2\n```\n"
        patch = extract_unified_diff(text)
        self.assertTrue(patch.startswith("diff --git "))
        self.assertEqual(files_in_diff(patch), ["src/app.py"])
        self.assertEqual(redact("key sk-live-secret-value", ["sk-live-secret-value"]), "key [REDACTED]")
        prompt = build_prompt(
            InstanceSpec(
                instance_id="local__demo-1",
                repo="local/demo",
                base_commit="abc",
                problem_statement="Fix the bug",
                gold_files=["src/app.py"],
                hints_text="look at app.py",
            ),
            include_hints=False,
        )
        self.assertNotIn("src/app.py", prompt)
        self.assertNotIn("look at app.py", prompt)

    def test_grade_mode_and_swebench_report(self) -> None:
        self.assertEqual(
            select_grade_mode("auto", docker=False, swebench=True, tasks_are_swebench=True),
            ("lightweight", "Docker is not available"),
        )
        self.assertEqual(
            select_grade_mode("official", docker=True, swebench=True, tasks_are_swebench=True)[0],
            "official",
        )
        command = swebench_command(
            predictions=Path("predictions.jsonl"),
            dataset_name="princeton-nlp/SWE-bench_Lite",
            split="test",
            instance_ids=["django__django-10924"],
            run_id="sample",
            timeout=1800,
            workers=1,
        )
        self.assertIn("swebench.harness.run_evaluation", command)
        self.assertIn("princeton-nlp/SWE-bench_Lite", command)
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "logs" / "sample" / "mock" / "django__django-10924"
            report.mkdir(parents=True)
            (report / "report.json").write_text(
                json.dumps(
                    {
                        "resolved": False,
                        "patch_successfully_applied": True,
                        "tests_status": {
                            "FAIL_TO_PASS": {"success": [], "failure": ["tests/test_app.py::test_value"]},
                            "PASS_TO_PASS": {"success": ["tests/test_app.py::test_ok"], "failure": []},
                        },
                    }
                ),
                encoding="utf-8",
            )
            parsed = parse_swebench_reports(Path(tmp))
            grade = grade_from_report("django__django-10924", parsed["django__django-10924"], log="")
            self.assertFalse(grade.resolved)
            self.assertTrue(grade.patch_applies)
            self.assertTrue(grade.tests_executed)
            self.assertFalse(grade.infra_error)


if __name__ == "__main__":
    unittest.main()
