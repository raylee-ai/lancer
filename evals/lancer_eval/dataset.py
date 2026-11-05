"""Load task specs from the manifest, Hugging Face, or a custom task file."""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path

from lancer_eval.diffutil import files_in_diff
from lancer_eval.manifest import load_manifest
from lancer_eval.types import InstanceSpec


def _as_list(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return [str(item) for item in parsed]
    raise ValueError(f"expected a list, got {type(value).__name__}")


def spec_from_mapping(raw: dict, *, swebench: bool) -> InstanceSpec:
    instance_id = str(raw["instance_id"])
    gold_patch = raw.get("patch") or raw.get("gold_patch") or ""
    gold_files = _as_list(raw.get("gold_files")) if raw.get("gold_files") is not None else []
    if not gold_files and isinstance(gold_patch, str) and gold_patch.strip():
        gold_files = files_in_diff(gold_patch)
    statement = raw.get("problem_statement")
    if not isinstance(statement, str) or not statement.strip():
        raise ValueError(f"{instance_id} is missing problem_statement")
    base_commit = raw.get("base_commit")
    if not isinstance(base_commit, str) or not base_commit:
        raise ValueError(f"{instance_id} is missing base_commit")
    return InstanceSpec(
        instance_id=instance_id,
        repo=str(raw.get("repo") or ""),
        base_commit=base_commit,
        problem_statement=statement,
        repo_url=raw.get("repo_url"),
        version=None if raw.get("version") is None else str(raw.get("version")),
        fail_to_pass=_as_list(raw.get("FAIL_TO_PASS") or raw.get("fail_to_pass")),
        pass_to_pass=_as_list(raw.get("PASS_TO_PASS") or raw.get("pass_to_pass")),
        gold_files=gold_files,
        test_command=raw.get("test_command"),
        hints_text=str(raw.get("hints_text") or ""),
        swebench=swebench,
    )


def load_task_set(path: Path) -> list[InstanceSpec]:
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = data.get("tasks", data.get("instances"))
    if not isinstance(rows, list) or not rows:
        raise ValueError(f"{path} must contain a non-empty tasks list")
    return [spec_from_mapping(row, swebench=bool(row.get("swebench"))) for row in rows]


def filter_tasks(
    tasks: list[InstanceSpec],
    *,
    instance_ids: list[str] | None,
    limit: int | None,
) -> list[InstanceSpec]:
    selected = tasks
    if instance_ids:
        wanted = set(instance_ids)
        missing = wanted - {task.instance_id for task in tasks}
        if missing:
            raise ValueError(f"unknown instance ids: {', '.join(sorted(missing))}")
        selected = [task for task in tasks if task.instance_id in wanted]
    if limit is not None:
        if limit < 1:
            raise ValueError("--limit must be >= 1")
        selected = selected[:limit]
    if not selected:
        raise ValueError("no instances selected")
    return selected


def fetch_swebench_instances(
    manifest_path: Path,
    *,
    instance_ids: list[str] | None = None,
    limit: int | None = None,
) -> list[InstanceSpec]:
    """Download the public split and keep only the manifest ids.

    The datasets library caches the parquet under the Hugging Face cache. The
    problem statements are not written back into the repository.
    """

    manifest = load_manifest(manifest_path)
    try:
        from datasets import load_dataset
    except ImportError as exc:
        raise RuntimeError(
            "The datasets package is required to fetch SWE-bench Lite. "
            "Install evals/requirements.txt and retry."
        ) from exc
    dataset_name = manifest.get("huggingface_id") or manifest["dataset"]
    split = manifest["split"]
    loaded = load_dataset(dataset_name, split=split)
    wanted = {item["instance_id"]: item for item in manifest["instances"]}
    if instance_ids:
        unknown = set(instance_ids) - set(wanted)
        if unknown:
            raise ValueError(
                "instance ids are not in the manifest: " + ", ".join(sorted(unknown))
            )
        wanted = {key: wanted[key] for key in instance_ids}
    found: dict[str, InstanceSpec] = {}
    warnings: list[str] = []
    for row in _rows(loaded):
        instance_id = row.get("instance_id")
        if instance_id not in wanted:
            continue
        spec = spec_from_mapping(dict(row), swebench=True)
        meta = wanted[instance_id]
        if spec.base_commit != meta["base_commit"]:
            warnings.append(
                f"{instance_id} base_commit differs from the manifest "
                f"({meta['base_commit']}); using the dataset value {spec.base_commit}"
            )
        found[instance_id] = spec
    missing = [key for key in wanted if key not in found]
    if missing:
        raise RuntimeError("dataset is missing manifest ids: " + ", ".join(missing))
    ordered = [found[item["instance_id"]] for item in manifest["instances"] if item["instance_id"] in found]
    if warnings:
        for warning in warnings:
            print(f"lancer-eval: {warning}")
    return filter_tasks(ordered, instance_ids=None, limit=limit)


def _rows(loaded: object) -> Iterable[dict]:
    if hasattr(loaded, "__iter__"):
        return loaded  # type: ignore[return-value]
    raise RuntimeError("unexpected dataset object from datasets.load_dataset")
