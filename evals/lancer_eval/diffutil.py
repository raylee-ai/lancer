"""Unified-diff helpers. Gold patches are never treated as agent output."""

from __future__ import annotations

import hashlib
import re

_DIFF_GIT = re.compile(r"^diff --git a/(.+?) b/(.+)$", re.MULTILINE)
_FENCE = re.compile(r"```(?:diff|patch)?[^\n]*\n(.*?)```", re.DOTALL)


def files_in_diff(patch: str) -> list[str]:
    files: list[str] = []
    for match in _DIFF_GIT.finditer(patch or ""):
        path = match.group(2).strip().strip('"')
        if path in {"/dev/null", "dev/null"}:
            path = match.group(1).strip().strip('"')
        if path in {"/dev/null", "dev/null"} or path in files:
            continue
        files.append(path)
    return files


def extract_unified_diff(text: str) -> str:
    """Pull a unified diff out of an agent transcript, if one is present."""

    if not text:
        return ""
    stripped = text.strip()
    if stripped.startswith("diff --git "):
        return stripped if stripped.endswith("\n") else stripped + "\n"
    for block in _FENCE.findall(text):
        chunk = block.strip()
        start = chunk.find("diff --git ")
        if start != -1:
            body = chunk[start:]
            return body if body.endswith("\n") else body + "\n"
    start = text.find("diff --git ")
    if start == -1:
        return ""
    body = text[start:].strip()
    return body if body.endswith("\n") else body + "\n"


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def redact(text: str, secrets: list[str]) -> str:
    redacted = text
    for secret in secrets:
        if secret and len(secret) >= 8:
            redacted = redacted.replace(secret, "[REDACTED]")
    return redacted


def secret_values(env: dict[str, str]) -> list[str]:
    names = (
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CODEX_API_KEY",
        "LANCER_EVAL_JUDGE_API_KEY",
    )
    return [env[name] for name in names if env.get(name)]
