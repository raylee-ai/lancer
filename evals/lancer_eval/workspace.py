"""Prepare a clean git checkout and collect the agent's patch."""

from __future__ import annotations

from pathlib import Path

from lancer_eval.process import git_env, run_process
from lancer_eval.types import InstanceSpec


class WorkspaceError(RuntimeError):
    pass


def _git(args: list[str], *, cwd: Path | None = None, timeout: float) -> str:
    result = run_process(["git", *args], cwd=cwd, env=git_env(), timeout=timeout)
    if result.timed_out:
        raise WorkspaceError(f"git {' '.join(args)} timed out")
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise WorkspaceError(detail or f"git {' '.join(args)} failed")
    return result.stdout


def _local_url(url: str) -> bool:
    if url.startswith(("/", "file:")):
        return True
    return Path(url).exists()


def prepare_workspace(task: InstanceSpec, dest: Path, *, timeout: float) -> Path:
    if dest.exists():
        raise WorkspaceError(f"workspace already exists: {dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    url = task.clone_url()
    clone = ["clone", "--no-checkout", url, str(dest)]
    if not _local_url(url):
        clone = ["clone", "--filter=blob:none", "--no-checkout", url, str(dest)]
    _git(clone, timeout=timeout)
    _git(["checkout", "--force", task.base_commit], cwd=dest, timeout=timeout)
    return dest


def collect_patch(repo: Path, base_commit: str, *, timeout: float = 60) -> str:
    """Return uncommitted and committed edits relative to the base commit."""

    _git(["add", "-A"], cwd=repo, timeout=timeout)
    patch = _git(["diff", "--cached", base_commit], cwd=repo, timeout=timeout)
    _git(["reset", "-q"], cwd=repo, timeout=timeout)
    if patch and not patch.endswith("\n"):
        patch += "\n"
    return patch


def patch_applies(repo: Path, base_commit: str, patch: str, *, timeout: float = 120) -> tuple[bool, str]:
    """Check the patch against a clean clone so a dirty worktree cannot hide a failure."""

    if not patch.strip():
        return False, "empty patch"
    parent = repo.parent
    scratch = parent / f".apply-check-{repo.name}"
    if scratch.exists():
        raise WorkspaceError(f"apply-check directory already exists: {scratch}")
    try:
        _git(["clone", "--no-checkout", str(repo), str(scratch)], timeout=timeout)
        _git(["checkout", "--force", base_commit], cwd=scratch, timeout=timeout)
        result = run_process(
            ["git", "apply", "--check", "--whitespace=nowarn", "-"],
            cwd=scratch,
            env=git_env(),
            timeout=timeout,
            stdin=patch,
        )
        if result.timed_out:
            return False, "git apply --check timed out"
        detail = (result.stderr or result.stdout).strip()
        return result.returncode == 0, detail
    finally:
        if scratch.exists():
            # A failed checkout can leave a partial clone. Remove only this scratch dir.
            import shutil

            shutil.rmtree(scratch, ignore_errors=True)
