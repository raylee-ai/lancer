"""Load and check the checked-in SWE-bench Lite subset manifest."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

INSTANCE_ID = re.compile(r"^.+__.+-[0-9]+$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
DIFFICULTIES = {"localized", "moderate", "broader"}


def difficulty_heuristic(
    *,
    gold_patch_lines: int,
    fail_to_pass_count: int,
    pass_to_pass_count: int,
    problem_statement_chars: int,
) -> str:
    """Selection label from the public dataset row, not an agent score.

    broader: long issue, large gold patch, many failing tests, or a large
    regression list. localized: small gold patch and a short test list.
    Everything else is moderate.
    """

    tests = fail_to_pass_count + pass_to_pass_count
    if (
        problem_statement_chars >= 4000
        or gold_patch_lines >= 60
        or fail_to_pass_count >= 6
        or pass_to_pass_count >= 100
    ):
        return "broader"
    if gold_patch_lines <= 20 and tests <= 30 and problem_statement_chars < 2500:
        return "localized"
    return "moderate"


def instance_ids_sha256(instance_ids: list[str]) -> str:
    body = "\n".join(sorted(instance_ids)).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def load_manifest(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    instances = data.get("instances")
    if not isinstance(instances, list):
        raise ValueError(f"{path} is missing instances")
    if not 20 <= len(instances) <= 30:
        raise ValueError(f"{path} must list 20 to 30 instances, found {len(instances)}")
    if data.get("instance_count") != len(instances):
        raise ValueError(f"{path} instance_count does not match the instance list")
    seen: set[str] = set()
    for item in instances:
        instance_id = item.get("instance_id")
        if not isinstance(instance_id, str) or not INSTANCE_ID.match(instance_id):
            raise ValueError(f"invalid instance_id: {instance_id!r}")
        if instance_id in seen:
            raise ValueError(f"duplicate instance_id: {instance_id}")
        seen.add(instance_id)
        if not isinstance(item.get("repo"), str) or "/" not in item["repo"]:
            raise ValueError(f"{instance_id} is missing repo")
        if not isinstance(item.get("base_commit"), str) or not COMMIT.match(item["base_commit"]):
            raise ValueError(f"{instance_id} is missing a 40-character base_commit")
        for key in (
            "fail_to_pass_count",
            "pass_to_pass_count",
            "gold_patch_lines",
            "problem_statement_chars",
        ):
            if not isinstance(item.get(key), int) or item[key] < 0:
                raise ValueError(f"{instance_id} field {key} must be a non-negative integer")
        expected = difficulty_heuristic(
            gold_patch_lines=item["gold_patch_lines"],
            fail_to_pass_count=item["fail_to_pass_count"],
            pass_to_pass_count=item["pass_to_pass_count"],
            problem_statement_chars=item["problem_statement_chars"],
        )
        if item.get("difficulty_heuristic") != expected:
            raise ValueError(
                f"{instance_id} difficulty_heuristic is {item.get('difficulty_heuristic')}, "
                f"expected {expected}"
            )
        if "problem_statement" in item or "patch" in item or "test_patch" in item:
            raise ValueError(f"{instance_id} vendors dataset text; store ids only")
    digest = instance_ids_sha256([item["instance_id"] for item in instances])
    if data.get("instance_ids_sha256") != digest:
        raise ValueError("instance_ids_sha256 does not match the instance list")
    if data.get("dataset") != "princeton-nlp/SWE-bench_Lite":
        raise ValueError("manifest dataset must be princeton-nlp/SWE-bench_Lite")
    if data.get("split") != "test":
        raise ValueError("manifest split must be test")
    return data


def default_manifest_path() -> Path:
    return Path(__file__).resolve().parents[1] / "manifest" / "swebench_lite_subset.json"
