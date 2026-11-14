import type {
  CreateSessionOptions,
  SessionRef,
  SessionRuntimeMetadata,
  SessionSnapshot,
  WorkspaceRef,
} from "@lancer/session-driver";
import type { SessionWorktreeOperation } from "@lancer/pi-sdk-driver";
import { stat } from "node:fs/promises";
import type {
  DesktopAppState,
  SessionWorktreeDiff,
  WorkspaceSessionTarget,
} from "../../contracts/desktop-state";
import {
  inspectGitRepository,
  mergeSessionWorktree as mergeWorktree,
  readSessionWorktreeDiff as readWorktreeDiff,
  removeSessionWorktree,
  createSessionWorktree,
  type SessionWorktreeBinding,
} from "../platform/worktrees/session-worktree";
import {
  canonicalWorktreePath,
  reserveWorktreeExecution,
  reserveWorktreeMutation,
} from "../platform/worktrees/session-worktree-lease";
import type { WorkspaceOwnerHost } from "./app-store-workspace";

export async function createSessionWithWorktree(
  store: WorkspaceOwnerHost,
  workspace: WorkspaceRef,
  options: CreateSessionOptions & { readonly useWorktree?: boolean },
): Promise<SessionSnapshot> {
  const { useWorktree, ...createOptions } = options;
  let created: SessionWorktreeBinding | undefined;
  let snapshot: SessionSnapshot | undefined;
  try {
    snapshot = await store.driver.createSession(workspace, {
      ...createOptions,
      ...(useWorktree
        ? {
            resolveExecutionCwd: async (sessionId: string) => {
              const binding = await createSessionWorktree(workspace.path, sessionId);
              if (!binding) return undefined;
              created = binding;
              return binding.path;
            },
          }
        : {}),
    });
    if (created) {
      const binding = created;
      await store.catalogStore.sessions.updateControlMetadata(snapshot.ref, {
        worktreePath: binding.path,
        worktreeBranch: binding.branch,
        worktreeBaseBranch: binding.baseBranch || null,
        worktreeBaseSha: binding.baseSha,
      });
    }
    return snapshot;
  } catch (error) {
    if (created) {
      await removeSessionWorktree(created).catch(() => undefined);
      if (snapshot) {
        await store.driver.retargetExecutionCwd(snapshot.ref).catch(() => undefined);
      }
    }
    throw error;
  }
}

async function requireBinding(
  store: WorkspaceOwnerHost,
  target: WorkspaceSessionTarget,
): Promise<{ readonly ref: SessionRef; readonly binding: SessionWorktreeBinding }> {
  const ref = { workspaceId: target.workspaceId, sessionId: target.sessionId };
  const workspace = store.workspaceRefFromState(target.workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${target.workspaceId}`);
  const metadata = await store.catalogStore.sessions.getControlMetadata(ref);
  if (!metadata?.worktreePath || !metadata.worktreeBranch || !metadata.worktreeBaseSha) {
    throw new Error("This session has no git worktree.");
  }
  const repo = await inspectGitRepository(workspace.path);
  if (!repo) throw new Error("This folder is not a Git repository.");
  return {
    ref,
    binding: {
      path: metadata.worktreePath,
      branch: metadata.worktreeBranch,
      baseBranch: metadata.worktreeBaseBranch ?? "",
      baseSha: metadata.worktreeBaseSha,
      repoRoot: repo.repoRoot,
      commonDir: repo.commonDir,
    },
  };
}

const STOP_BEFORE_WORKTREE = "Stop the session before merging or discarding its worktree.";

function assertProjectedIdle(store: WorkspaceOwnerHost, ref: SessionRef): void {
  const session = store.sessionFromState(ref);
  if (session?.status === "running") {
    throw new Error(STOP_BEFORE_WORKTREE);
  }
}

function lockSessions(
  store: WorkspaceOwnerHost,
  refs: readonly SessionRef[],
  operation: SessionWorktreeOperation,
): () => void {
  const releases: Array<() => void> = [];
  try {
    for (const ref of refs) {
      assertProjectedIdle(store, ref);
      releases.push(store.driver.beginWorktreeOperation(ref, operation));
    }
  } catch (error) {
    for (const release of releases) release();
    throw error;
  }
  return () => {
    for (const release of releases) release();
  };
}

async function sessionRefsUsingWorktree(
  store: WorkspaceOwnerHost,
  workspaceId: string,
  worktreePath: string,
): Promise<SessionRef[]> {
  const canonical = await canonicalWorktreePath(worktreePath);
  const listed = await store.catalogStore.sessions.listSessions(workspaceId);
  const refs: SessionRef[] = [];
  for (const entry of listed.sessions) {
    if (!entry.worktreePath) continue;
    if ((await canonicalWorktreePath(entry.worktreePath)) !== canonical) continue;
    refs.push({ workspaceId: entry.workspaceId, sessionId: entry.sessionRef.sessionId });
  }
  return refs;
}

async function withWorktreeMutation<T>(
  store: WorkspaceOwnerHost,
  workspaceId: string,
  ref: SessionRef,
  binding: SessionWorktreeBinding,
  operation: SessionWorktreeOperation,
  action: (refs: readonly SessionRef[]) => Promise<T>,
): Promise<T> {
  const releasePath = reserveWorktreeMutation(await canonicalWorktreePath(binding.path));
  try {
    const refs = await sessionRefsUsingWorktree(store, workspaceId, binding.path);
    if (
      !refs.some(
        (entry) => entry.workspaceId === ref.workspaceId && entry.sessionId === ref.sessionId,
      )
    ) {
      refs.unshift(ref);
    }
    const releaseSessions = lockSessions(store, refs, operation);
    try {
      return await action(refs);
    } finally {
      releaseSessions();
    }
  } finally {
    releasePath();
  }
}

async function clearWorktreeBindings(
  store: WorkspaceOwnerHost,
  refs: readonly SessionRef[],
): Promise<void> {
  for (const ref of refs) {
    await store.catalogStore.sessions.updateControlMetadata(ref, {
      worktreePath: null,
      worktreeBranch: null,
      worktreeBaseBranch: null,
      worktreeBaseSha: null,
    });
  }
  for (const ref of refs) {
    await store.driver.retargetExecutionCwd(ref);
  }
}

export async function prepareInheritedExecutionDirectory(
  catalog: {
    sessions: {
      getControlMetadata(ref: SessionRef): Promise<SessionRuntimeMetadata | null>;
    };
  },
  parentRef: SessionRef,
): Promise<{ readonly path?: string; readonly release: () => void }> {
  const metadata = await catalog.sessions.getControlMetadata(parentRef);
  const worktreePath = metadata?.worktreePath?.trim();
  if (!worktreePath) return { release: () => undefined };
  try {
    if (!(await stat(worktreePath)).isDirectory()) return { release: () => undefined };
  } catch {
    return { release: () => undefined };
  }
  const path = await canonicalWorktreePath(worktreePath);
  return { path, release: reserveWorktreeExecution(path) };
}

export async function readSessionWorktreeDiff(
  store: WorkspaceOwnerHost,
  target: WorkspaceSessionTarget,
): Promise<SessionWorktreeDiff> {
  await store.initialize();
  const { binding } = await requireBinding(store, target);
  const diff = await readWorktreeDiff(binding);
  return {
    path: binding.path,
    branch: binding.branch,
    baseBranch: binding.baseBranch,
    baseSha: binding.baseSha,
    stat: diff.stat,
    patch: diff.patch,
    truncated: diff.truncated,
  };
}

export async function mergeSessionWorktree(
  store: WorkspaceOwnerHost,
  target: WorkspaceSessionTarget,
): Promise<DesktopAppState> {
  await store.initialize();
  return store.withErrorHandling(async () => {
    const { ref, binding } = await requireBinding(store, target);
    await withWorktreeMutation(store, target.workspaceId, ref, binding, "merge", async () => {
      await mergeWorktree(binding);
    });
    return store.refreshState({ clearLastError: true });
  });
}

export async function discardSessionWorktree(
  store: WorkspaceOwnerHost,
  target: WorkspaceSessionTarget,
): Promise<DesktopAppState> {
  await store.initialize();
  return store.withErrorHandling(async () => {
    const { ref, binding } = await requireBinding(store, target);
    await withWorktreeMutation(store, target.workspaceId, ref, binding, "discard", async (refs) => {
      await removeSessionWorktree(binding);
      try {
        await clearWorktreeBindings(store, refs);
      } catch (error) {
        try {
          await clearWorktreeBindings(store, refs);
        } catch {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `${message} The worktree was removed, but the session could not return to the workspace directory. Discard again to finish.`,
          );
        }
      }
    });
    return store.refreshState({ clearLastError: true });
  });
}
