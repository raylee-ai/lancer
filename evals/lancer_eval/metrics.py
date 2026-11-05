"""Aggregate per-adapter metrics. Missing measurements stay null."""

from __future__ import annotations

import statistics


def _mean(values: list[float]) -> float | None:
    if not values:
        return None
    return statistics.fmean(values)


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    return statistics.median(values)


def _sum(values: list[float]) -> float | None:
    if not values:
        return None
    return float(sum(values))


def _rate(numerator: int, denominator: int) -> float | None:
    if denominator == 0:
        return None
    return numerator / denominator


def summarize_adapter(name: str, records: list[dict]) -> dict:
    graded = [record for record in records if record.get("resolved") is not None]
    resolved = sum(1 for record in graded if record["resolved"] is True)
    applies = sum(1 for record in records if record.get("patch_applies") is True)
    walls = [float(record["wall_time_seconds"]) for record in records if record.get("wall_time_seconds") is not None]
    input_tokens = [
        int(record["input_tokens"]) for record in records if record.get("input_tokens") is not None
    ]
    output_tokens = [
        int(record["output_tokens"]) for record in records if record.get("output_tokens") is not None
    ]
    costs = [float(record["cost_usd"]) for record in records if record.get("cost_usd") is not None]
    tool_calls = [float(record["tool_calls"]) for record in records if record.get("tool_calls") is not None]
    turns = [float(record["turns"]) for record in records if record.get("turns") is not None]
    buckets: dict[str, int] = {}
    for record in records:
        bucket = record.get("failure_bucket")
        if bucket:
            buckets[bucket] = buckets.get(bucket, 0) + 1
    return {
        "adapter": name,
        "instances": len(records),
        "official_graded": len(graded),
        "resolved": resolved if graded else None,
        "resolve_rate": _rate(resolved, len(graded)),
        "patch_applies": applies,
        "patch_applies_rate": _rate(applies, len(records)),
        "mean_wall_time_seconds": _mean(walls),
        "median_wall_time_seconds": _median(walls),
        "input_tokens": _sum([float(value) for value in input_tokens]),
        "output_tokens": _sum([float(value) for value in output_tokens]),
        "tokens_observed": len(input_tokens),
        "cost_usd": _sum(costs),
        "cost_observed": len(costs),
        "mean_tool_calls": _mean(tool_calls),
        "tool_calls_observed": len(tool_calls),
        "mean_turns": _mean(turns),
        "turns_observed": len(turns),
        "failure_buckets": buckets,
    }
