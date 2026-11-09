import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  readFile,
  rename,
  rmdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DIFF_LIMIT_BYTES = 1024 * 1024;

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

export interface SessionWorktreeCompletion {
  readonly branch: string;
  readonly baseSha: string;
  readonly completedSha: string;
  readonly files: readonly string[];
  readonly stat: string;
  readonly patch: string;
  readonly truncated: boolean;
}

export interface SessionWorktreePatchResult {
  readonly applied: boolean;
  readonly conflicts: readonly string[];
}

const repoQueues = new Map<string, Promise<unknown>>();

function scrubGitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_PREFIX",
    "GIT_COMMON_DIR",
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
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

async function runGitRaw(
  cwd: string,
  args: readonly string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      env: scrubGitEnv(extraEnv),
      maxBuffer: 128 * 1024 * 1024,
      timeout: 120_000,
      encoding: "buffer",
    });
    return stdout.toString();
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
  startPoint = "HEAD",
): Promise<SessionWorktreeBinding | undefined> {
  const repo = await inspectGitRepository(startPath);
  if (!repo) return undefined;
  const branch = sessionBranchName(sessionId);
  assertSafeBranchName(branch);
  const path = sessionWorktreePath(repo.commonDir, sessionId);
  return serialize(repo.commonDir, async () => {
    await mkdir(dirname(path), { recursive: true });
    await runGit(repo.repoRoot, ["worktree", "add", "-b", branch, path, startPoint]);
    return {
      path,
      branch,
      baseBranch: repo.branch,
      baseSha: await runGit(path, ["rev-parse", "HEAD"]),
      repoRoot: repo.repoRoot,
      commonDir: repo.commonDir,
    };
  });
}

/**
 * Capture the visible working tree without touching its real index or branch.
 * Git's own add honors ignore rules, so ignored dependencies and secrets stay out.
 */
export async function snapshotSessionWorktree(startPath: string): Promise<{
  readonly repo: GitRepoInspection;
  readonly baseSha: string;
}> {
  const repo = await inspectGitRepository(startPath);
  if (!repo) throw new Error("Cannot snapshot a directory outside a Git worktree.");
  const indexFile = join(tmpdir(), `lancer-session-snapshot-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await runGit(startPath, ["read-tree", "HEAD"], env);
    await runGit(startPath, ["add", "-A"], env);
    const tree = await runGit(startPath, ["write-tree"], env);
    const headTree = await runGit(startPath, ["rev-parse", "HEAD^{tree}"]);
    if (tree === headTree) return { repo, baseSha: repo.headSha };
    const baseSha = await createCommit(
      repo.repoRoot,
      [repo.headSha],
      tree,
      "lancer: parent snapshot",
    );
    return { repo, baseSha };
  } finally {
    await rm(indexFile, { force: true });
    await rm(`${indexFile}.lock`, { force: true });
  }
}

/** Commit the current worktree tree onto its managed session branch. */
export async function commitSessionWorktree(binding: SessionWorktreeBinding): Promise<string> {
  assertWorktreeBinding(binding);
  return serialize(binding.commonDir, async () => {
    const currentBranch = await runGit(binding.path, ["symbolic-ref", "--short", "HEAD"]);
    if (currentBranch !== binding.branch) {
      throw new Error("The session worktree is no longer on its managed branch.");
    }
    const currentHead = await runGit(binding.path, ["rev-parse", "HEAD"]);
    const snapshot = await snapshotSessionWorktree(binding.path);
    if (snapshot.baseSha === currentHead) return currentHead;
    await runGit(binding.repoRoot, [
      "update-ref",
      `refs/heads/${binding.branch}`,
      snapshot.baseSha,
      currentHead,
    ]);
    await runGit(binding.path, ["reset", "-q"]);
    return snapshot.baseSha;
  });
}

/** Check the worktree tree without consulting or modifying its real index. */
export async function sessionWorktreeMatchesCommit(
  binding: SessionWorktreeBinding,
  commitSha: string,
): Promise<boolean> {
  assertWorktreeBinding(binding);
  if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) {
    throw new Error("A full completion commit id is required.");
  }
  const tempRoot = await mkdtemp(join(tmpdir(), "lancer-worktree-check-"));
  const indexFile = join(tempRoot, "index");
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await runGit(binding.repoRoot, ["cat-file", "-e", `${commitSha}^{commit}`]);
    const [worktreeTree, commitTree] = await Promise.all([
      (async () => {
        await runGit(binding.path, ["read-tree", "HEAD"], env);
        await runGit(binding.path, ["add", "-A"], env);
        return runGit(binding.path, ["write-tree"], env);
      })(),
      runGit(binding.repoRoot, ["rev-parse", `${commitSha}^{tree}`]),
    ]);
    return worktreeTree === commitTree;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/** Read an immutable diff for a previously recorded completion commit. */
export async function readSessionWorktreeCompletion(
  binding: SessionWorktreeBinding,
  completedSha: string,
): Promise<SessionWorktreeCompletion> {
  assertWorktreeBinding(binding);
  if (!/^[0-9a-f]{40,64}$/i.test(completedSha)) {
    throw new Error("A full completion commit id is required.");
  }
  await runGit(binding.repoRoot, ["cat-file", "-e", `${completedSha}^{commit}`]);
  await runGit(binding.repoRoot, ["merge-base", "--is-ancestor", binding.baseSha, completedSha]);
  const [stat, patch, rawFiles] = await Promise.all([
    runGit(binding.repoRoot, ["diff", "--stat", binding.baseSha, completedSha]),
    runGitRaw(binding.repoRoot, ["diff", "--binary", binding.baseSha, completedSha]),
    runGitRaw(binding.repoRoot, ["diff", "--name-only", "-z", binding.baseSha, completedSha]),
  ]);
  const limitedPatch = limitDiff(patch);
  return {
    branch: binding.branch,
    baseSha: binding.baseSha,
    completedSha,
    files: rawFiles.split("\0").filter(Boolean),
    stat,
    patch: limitedPatch.patch,
    truncated: limitedPatch.truncated,
  };
}

/**
 * Apply the exact base-to-completion patch to a possibly dirty parent checkout.
 * A temporary index performs three-way conflict detection before any parent file
 * is touched. The real index is never changed.
 */
export async function applySessionWorktreeCompletion(
  binding: SessionWorktreeBinding,
  completedSha: string,
  targetPath: string,
): Promise<SessionWorktreePatchResult> {
  assertWorktreeBinding(binding);
  if (!/^[0-9a-f]{40,64}$/i.test(completedSha)) {
    throw new Error("A full completion commit id is required.");
  }
  await runGit(binding.repoRoot, ["cat-file", "-e", `${completedSha}^{commit}`]);
  await runGit(binding.repoRoot, ["merge-base", "--is-ancestor", binding.baseSha, completedSha]);

  const repo = await inspectGitRepository(targetPath);
  if (!repo || repo.commonDir !== binding.commonDir) {
    throw new Error("The parent session checkout is not in the child worktree repository.");
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "lancer-child-merge-"));
  const indexFile = join(tempRoot, "index");
  const patchFile = join(tempRoot, "child.patch");
  const stageDir = join(tempRoot, "stage");
  const backupDir = join(tempRoot, "backup");
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    const patch = await runGitRaw(binding.repoRoot, [
      "diff",
      "--binary",
      binding.baseSha,
      completedSha,
    ]);
    if (!patch) return { applied: true, conflicts: [] };
    await writeFile(patchFile, patch);
    await runGit(targetPath, ["read-tree", "HEAD"], env);
    await runGit(targetPath, ["add", "-A"], env);
    const beforeTree = await runGit(targetPath, ["write-tree"], env);
    try {
      await runGit(targetPath, ["apply", "--cached", "--3way", patchFile], env);
    } catch {
      const conflicted = await runGitRaw(targetPath, ["ls-files", "-u", "-z"], env).catch(() => "");
      const files = parseUnmergedPaths(conflicted);
      const fallback =
        files.length > 0
          ? files
          : (
              await runGitRaw(targetPath, [
                "diff",
                "--name-only",
                "-z",
                binding.baseSha,
                completedSha,
              ])
            )
              .split("\0")
              .filter(Boolean);
      return { applied: false, conflicts: fallback };
    }
    const afterTree = await runGit(targetPath, ["write-tree"], env);
    const changed = (
      await runGitRaw(targetPath, ["diff", "--name-only", "-z", beforeTree, afterTree])
    )
      .split("\0")
      .filter(Boolean);
    if (changed.length === 0) return { applied: true, conflicts: [] };

    await mkdir(stageDir);
    await mkdir(backupDir);
    const present = await gitPathsPresent(targetPath, env, changed);
    if (present.length > 0) {
      await runGit(
        targetPath,
        ["checkout-index", "--force", `--prefix=${stageDir}${sep}`, "--", ...present],
        env,
      );
    }
    const roots = affectedRoots(changed);
    for (const [index, root] of roots.entries()) {
      const source = resolve(targetPath, root);
      await ensureNoSymlinkAncestors(targetPath, source);
      const backup = join(backupDir, String(index));
      try {
        const info = await lstat(source);
        if (info.isDirectory()) return { applied: false, conflicts: [root] };
        await cp(source, backup, { recursive: true, preserveTimestamps: true });
      } catch (error) {
        if (!isMissingPath(error)) throw error;
      }
    }
    const destinationDirs = new Set<string>();
    for (const path of present) {
      const destination = safeWorkspacePath(targetPath, path);
      await ensureNoSymlinkAncestors(targetPath, destination);
      try {
        if ((await lstat(destination)).isDirectory()) {
          return { applied: false, conflicts: [path] };
        }
      } catch (error) {
        if (!isMissingPath(error)) throw error;
      }
      let parent = dirname(destination);
      while (parent !== targetPath && parent.startsWith(`${targetPath}${sep}`)) {
        try {
          await lstat(parent);
          break;
        } catch (error) {
          if (!isMissingPath(error)) throw error;
          destinationDirs.add(relative(targetPath, parent));
          parent = dirname(parent);
        }
      }
    }

    try {
      const deletions = changed
        .filter((path) => !present.includes(path))
        .sort((a, b) => b.split("/").length - a.split("/").length);
      for (const path of deletions) {
        const absolute = safeWorkspacePath(targetPath, path);
        await ensureNoSymlinkAncestors(targetPath, absolute);
        try {
          const info = await lstat(absolute);
          if (info.isDirectory()) throw new Error(`Refusing to delete directory at ${path}.`);
          await unlink(absolute);
        } catch (error) {
          if (!isMissingPath(error)) throw error;
        }
      }
      for (const path of present.sort((a, b) => a.split("/").length - b.split("/").length)) {
        const source = safeWorkspacePath(stageDir, path);
        const destination = safeWorkspacePath(targetPath, path);
        await ensureNoSymlinkAncestors(targetPath, destination);
        await mkdir(dirname(destination), { recursive: true });
        const staged = await lstat(source);
        const temporary = `${destination}.lancer-${randomUUID()}`;
        try {
          if (staged.isSymbolicLink()) {
            await symlink(await readlink(source), temporary);
          } else {
            await cp(source, temporary, { preserveTimestamps: true });
          }
          await rename(temporary, destination);
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      }
    } catch (error) {
      await restoreRoots(targetPath, roots, changed, backupDir, destinationDirs);
      throw error;
    }
    return { applied: true, conflicts: [] };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function assertWorktreeBinding(binding: SessionWorktreeBinding): void {
  assertSafeBranchName(binding.branch);
  if (!binding.branch.startsWith("lancer/")) {
    throw new Error("Refusing to operate on a branch not created by Lancer.");
  }
  if (!/^[0-9a-f]{7,64}$/i.test(binding.baseSha)) {
    throw new Error("Session worktree is missing a base commit.");
  }
  assertManagedWorktreePath(binding.commonDir, binding.path);
}

async function createCommit(
  cwd: string,
  parents: readonly string[],
  tree: string,
  message: string,
): Promise<string> {
  const configuredName = await runGit(cwd, ["config", "--get", "user.name"]).catch(() => "");
  const configuredEmail = await runGit(cwd, ["config", "--get", "user.email"]).catch(() => "");
  const env = {
    GIT_AUTHOR_NAME: configuredName || "Lancer",
    GIT_AUTHOR_EMAIL: configuredEmail || "lancer@localhost",
    GIT_COMMITTER_NAME: configuredName || "Lancer",
    GIT_COMMITTER_EMAIL: configuredEmail || "lancer@localhost",
  };
  return runGit(
    cwd,
    ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message],
    env,
  );
}

async function gitPathsPresent(
  cwd: string,
  env: NodeJS.ProcessEnv,
  paths: readonly string[],
): Promise<string[]> {
  const listed = new Set((await runGitRaw(cwd, ["ls-files", "-z"], env)).split("\0"));
  return paths.filter((path) => listed.has(path));
}

function parseUnmergedPaths(output: string): string[] {
  const paths = new Set<string>();
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab >= 0) paths.add(record.slice(tab + 1));
  }
  return [...paths];
}

function safeWorkspacePath(root: string, relativePath: string): string {
  if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
    throw new Error("Git returned an unsafe path while applying a child diff.");
  }
  const absolute = resolve(root, relativePath);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Git returned a path outside the target checkout.");
  }
  return absolute;
}

async function ensureNoSymlinkAncestors(root: string, absolute: string): Promise<void> {
  const rel = relative(root, absolute);
  const parts = rel.split(sep);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Refusing to apply child changes through a non-directory path: ${part}`);
      }
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  }
}

function affectedRoots(changed: readonly string[]): string[] {
  const sorted = [...new Set(changed)].sort((a, b) => a.length - b.length);
  return sorted.filter(
    (path) => !sorted.some((candidate) => candidate !== path && path.startsWith(`${candidate}/`)),
  );
}

async function restoreRoots(
  targetPath: string,
  roots: readonly string[],
  changed: readonly string[],
  backupDir: string,
  createdDirs: ReadonlySet<string>,
): Promise<void> {
  for (const path of [...changed].sort((a, b) => b.split("/").length - a.split("/").length)) {
    const destination = safeWorkspacePath(targetPath, path);
    try {
      const info = await lstat(destination);
      if (info.isDirectory()) await rmdir(destination);
      else await unlink(destination);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  }
  for (const [index, root] of roots.entries()) {
    const backup = join(backupDir, String(index));
    try {
      await lstat(backup);
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
    const destination = safeWorkspacePath(targetPath, root);
    await mkdir(dirname(destination), { recursive: true });
    await cp(backup, destination, { recursive: true, preserveTimestamps: true });
  }
  for (const dir of [...createdDirs].sort((a, b) => b.split(sep).length - a.split(sep).length)) {
    try {
      await rmdir(safeWorkspacePath(targetPath, dir));
    } catch (error) {
      if (
        !isMissingPath(error) &&
        !(error && typeof error === "object" && "code" in error && error.code === "ENOTEMPTY")
      ) {
        throw error;
      }
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR"),
  );
}

export async function readSessionWorktreeDiff(
  binding: SessionWorktreeBinding,
): Promise<SessionWorktreeDiffText> {
  assertWorktreeBinding(binding);
  const indexFile = join(tmpdir(), `lancer-session-diff-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await runGit(binding.path, ["read-tree", binding.baseSha], env);
    await runGit(binding.path, ["add", "-A"], env);
    const stat = await runGit(binding.path, ["diff", "--cached", "--stat", binding.baseSha], env);
    const raw = await runGit(binding.path, ["diff", "--cached", binding.baseSha], env);
    const limitedPatch = limitDiff(raw);
    return {
      stat,
      patch: limitedPatch.patch,
      truncated: limitedPatch.truncated,
    };
  } finally {
    await rm(indexFile, { force: true });
  }
}

function limitDiff(patch: string): { readonly patch: string; readonly truncated: boolean } {
  const bytes = Buffer.from(patch, "utf8");
  if (bytes.length <= DIFF_LIMIT_BYTES) return { patch, truncated: false };
  let end = DIFF_LIMIT_BYTES - 1;
  while (end > 0) {
    const nextByte = bytes[end];
    if (nextByte === undefined || (nextByte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return {
    patch: `${bytes.subarray(0, end).toString("utf8")}\n`,
    truncated: true,
  };
}

/**
 * Commit any session-worktree edits onto its branch, then merge that branch
 * into the branch the workspace was on when the worktree was created.
 * A dirty workspace checkout or a conflict aborts without leaving a merge in progress.
 */
export async function mergeSessionWorktree(binding: SessionWorktreeBinding): Promise<string> {
  assertSafeBranchName(binding.branch);
  if (binding.baseBranch) assertSafeBranchName(binding.baseBranch);
  assertManagedWorktreePath(binding.commonDir, binding.path);
  return serialize(binding.commonDir, async () => {
    const workspaceStatus = await runGit(binding.repoRoot, ["status", "--porcelain"]);
    if (workspaceStatus) {
      throw new Error(
        "The workspace checkout has uncommitted changes. Commit or stash them before merging this session.",
      );
    }
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
    const current = await runGit(binding.repoRoot, ["branch", "--show-current"]);
    if (current !== target) {
      await runGit(binding.repoRoot, ["checkout", target]);
    }
    try {
      await runGit(binding.repoRoot, ["merge", "--no-edit", binding.branch]);
    } catch (error) {
      await runGit(binding.repoRoot, ["merge", "--abort"]).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Merge of ${binding.branch} into ${target} failed. The workspace checkout was restored. ${message}`,
      );
    }
    return target;
  });
}

export async function removeSessionWorktree(binding: SessionWorktreeBinding): Promise<void> {
  assertSafeBranchName(binding.branch);
  if (!binding.branch.startsWith("lancer/")) {
    throw new Error("Refusing to delete a branch that Lancer did not create for this session.");
  }
  assertManagedWorktreePath(binding.commonDir, binding.path);
  await serialize(binding.commonDir, async () => {
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
