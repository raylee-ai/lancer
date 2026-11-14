import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  createSessionWorktree,
  inspectGitRepository,
  mergeSessionWorktree,
  readSessionWorktreeDiff,
  removeSessionWorktree,
  sessionBranchName,
  worktreeListShowsLocked,
} from "../../electron/platform/worktrees/session-worktree";
import {
  reserveWorktreeExecution,
  reserveWorktreeMutation,
} from "../../electron/platform/worktrees/session-worktree-lease";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });
  return stdout.toString().trim();
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lancer-session-worktree-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "seed.txt"), "seed\n");
  await git(repo, "add", "seed.txt");
  await git(repo, "commit", "-qm", "seed");
  return repo;
}

test("non-git directories do not create a worktree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lancer-not-git-"));
  expect(await inspectGitRepository(dir)).toBeUndefined();
  expect(await createSessionWorktree(dir, "session-a")).toBeUndefined();
});

test("each session gets an isolated worktree and branch under the repository", async () => {
  const repo = await makeRepo();
  const first = await createSessionWorktree(repo, "session-a");
  const second = await createSessionWorktree(repo, "session-b");
  expect(first?.branch).toBe(sessionBranchName("session-a"));
  expect(second?.branch).toBe("lancer/session-b");
  expect(first?.baseBranch).toBe("main");
  assertExists(first);
  assertExists(second);

  await writeFile(join(first.path, "from-a.txt"), "a\n");
  await writeFile(join(second.path, "from-b.txt"), "b\n");

  expect(await git(repo, "status", "--porcelain")).toBe("");
  expect(await git(first.path, "status", "--porcelain")).toContain("from-a.txt");
  expect(await git(first.path, "status", "--porcelain")).not.toContain("from-b.txt");
  expect(await git(second.path, "status", "--porcelain")).toContain("from-b.txt");
  expect(await git(repo, "branch", "--list", "lancer/session-a")).toContain("lancer/session-a");

  const diff = await readSessionWorktreeDiff(first);
  expect(diff.patch).toContain("from-a.txt");
  expect(diff.patch).not.toContain("from-b.txt");
  expect(diff.truncated).toBe(false);
});

test("merge commits the worktree and updates the base branch only after a clean checkout", async () => {
  const repo = await makeRepo();
  const binding = await createSessionWorktree(repo, "merge-me");
  assertExists(binding);
  await writeFile(join(binding.path, "landed.txt"), "landed\n");

  await writeFile(join(repo, "dirty.txt"), "dirty\n");
  await expect(mergeSessionWorktree(binding)).rejects.toThrow(/uncommitted changes/);
  expect(await git(repo, "status", "--porcelain")).toContain("dirty.txt");
  expect(await git(repo, "log", "-1", "--format=%s")).toBe("seed");
  await rm(join(repo, "dirty.txt"));

  const mergedInto = await mergeSessionWorktree(binding);
  expect(mergedInto).toBe("main");
  expect(await readFile(join(repo, "landed.txt"), "utf8")).toBe("landed\n");
  expect(await git(repo, "log", "-1", "--format=%s")).toContain("lancer/merge-me");
  expect(await git(repo, "status", "--porcelain")).toBe("");
});

test("a merge conflict restores the workspace checkout", async () => {
  const repo = await makeRepo();
  const binding = await createSessionWorktree(repo, "conflict");
  assertExists(binding);
  await writeFile(join(repo, "shared.txt"), "main\n");
  await git(repo, "add", "shared.txt");
  await git(repo, "commit", "-qm", "main edit");
  await writeFile(join(binding.path, "shared.txt"), "session\n");
  const before = await git(repo, "rev-parse", "HEAD");
  await expect(mergeSessionWorktree(binding)).rejects.toThrow(/failed/);
  expect(await git(repo, "rev-parse", "HEAD")).toBe(before);
  expect(await git(repo, "status", "--porcelain")).toBe("");
  expect(await readFile(join(repo, "shared.txt"), "utf8")).toBe("main\n");
});

test("a failed merge restores the branch the workspace was on", async () => {
  const repo = await makeRepo();
  const binding = await createSessionWorktree(repo, "restore-branch");
  assertExists(binding);
  await writeFile(join(repo, "shared.txt"), "main\n");
  await git(repo, "add", "shared.txt");
  await git(repo, "commit", "-qm", "main edit");
  await git(repo, "checkout", "-q", "-b", "side");
  await writeFile(join(repo, "side-only.txt"), "side\n");
  await git(repo, "add", "side-only.txt");
  await git(repo, "commit", "-qm", "side edit");
  await writeFile(join(binding.path, "shared.txt"), "session\n");
  const side = await git(repo, "rev-parse", "HEAD");

  await expect(mergeSessionWorktree(binding)).rejects.toThrow(/failed/);

  expect(await git(repo, "branch", "--show-current")).toBe("side");
  expect(await git(repo, "rev-parse", "HEAD")).toBe(side);
  expect(await readFile(join(repo, "shared.txt"), "utf8")).toBe("main\n");
  expect(await readFile(join(repo, "side-only.txt"), "utf8")).toBe("side\n");
  expect(await git(repo, "status", "--porcelain")).toBe("");
  expect(await readFile(join(binding.path, "shared.txt"), "utf8")).toBe("session\n");
});

test("a dirty workspace on another branch is not checked out", async () => {
  const repo = await makeRepo();
  const binding = await createSessionWorktree(repo, "stay-put");
  assertExists(binding);
  await git(repo, "checkout", "-q", "-b", "side");
  await writeFile(join(repo, "dirty.txt"), "dirty\n");
  await writeFile(join(binding.path, "landed.txt"), "landed\n");

  await expect(mergeSessionWorktree(binding)).rejects.toThrow(/uncommitted changes/);

  expect(await git(repo, "branch", "--show-current")).toBe("side");
  expect(await readFile(join(repo, "dirty.txt"), "utf8")).toBe("dirty\n");
  expect(await git(repo, "log", "-1", "--format=%s")).toBe("seed");
  await expect(readFile(join(repo, "landed.txt"), "utf8")).rejects.toThrow();
});

test("discard refuses a locked worktree instead of forcing it", async () => {
  const repo = await makeRepo();
  const binding = await createSessionWorktree(repo, "locked");
  assertExists(binding);
  await git(repo, "worktree", "lock", binding.path);
  const listed = await git(repo, "worktree", "list", "--porcelain");
  expect(worktreeListShowsLocked(listed, binding.path)).toBe(true);

  await expect(removeSessionWorktree(binding)).rejects.toThrow(/locked/);

  expect(await readFile(join(binding.path, "seed.txt"), "utf8")).toBe("seed\n");
  expect(await git(repo, "branch", "--list", "lancer/locked")).toContain("lancer/locked");
  expect(await git(repo, "status", "--porcelain")).toBe("");
});

test("worktree leases exclude merge from a checkout that is still being claimed", () => {
  const path = join(tmpdir(), `lancer-lease-${Date.now()}`);
  const releaseExecution = reserveWorktreeExecution(path);
  const shared = reserveWorktreeExecution(path);
  expect(() => reserveWorktreeMutation(path)).toThrow(/still starting/);
  releaseExecution();
  expect(() => reserveWorktreeMutation(path)).toThrow(/still starting/);
  shared();
  const releaseMutation = reserveWorktreeMutation(path);
  expect(() => reserveWorktreeExecution(path)).toThrow(/merged or discarded/);
  expect(() => reserveWorktreeMutation(path)).toThrow(/already/);
  releaseMutation();
  const released = reserveWorktreeMutation(path);
  released();
});

test("discard removes the worktree and its branch", async () => {
  const repo = await makeRepo();
  const binding = await createSessionWorktree(repo, "drop-me");
  assertExists(binding);
  await writeFile(join(binding.path, "temp.txt"), "temp\n");
  await removeSessionWorktree(binding);
  await expect(readFile(join(binding.path, "temp.txt"), "utf8")).rejects.toThrow();
  expect(await git(repo, "branch", "--list", "lancer/drop-me")).toBe("");
  expect(await git(repo, "status", "--porcelain")).toBe("");
});

function assertExists<T>(value: T | undefined): asserts value is T {
  expect(value).toBeTruthy();
}
