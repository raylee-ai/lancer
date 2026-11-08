import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { JsonCatalogStore } from "@lancer/catalogs/node";
import {
  createSessionWorktree,
  snapshotSessionWorktree,
  commitSessionWorktree,
  readSessionWorktreeCompletion,
  applySessionWorktreeCompletion,
  inspectGitRepository,
  mergeSessionWorktree,
  readSessionWorktreeDiff,
  removeSessionWorktree,
  sessionBranchName,
} from "../../electron/platform/worktrees/session-worktree";
import {
  mergeChildSessionWorktree,
  runWorktreeInitialization,
} from "../../electron/workspace/session-worktree-sessions";

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

async function makeChildMergeHost(
  repo: string,
  parentPath: string,
  parentBranch: string,
  child: NonNullable<Awaited<ReturnType<typeof createSessionWorktree>>>,
): Promise<{
  readonly host: Parameters<typeof mergeChildSessionWorktree>[0];
  readonly retargeted: string[];
}> {
  const catalogDir = await mkdtemp(join(tmpdir(), "lancer-child-merge-catalog-"));
  const catalogStore = new JsonCatalogStore({ catalogFilePath: join(catalogDir, "catalogs.json") });
  const workspaceId = "workspace";
  const parentSessionId = "parent";
  const childSessionId = basename(child.path);
  const parentRef = { workspaceId, sessionId: parentSessionId };
  const childRef = { workspaceId, sessionId: childSessionId };
  await catalogStore.workspaces.upsertWorkspace({
    workspaceId,
    path: repo,
    displayName: "Test workspace",
    lastOpenedAt: new Date().toISOString(),
    sortOrder: 0,
  });
  await catalogStore.sessions.upsertSession({
    workspaceId,
    sessionRef: parentRef,
    title: "Parent",
    updatedAt: new Date().toISOString(),
    status: "idle",
  });
  await catalogStore.sessions.updateControlMetadata(parentRef, {
    worktreePath: parentPath,
    executionCwd: parentPath,
    worktreeBranch: parentBranch,
  });
  await catalogStore.sessions.upsertSession({
    workspaceId,
    sessionRef: childRef,
    title: "Child",
    updatedAt: new Date().toISOString(),
    status: "idle",
  });
  await catalogStore.sessions.updateControlMetadata(childRef, {
    worktreePath: child.path,
    executionCwd: child.path,
    worktreeBranch: child.branch,
    worktreeBaseBranch: child.baseBranch,
    worktreeBaseSha: child.baseSha,
    orchestrationParentWorkspaceId: workspaceId,
    orchestrationParentSessionId: parentSessionId,
    orchestrationIsolation: "worktree",
  });
  const retargeted: string[] = [];
  return {
    host: {
      catalogStore,
      driver: {
        createSession: async () => {
          throw new Error("createSession is not used by merge tests");
        },
        retargetExecutionCwd: async (ref) => {
          retargeted.push(ref.sessionId);
        },
      },
      initialize: async () => {},
      workspaceRefFromState: (id) =>
        id === workspaceId ? { workspaceId, path: repo, displayName: "Test workspace" } : undefined,
      sessionFromState: (ref) =>
        ref.sessionId === childSessionId ? { status: "idle" } : undefined,
    },
    retargeted,
  };
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

test("snapshot captures parent edits without changing its files, index, branch or stashes", async () => {
  const repo = await makeRepo();
  await writeFile(join(repo, ".gitignore"), "node_modules/\n.env\n");
  await git(repo, "add", ".gitignore");
  await git(repo, "commit", "-qm", "ignore local dependencies");
  await writeFile(join(repo, "stash-me.txt"), "stash\n");
  await git(repo, "add", "stash-me.txt");
  await git(repo, "stash", "push", "-qm", "fixture stash");
  await git(repo, "add", "seed.txt");
  await writeFile(join(repo, "seed.txt"), "staged version\n");
  await git(repo, "add", "seed.txt");
  await writeFile(join(repo, "seed.txt"), "working tree version\n");
  await writeFile(join(repo, "new-file.txt"), "new\n");
  await mkdir(join(repo, "node_modules"), { recursive: true });
  await writeFile(join(repo, "node_modules", "ignored.txt"), "ignored\n");
  await writeFile(join(repo, ".env"), "secret\n");

  const before = {
    file: await readFile(join(repo, "seed.txt"), "utf8"),
    index: await git(repo, "write-tree"),
    branch: await git(repo, "branch", "--show-current"),
    stashes: await git(repo, "stash", "list"),
    status: await git(repo, "status", "--porcelain"),
  };
  const { baseSha } = await snapshotSessionWorktree(repo);
  const child = await createSessionWorktree(repo, "snapshot-child", baseSha);
  assertExists(child);

  expect(await readFile(join(child.path, "seed.txt"), "utf8")).toBe("working tree version\n");
  expect(await readFile(join(child.path, "new-file.txt"), "utf8")).toBe("new\n");
  await expect(readFile(join(child.path, "node_modules", "ignored.txt"), "utf8")).rejects.toThrow();
  await expect(readFile(join(child.path, ".env"), "utf8")).rejects.toThrow();
  expect({
    file: await readFile(join(repo, "seed.txt"), "utf8"),
    index: await git(repo, "write-tree"),
    branch: await git(repo, "branch", "--show-current"),
    stashes: await git(repo, "stash", "list"),
    status: await git(repo, "status", "--porcelain"),
  }).toEqual(before);
});

test("completion records an exact diff and applies it to a dirty parent checkout", async () => {
  const repo = await makeRepo();
  const snapshot = await snapshotSessionWorktree(repo);
  const child = await createSessionWorktree(repo, "completion-child", snapshot.baseSha);
  assertExists(child);
  await writeFile(join(child.path, "child-change.txt"), "child\n");
  const completedSha = await commitSessionWorktree(child);
  const completion = await readSessionWorktreeCompletion(child, completedSha);
  expect(completion.baseSha).toBe(snapshot.baseSha);
  expect(completion.completedSha).toBe(completedSha);
  expect(completion.branch).toBe("lancer/completion-child");
  expect(completion.files).toContain("child-change.txt");
  expect(completion.stat).toContain("child-change.txt");

  await writeFile(join(repo, "parent-uncommitted.txt"), "parent\n");
  const indexBefore = await git(repo, "write-tree");
  const result = await applySessionWorktreeCompletion(child, completedSha, repo);
  expect(result).toEqual({ applied: true, conflicts: [] });
  expect(await readFile(join(repo, "child-change.txt"), "utf8")).toBe("child\n");
  expect(await readFile(join(repo, "parent-uncommitted.txt"), "utf8")).toBe("parent\n");
  expect(await git(repo, "write-tree")).toBe(indexBefore);
});

test("completion diff is truncated at one mebibyte of UTF-8 output", async () => {
  const repo = await makeRepo();
  const snapshot = await snapshotSessionWorktree(repo);
  const child = await createSessionWorktree(repo, "large-diff-child", snapshot.baseSha);
  assertExists(child);
  await writeFile(join(child.path, "large.txt"), `${"改".repeat(400_000)}\n`);
  const completedSha = await commitSessionWorktree(child);

  const completion = await readSessionWorktreeCompletion(child, completedSha);
  expect(completion.truncated).toBe(true);
  expect(Buffer.byteLength(completion.patch, "utf8")).toBeLessThanOrEqual(1024 * 1024);
});

test("conflicting child patch leaves the dirty parent files and index unchanged", async () => {
  const repo = await makeRepo();
  const snapshot = await snapshotSessionWorktree(repo);
  const child = await createSessionWorktree(repo, "conflicting-child", snapshot.baseSha);
  assertExists(child);
  await writeFile(join(child.path, "seed.txt"), "from child\n");
  const completedSha = await commitSessionWorktree(child);
  await writeFile(join(repo, "seed.txt"), "from parent\n");
  const before = {
    file: await readFile(join(repo, "seed.txt"), "utf8"),
    index: await git(repo, "write-tree"),
    branch: await git(repo, "branch", "--show-current"),
    status: await git(repo, "status", "--porcelain"),
  };

  const result = await applySessionWorktreeCompletion(child, completedSha, repo);
  expect(result.applied).toBe(false);
  expect(result.conflicts).toContain("seed.txt");
  expect({
    file: await readFile(join(repo, "seed.txt"), "utf8"),
    index: await git(repo, "write-tree"),
    branch: await git(repo, "branch", "--show-current"),
    status: await git(repo, "status", "--porcelain"),
  }).toEqual(before);
});

test("applying a child diff preserves symbolic links", async () => {
  const repo = await makeRepo();
  const snapshot = await snapshotSessionWorktree(repo);
  const child = await createSessionWorktree(repo, "symlink-child", snapshot.baseSha);
  assertExists(child);
  await writeFile(join(child.path, "link-target.txt"), "linked\n");
  await symlink("link-target.txt", join(child.path, "link.txt"));
  const completedSha = await commitSessionWorktree(child);

  const result = await applySessionWorktreeCompletion(child, completedSha, repo);
  expect(result).toEqual({ applied: true, conflicts: [] });
  expect(await readlink(join(repo, "link.txt"))).toBe("link-target.txt");
  expect(await readFile(join(repo, "link.txt"), "utf8")).toBe("linked\n");
});

test("merging a child completion applies it to the parent worktree and cleans its branch", async () => {
  const repo = await makeRepo();
  const parent = await createSessionWorktree(repo, "merge-parent");
  assertExists(parent);
  await writeFile(join(parent.path, "parent-edit.txt"), "parent\n");
  const snapshot = await snapshotSessionWorktree(parent.path);
  const child = await createSessionWorktree(parent.path, "merge-child", snapshot.baseSha);
  assertExists(child);
  await writeFile(join(child.path, "child-edit.txt"), "child\n");
  const completedSha = await commitSessionWorktree(child);
  const { host, retargeted } = await makeChildMergeHost(repo, parent.path, parent.branch, child);

  const result = await mergeChildSessionWorktree(
    host,
    { workspaceId: "workspace", sessionId: basename(child.path) },
    completedSha,
  );
  expect(result).toEqual({ applied: true, conflicts: [] });
  expect(await readFile(join(parent.path, "parent-edit.txt"), "utf8")).toBe("parent\n");
  expect(await readFile(join(parent.path, "child-edit.txt"), "utf8")).toBe("child\n");
  expect(await git(repo, "branch", "--list", child.branch)).toBe("");
  expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(child.path);
  expect(
    await host.catalogStore.sessions.getControlMetadata({
      workspaceId: "workspace",
      sessionId: basename(child.path),
    }),
  ).toMatchObject({
    worktreePath: null,
    executionCwd: parent.path,
    orchestrationIsolation: "shared",
  });
  expect(retargeted).toEqual([basename(child.path)]);
});

test("child merge conflict preserves the parent worktree and retains the child branch", async () => {
  const repo = await makeRepo();
  const parent = await createSessionWorktree(repo, "conflict-parent");
  assertExists(parent);
  const snapshot = await snapshotSessionWorktree(parent.path);
  const child = await createSessionWorktree(parent.path, "conflict-child", snapshot.baseSha);
  assertExists(child);
  await writeFile(join(child.path, "seed.txt"), "child\n");
  const completedSha = await commitSessionWorktree(child);
  await writeFile(join(parent.path, "seed.txt"), "parent\n");
  const before = {
    file: await readFile(join(parent.path, "seed.txt"), "utf8"),
    index: await git(parent.path, "write-tree"),
    branch: await git(parent.path, "branch", "--show-current"),
    status: await git(parent.path, "status", "--porcelain"),
  };
  const { host } = await makeChildMergeHost(repo, parent.path, parent.branch, child);

  const result = await mergeChildSessionWorktree(
    host,
    { workspaceId: "workspace", sessionId: basename(child.path) },
    completedSha,
  );
  expect(result.applied).toBe(false);
  expect(result.conflicts).toContain("seed.txt");
  expect({
    file: await readFile(join(parent.path, "seed.txt"), "utf8"),
    index: await git(parent.path, "write-tree"),
    branch: await git(parent.path, "branch", "--show-current"),
    status: await git(parent.path, "status", "--porcelain"),
  }).toEqual(before);
  expect(await git(repo, "branch", "--list", child.branch)).toContain(child.branch);
  expect(await git(repo, "worktree", "list", "--porcelain")).toContain(child.path);
});

test("worktree init is a no-op when unset and a nonzero command exit is non-fatal", async () => {
  const repo = await makeRepo();
  const binding = await createSessionWorktree(repo, "init-failure");
  assertExists(binding);
  expect(await runWorktreeInitialization(binding.path, "")).toBeUndefined();
  const failingCommand =
    process.platform === "win32"
      ? "echo setup output && exit /b 7"
      : "printf 'setup output\\n'; exit 7";
  const failure = await runWorktreeInitialization(binding.path, failingCommand);
  expect(failure).toEqual({
    command: failingCommand,
    exitCode: 7,
    output: "setup output",
  });
  expect(await readFile(join(binding.path, "seed.txt"), "utf8")).toBe("seed\n");
});

test("completion commit uses a fallback identity when Git identity is not configured", async () => {
  const repo = await makeRepo();
  const binding = await createSessionWorktree(repo, "identity-fallback");
  assertExists(binding);
  await writeFile(join(binding.path, "result.txt"), "done\n");
  await git(repo, "config", "--unset", "user.name");
  await git(repo, "config", "--unset", "user.email");
  const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  try {
    const completedSha = await commitSessionWorktree(binding);
    expect(await git(binding.path, "show", "-s", "--format=%an <%ae>", completedSha)).toBe(
      "Lancer <lancer@localhost>",
    );
  } finally {
    if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
  }
});

function assertExists<T>(value: T | undefined): asserts value is T {
  expect(value).toBeTruthy();
}
