import type {
  CreateSessionOptions,
  SessionRef,
  SessionSnapshot,
  WorkspaceRef,
} from "@lancer/session-driver";
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

function assertSessionIdle(store: WorkspaceOwnerHost, ref: SessionRef): void {
  const session = store.sessionFromState(ref);
  if (session?.status === "running") {
    throw new Error("Stop the session before merging or discarding its worktree.");
  }
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
    assertSessionIdle(store, ref);
    await mergeWorktree(binding);
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
    assertSessionIdle(store, ref);
    await removeSessionWorktree(binding);
    await store.catalogStore.sessions.updateControlMetadata(ref, {
      worktreePath: null,
      worktreeBranch: null,
      worktreeBaseBranch: null,
      worktreeBaseSha: null,
    });
    await store.driver.retargetExecutionCwd(ref);
    return store.refreshState({ clearLastError: true });
  });
}
