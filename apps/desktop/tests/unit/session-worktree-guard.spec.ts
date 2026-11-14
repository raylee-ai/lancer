import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { JsonCatalogStore } from "@lancer/catalogs/node";
import { sessionKey, type SessionRef, type SessionRuntimeMetadata } from "@lancer/session-driver";
import type { SessionWorktreeOperation } from "@lancer/pi-sdk-driver";
import { createSessionWorktree } from "../../electron/platform/worktrees/session-worktree";
import {
  discardSessionWorktree,
  mergeSessionWorktree,
} from "../../electron/workspace/session-worktree-sessions";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.toString().trim();
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lancer-worktree-guard-"));
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

function makeStore(
  repo: string,
  catalog: JsonCatalogStore,
  options: {
    readonly running?: ReadonlySet<string>;
    readonly driverBusy?: ReadonlySet<string>;
    readonly metadataFailures?: number;
  } = {},
) {
  const retargeted: SessionRef[] = [];
  let metadataFailures = options.metadataFailures ?? 0;
  const originalUpdate = catalog.sessions.updateControlMetadata.bind(catalog.sessions);
  catalog.sessions.updateControlMetadata = async (ref, patch) => {
    if (metadataFailures > 0) {
      metadataFailures -= 1;
      throw new Error("catalog write failed");
    }
    return originalUpdate(ref, patch);
  };
  const driver = {
    beginWorktreeOperation(ref: SessionRef, _operation: SessionWorktreeOperation) {
      if (options.driverBusy?.has(sessionKey(ref))) {
        throw new Error("Stop the session before merging or discarding its worktree.");
      }
      return () => undefined;
    },
    async retargetExecutionCwd(ref: SessionRef) {
      retargeted.push({ ...ref });
    },
    async createSession() {
      throw new Error("unused");
    },
  };
  return {
    retargeted,
    store: {
      driver,
      catalogStore: catalog,
      async initialize() {
        return undefined;
      },
      workspaceRefFromState() {
        return { workspaceId: "ws", path: repo, displayName: "repo" };
      },
      sessionFromState(ref: SessionRef) {
        return {
          updatedAt: "2026-01-01T00:00:00.000Z",
          title: ref.sessionId,
          status: options.running?.has(sessionKey(ref)) ? "running" : "idle",
          preview: "",
        };
      },
      async refreshState() {
        return { lastError: undefined };
      },
      async withErrorHandling<T>(fn: () => Promise<T>) {
        return fn();
      },
    },
  };
}

async function seed(
  catalog: JsonCatalogStore,
  ref: SessionRef,
  metadata: SessionRuntimeMetadata,
): Promise<void> {
  await catalog.sessions.upsertSession({
    sessionRef: ref,
    workspaceId: ref.workspaceId,
    title: ref.sessionId,
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "idle",
    ...metadata,
  });
}

test("merge and discard refuse a running session before git changes the checkout", async () => {
  const repo = await makeRepo();
  const binding = await createSessionWorktree(repo, "busy");
  expect(binding).toBeTruthy();
  const catalog = new JsonCatalogStore({
    catalogFilePath: join(repo, "..", "catalog.json"),
  });
  const ref = { workspaceId: "ws", sessionId: "busy" };
  await seed(catalog, ref, {
    worktreePath: binding!.path,
    worktreeBranch: binding!.branch,
    worktreeBaseBranch: binding!.baseBranch,
    worktreeBaseSha: binding!.baseSha,
  });
  await writeFile(join(binding!.path, "pending.txt"), "pending\n");
  const head = await git(repo, "rev-parse", "HEAD");
  const running = makeStore(repo, catalog, { running: new Set([sessionKey(ref)]) });

  await expect(mergeSessionWorktree(running.store as never, ref)).rejects.toThrow(
    /Stop the session/,
  );
  await expect(discardSessionWorktree(running.store as never, ref)).rejects.toThrow(
    /Stop the session/,
  );

  expect(await git(repo, "rev-parse", "HEAD")).toBe(head);
  expect(await readFile(join(binding!.path, "pending.txt"), "utf8")).toBe("pending\n");
  expect((await catalog.sessions.getControlMetadata(ref))?.worktreePath).toBe(binding!.path);
  expect(running.retargeted).toEqual([]);
});

test("a stale idle projection still refuses when the driver says the turn has started", async () => {
  const repo = await makeRepo();
  const binding = await createSessionWorktree(repo, "starting");
  const catalog = new JsonCatalogStore({
    catalogFilePath: join(repo, "..", "starting-catalog.json"),
  });
  const ref = { workspaceId: "ws", sessionId: "starting" };
  await seed(catalog, ref, {
    worktreePath: binding!.path,
    worktreeBranch: binding!.branch,
    worktreeBaseBranch: binding!.baseBranch,
    worktreeBaseSha: binding!.baseSha,
  });
  const head = await git(repo, "rev-parse", "HEAD");
  const starting = makeStore(repo, catalog, { driverBusy: new Set([sessionKey(ref)]) });

  await expect(mergeSessionWorktree(starting.store as never, ref)).rejects.toThrow(
    /Stop the session/,
  );
  await expect(discardSessionWorktree(starting.store as never, ref)).rejects.toThrow(
    /Stop the session/,
  );

  expect(await git(repo, "rev-parse", "HEAD")).toBe(head);
  expect(await readFile(join(repo, "seed.txt"), "utf8")).toBe("seed\n");
  expect((await catalog.sessions.getControlMetadata(ref))?.worktreeBranch).toBe(binding!.branch);
});

test("discard clears every session sharing the checkout and retries a failed metadata write", async () => {
  const repo = await makeRepo();
  const binding = await createSessionWorktree(repo, "parent");
  const catalog = new JsonCatalogStore({
    catalogFilePath: join(repo, "..", "shared-catalog.json"),
  });
  const parent = { workspaceId: "ws", sessionId: "parent" };
  const child = { workspaceId: "ws", sessionId: "child" };
  await seed(catalog, parent, {
    worktreePath: binding!.path,
    worktreeBranch: binding!.branch,
    worktreeBaseBranch: binding!.baseBranch,
    worktreeBaseSha: binding!.baseSha,
  });
  await seed(catalog, child, { worktreePath: binding!.path });
  const host = makeStore(repo, catalog, { metadataFailures: 1 });

  await discardSessionWorktree(host.store as never, parent);

  expect((await catalog.sessions.getControlMetadata(parent))?.worktreePath).toBeNull();
  expect((await catalog.sessions.getControlMetadata(child))?.worktreePath).toBeNull();
  expect(host.retargeted.map((ref) => ref.sessionId).sort()).toEqual(["child", "parent"]);
  await expect(readFile(join(binding!.path, "seed.txt"), "utf8")).rejects.toThrow();
  expect(await readFile(join(repo, "seed.txt"), "utf8")).toBe("seed\n");
  expect(await git(repo, "status", "--porcelain")).toBe("");
  expect(await git(repo, "branch", "--list", "lancer/parent")).toBe("");
});

test("discard leaves a child checkout alone when that child is running", async () => {
  const repo = await makeRepo();
  const binding = await createSessionWorktree(repo, "parent-live-child");
  const catalog = new JsonCatalogStore({
    catalogFilePath: join(repo, "..", "live-child-catalog.json"),
  });
  const parent = { workspaceId: "ws", sessionId: "parent-live-child" };
  const child = { workspaceId: "ws", sessionId: "child-live" };
  await seed(catalog, parent, {
    worktreePath: binding!.path,
    worktreeBranch: binding!.branch,
    worktreeBaseBranch: binding!.baseBranch,
    worktreeBaseSha: binding!.baseSha,
  });
  await seed(catalog, child, { worktreePath: binding!.path });
  const host = makeStore(repo, catalog, { running: new Set([sessionKey(child)]) });

  await expect(discardSessionWorktree(host.store as never, parent)).rejects.toThrow(
    /Stop the session/,
  );

  expect(await readFile(join(binding!.path, "seed.txt"), "utf8")).toBe("seed\n");
  expect((await catalog.sessions.getControlMetadata(parent))?.worktreeBranch).toBe(binding!.branch);
  expect((await catalog.sessions.getControlMetadata(child))?.worktreePath).toBe(binding!.path);
  expect(host.retargeted).toEqual([]);
});
