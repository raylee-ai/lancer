import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DIFF_LIMIT_CHARS = 1024 * 1024;

/**
 * Per-session worktrees live under the repository's common Git directory.
 * That path is part of the repo, stays out of `git status`, and is outside
 * every session's working files, so parallel sessions do not see each other.
 */
const WORKTREE_DIRNAME = "lancer-worktrees";

export interface GitRepoInspection {
  readonly repoRoot: string;
  readonly commonDir: string;
  readonly branch: string;
  readonly headSha: string;
}

export interface SessionWorktreeBinding {
  readonly path: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly repoRoot: string;
  readonly commonDir: string;
}

export interface SessionWorktreeDiffText {
  readonly stat: string;
  readonly patch: string;
  readonly truncated: boolean;
}

const repoQueues = new Map<string, Promise<unknown>>();

function scrubGitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_PREFIX",
    "GIT_COMMON_DIR",
  ]) {
    delete env[key];
  }
  return env;
}

async function runGit(
  cwd: string,
  args: readonly string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      env: scrubGitEnv(extraEnv),
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.toString().trim();
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "").trim()
        : "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(stderr || message);
  }
}

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoQueues.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  repoQueues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** Branch component safe to pass as a Git ref and as a directory name. */
export function sessionWorktreeSlug(sessionId: string): string {
  const slug = sessionId
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
  if (!slug || slug === "." || slug === ".." || slug.includes("..")) {
    throw new Error("Session id cannot name a worktree.");
  }
  return slug;
}

export function sessionBranchName(sessionId: string): string {
  return `lancer/${sessionWorktreeSlug(sessionId)}`;
}

export function sessionWorktreePath(commonDir: string, sessionId: string): string {
  return join(commonDir, WORKTREE_DIRNAME, sessionWorktreeSlug(sessionId));
}

export function assertSafeBranchName(name: string): void {
  if (
    !/^[A-Za-z0-9._/-]+$/.test(name) ||
    name.startsWith("-") ||
    name.includes("..") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".lock")
  ) {
    throw new Error(`Refusing unsafe branch name: ${name}`);
  }
}

export function assertManagedWorktreePath(commonDir: string, worktreePath: string): void {
  const root = resolve(commonDir, WORKTREE_DIRNAME);
  const rel = relative(root, resolve(worktreePath));
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rel)
  ) {
    throw new Error("Refusing to touch a worktree outside Lancer's session worktree directory.");
  }
}

export async function inspectGitRepository(
  startPath: string,
): Promise<GitRepoInspection | undefined> {
  let inside: string;
  try {
    inside = await runGit(startPath, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return undefined;
  }
  if (inside !== "true") return undefined;
  const repoRoot = await runGit(startPath, ["rev-parse", "--show-toplevel"]);
  const commonRaw = await runGit(startPath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const commonDir = resolve(repoRoot, commonRaw);
  const branch = await runGit(startPath, ["branch", "--show-current"]).catch(() => "");
  const headSha = await runGit(startPath, ["rev-parse", "HEAD"]);
  return { repoRoot, commonDir, branch, headSha };
}

/**
 * Create `lancer/<session-id>` and a linked worktree for it.
 * Returns undefined when `startPath` is not inside a Git repository.
 */
export async function createSessionWorktree(
  startPath: string,
  sessionId: string,
): Promise<SessionWorktreeBinding | undefined> {
  const repo = await inspectGitRepository(startPath);
  if (!repo) return undefined;
  const branch = sessionBranchName(sessionId);
  assertSafeBranchName(branch);
  const path = sessionWorktreePath(repo.commonDir, sessionId);
  return serialize(repo.commonDir, async () => {
    await mkdir(dirname(path), { recursive: true });
    await runGit(repo.repoRoot, ["worktree", "add", "-b", branch, path, "HEAD"]);
    return {
      path,
      branch,
      baseBranch: repo.branch,
      baseSha: repo.headSha,
      repoRoot: repo.repoRoot,
      commonDir: repo.commonDir,
    };
  });
}

export async function readSessionWorktreeDiff(
  binding: SessionWorktreeBinding,
): Promise<SessionWorktreeDiffText> {
  assertSafeBranchName(binding.branch);
  if (!/^[0-9a-f]{7,64}$/i.test(binding.baseSha)) {
    throw new Error("Session worktree is missing a base commit.");
  }
  assertManagedWorktreePath(binding.commonDir, binding.path);
  const indexFile = join(tmpdir(), `lancer-session-diff-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await runGit(binding.path, ["read-tree", binding.baseSha], env);
    await runGit(binding.path, ["add", "-A"], env);
    const stat = await runGit(binding.path, ["diff", "--cached", "--stat", binding.baseSha], env);
    const raw = await runGit(binding.path, ["diff", "--cached", binding.baseSha], env);
    const truncated = raw.length > DIFF_LIMIT_CHARS;
    return {
      stat,
      patch: truncated ? `${raw.slice(0, DIFF_LIMIT_CHARS)}\n` : raw,
      truncated,
    };
  } finally {
    await rm(indexFile, { force: true });
  }
}

/**
 * Commit any session-worktree edits onto its branch, then merge that branch
 * into the branch the workspace was on when the worktree was created.
 * A dirty workspace checkout or a conflict aborts without leaving a merge in
 * progress. If the workspace was on another branch, a failed merge checks that
 * branch back out. Checkout never uses `--force`, so user changes are not
 * overwritten to make the merge fit.
 */
export async function mergeSessionWorktree(binding: SessionWorktreeBinding): Promise<string> {
  assertSafeBranchName(binding.branch);
  if (binding.baseBranch) assertSafeBranchName(binding.baseBranch);
  assertManagedWorktreePath(binding.commonDir, binding.path);
  return serialize(binding.commonDir, async () => {
    await assertWorkspaceCheckoutClean(binding.repoRoot);
    const worktreeStatus = await runGit(binding.path, ["status", "--porcelain"]);
    if (worktreeStatus) {
      await runGit(binding.path, ["add", "-A"]);
      await runGit(binding.path, ["commit", "-m", `lancer: apply ${binding.branch}`]);
    }
    const target =
      binding.baseBranch || (await runGit(binding.repoRoot, ["branch", "--show-current"]));
    if (!target) {
      throw new Error(
        "The workspace has no branch checked out. Check out the branch you want to merge into.",
      );
    }
    assertSafeBranchName(target);
    // Re-read immediately before touching the workspace. The earlier check can
    // go stale while the session branch is being committed.
    await assertWorkspaceCheckoutClean(binding.repoRoot);
    const previousBranch = await runGit(binding.repoRoot, ["branch", "--show-current"]);
    const previousHead = await runGit(binding.repoRoot, ["rev-parse", "HEAD"]);
    let switched = false;
    try {
      if (previousBranch !== target) {
        await runGit(binding.repoRoot, ["checkout", target]);
        switched = true;
      }
      await runGit(binding.repoRoot, ["merge", "--no-edit", binding.branch]);
    } catch (error) {
      await runGit(binding.repoRoot, ["merge", "--abort"]).catch(() => undefined);
      if (switched) {
        const restore = previousBranch || previousHead;
        if (restore) {
          await runGit(binding.repoRoot, ["checkout", restore]).catch(() => undefined);
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Merge of ${binding.branch} into ${target} failed. The workspace checkout was restored. ${message}`,
      );
    }
    return target;
  });
}

async function assertWorkspaceCheckoutClean(repoRoot: string): Promise<void> {
  const workspaceStatus = await runGit(repoRoot, ["status", "--porcelain"]);
  if (workspaceStatus) {
    throw new Error(
      "The workspace checkout has uncommitted changes. Commit or stash them before merging this session.",
    );
  }
}

/** True when `git worktree list --porcelain` marks this path as locked. */
export function worktreeListShowsLocked(porcelain: string, worktreePath: string): boolean {
  let currentPath = "";
  let locked = false;
  const matches = () => currentPath === worktreePath && locked;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (matches()) return true;
      currentPath = line.slice("worktree ".length);
      locked = false;
      continue;
    }
    if (line === "locked" || line.startsWith("locked ")) locked = true;
  }
  return matches();
}

export async function removeSessionWorktree(binding: SessionWorktreeBinding): Promise<void> {
  assertSafeBranchName(binding.branch);
  if (!binding.branch.startsWith("lancer/")) {
    throw new Error("Refusing to delete a branch that Lancer did not create for this session.");
  }
  assertManagedWorktreePath(binding.commonDir, binding.path);
  await serialize(binding.commonDir, async () => {
    const listedBefore = await runGit(binding.repoRoot, ["worktree", "list", "--porcelain"]).catch(
      () => "",
    );
    // One `--force` removes an idle dirty checkout. A second `--force` would
    // also remove a locked worktree, which can still be in use outside this
    // session. Refuse the locked case instead of escalating.
    if (worktreeListShowsLocked(listedBefore, binding.path)) {
      throw new Error("This worktree is locked. Unlock it before discarding.");
    }
    try {
      await runGit(binding.repoRoot, ["worktree", "remove", "--force", binding.path]);
    } catch (error) {
      const listed = await runGit(binding.repoRoot, ["worktree", "list", "--porcelain"]).catch(
        () => "",
      );
      if (listed.split("\n").some((line) => line === `worktree ${binding.path}`)) {
        throw error;
      }
    }
    await runGit(binding.repoRoot, ["worktree", "prune"]).catch(() => undefined);
    try {
      await runGit(binding.repoRoot, ["branch", "-D", binding.branch]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found/i.test(message)) throw error;
    }
  });
}
