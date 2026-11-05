"""Heuristic failure buckets, plus an optional labeled LLM judge."""

from __future__ import annotations

import json
import re
import urllib.request
from typing import Callable

from lancer_eval.types import FAILURE_BUCKETS

_TOOL_ERROR = re.compile(
    r"Traceback \(most recent call last\)"
    r"|command failed"
    r"|\"success\": false"
    r"|\"exitCode\": [1-9][0-9]*"
    r"|exit_code[\"']?\s*[:=]\s*[1-9]",
    re.IGNORECASE,
)


def tool_error_in_log(log: str, *, ignore_text: str = "") -> bool:
    """Look for a failed command in the agent log.

    `ignore_text` is removed first so a traceback copied from the issue prompt
    is not treated as a tool failure.
    """

    scanned = log or ""
    if ignore_text:
        scanned = scanned.replace(ignore_text, "")
    return bool(scanned and _TOOL_ERROR.search(scanned))


def attribute_failure(
    *,
    timed_out: bool,
    setup_failed: bool,
    collect_failed: bool = False,
    patch: str,
    patch_applies: bool,
    official: bool,
    resolved: bool | None,
    tests_executed: bool,
    infra_error: bool,
    tool_error: bool,
    gold_files: list[str],
    touched_files: list[str],
) -> dict:
    """Return the first matching bucket. `bucket` is null when this is not a classified failure."""

    reasons: list[str] = []
    bucket: str | None = None
    gold = set(gold_files)
    touched = set(touched_files)
    disjoint = bool(gold and touched and gold.isdisjoint(touched))

    if timed_out:
        bucket = "timeout"
        reasons.append("the agent exceeded the wall-time limit")
    elif setup_failed or collect_failed or infra_error:
        bucket = "environment_setup_error"
        reasons.append("repository setup or the evaluation harness failed before a test result")
    elif resolved is True:
        reasons.append("the graded tests passed")
    elif not patch.strip():
        bucket = "empty_patch"
        reasons.append("the agent produced no unified diff")
    elif not patch_applies:
        bucket = "patch_does_not_apply"
        reasons.append("git apply --check rejected the patch on a clean checkout of the base commit")
    elif official and tests_executed:
        if disjoint:
            bucket = "context_retrieval_miss"
            reasons.append("the patch applies but shares no files with the gold patch file list")
        else:
            bucket = "tests_fail"
            reasons.append("the official harness ran and the instance was not resolved")
    elif tool_error:
        bucket = "tool_or_command_error"
        reasons.append("the agent log contains a command or tool failure")
    elif disjoint:
        bucket = "context_retrieval_miss"
        reasons.append("the edited files do not overlap the gold patch file list")
    elif tests_executed and resolved is False:
        bucket = "tests_fail"
        reasons.append("the configured tests ran and failed")
    else:
        reasons.append("lightweight grade checked that the patch applies and did not run FAIL_TO_PASS")

    if bucket is not None and bucket not in FAILURE_BUCKETS:
        raise ValueError(f"unknown bucket {bucket}")
    return {"bucket": bucket, "reasons": reasons, "source": "heuristic"}


def judge_failure(
    *,
    heuristic: dict,
    instance_id: str,
    log_excerpt: str,
    touched_files: list[str],
    gold_files: list[str],
    complete: Callable[[str], str],
) -> dict:
    """Ask a judge model for a bucket. The heuristic stays authoritative unless overridden later."""

    prompt = (
        "Classify this coding-agent failure. Reply with JSON only: "
        '{"bucket": "<one label>", "reason": "<one sentence>"}.\n'
        f"Allowed labels: {', '.join(FAILURE_BUCKETS)}.\n"
        f"Instance: {instance_id}\n"
        f"Heuristic bucket: {heuristic.get('bucket')}\n"
        f"Heuristic reasons: {heuristic.get('reasons')}\n"
        f"Gold files: {gold_files}\n"
        f"Touched files: {touched_files}\n"
        "Agent log excerpt:\n"
        f"{log_excerpt[:4000]}\n"
    )
    try:
        raw = complete(prompt)
        parsed = _parse_judge(raw)
    except (OSError, ValueError, json.JSONDecodeError, TimeoutError) as exc:
        return {
            "source": "llm_judge",
            "bucket": None,
            "reason": None,
            "error": str(exc),
            "raw": None,
        }
    return {
        "source": "llm_judge",
        "bucket": parsed["bucket"],
        "reason": parsed["reason"],
        "error": None,
        "raw": raw,
    }


def apply_judge(heuristic: dict, judged: dict | None, *, override: bool) -> dict:
    failure = dict(heuristic)
    failure["llm_judge"] = judged
    if (
        override
        and judged
        and judged.get("bucket") in FAILURE_BUCKETS
        and not judged.get("error")
    ):
        failure["bucket"] = judged["bucket"]
        failure["source"] = "llm_judge"
        failure["reasons"] = list(heuristic.get("reasons") or []) + [
            f"llm judge override: {judged.get('reason') or judged['bucket']}"
        ]
    return failure


def _parse_judge(raw: str) -> dict:
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("judge response did not contain JSON")
    payload = json.loads(raw[start : end + 1])
    bucket = payload.get("bucket")
    if bucket not in FAILURE_BUCKETS:
        raise ValueError(f"judge returned an unknown bucket: {bucket!r}")
    reason = payload.get("reason")
    if not isinstance(reason, str):
        reason = ""
    return {"bucket": bucket, "reason": reason.strip()}


def openai_compatible_complete(
    prompt: str,
    *,
    base_url: str,
    api_key: str,
    model: str,
    timeout: float = 60,
) -> str:
    """POST a chat completion. The key is sent as a header and is not returned."""

    root = base_url.rstrip("/")
    if root.endswith("/chat/completions"):
        url = root
    else:
        url = root + "/chat/completions"
    body = json.dumps(
        {
            "model": model,
            "temperature": 0,
            "messages": [
                {
                    "role": "system",
                    "content": "You label coding-agent failures. Reply with JSON only.",
                },
                {"role": "user", "content": prompt},
            ],
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return str(payload["choices"][0]["message"]["content"])
