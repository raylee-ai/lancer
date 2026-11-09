import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CreateSessionOptions,
  SessionRef,
  SessionSnapshot,
  WorkspaceRef,
} from "@lancer/session-driver";
import type { JsonCatalogStore } from "@lancer/catalogs/node";
import type { PiSdkDriver } from "@lancer/pi-sdk-driver";
import type {
  DesktopAppState,
  SessionWorktreeDiff,
  WorkspaceSessionTarget,
} from "../../contracts/desktop-state";
import {
  inspectGitRepository,
  snapshotSessionWorktree,
  mergeSessionWorktree as mergeWorktree,
  commitSessionWorktree,
  readSessionWorktreeCompletion,
  applySessionWorktreeCompletion,
  readSessionWorktreeDiff as readWorktreeDiff,
  sessionWorktreeMatchesCommit,
  removeSessionWorktree,
  createSessionWorktree,
  type SessionWorktreeBinding,
} from "../platform/worktrees/session-worktree";
import type { WorkspaceOwnerHost } from "./app-store-workspace";

const execFileAsync = promisify(execFile);
const WORKTREE_INIT_TIMEOUT_MS = 10 * 60 * 1000;

interface SessionWorktreeHost {
  readonly catalogStore: JsonCatalogStore;
  initialize(): Promise<void>;
  workspaceRefFromState(workspaceId: string): WorkspaceRef | undefined;
  sessionFromState(sessionRef: SessionRef): { readonly status: string } | undefined;
}

interface ChildSessionWorktreeHost extends SessionWorktreeHost {
  readonly driver: Pick<PiSdkDriver, "createSession" | "retargetExecutionCwd">;
}

type SessionWorktreeMergeHost = ChildSessionWorktreeHost &
  Pick<WorkspaceOwnerHost, "withErrorHandling" | "refreshState">;

type ChildSessionIsolationHost = ChildSessionWorktreeHost;

export interface WorktreeInitializationFailure {
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
}

export function parseWorktreeInitializationFailure(
  value: string | null | undefined,
): WorktreeInitializationFailure | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "command" in parsed &&
      typeof parsed.command === "string" &&
      "output" in parsed &&
      typeof parsed.output === "string" &&
      "exitCode" in parsed &&
      (typeof parsed.exitCode === "number" || parsed.exitCode === null)
    ) {
      return {
        command: parsed.command,
        exitCode: parsed.exitCode,
        output: parsed.output,
      };
    }
  } catch {
    return { command: "", exitCode: null, output: value };
  }
  return { command: "", exitCode: null, output: value };
}

export function formatWorktreeInitializationFailure(
  failure: WorktreeInitializationFailure,
): string {
  return [
    `Command: ${failure.command || "(unknown)"}`,
    `Exit code: ${failure.exitCode ?? "unavailable"}`,
    failure.output || "(no output)",
  ].join("\n");
}

export async function runWorktreeInitialization(
  cwd: string,
  command: string,
): Promise<WorktreeInitializationFailure | undefined> {
  if (!command.trim()) return undefined;
  const isWindows = process.platform === "win32";
  const shell = isWindows ? process.env.ComSpec || "cmd.exe" : "sh";
  const args = isWindows ? ["/d", "/s", "/c", command] : ["-lc", command];
  try {
    await execFileAsync(shell, args, {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
      timeout: WORKTREE_INIT_TIMEOUT_MS,
      env: process.env,
    });
    return undefined;
  } catch (error) {
    const result = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .map((value) => String(value))
      .join("\n");
    const lines = output.split(/\r?\n/);
    return {
      command,
      exitCode: typeof result.code === "number" ? result.code : null,
      output: lines.slice(-20).join("\n").trimEnd(),
    };
  }
}

export async function createSessionWithWorktree(
  store: WorkspaceOwnerHost,
  workspace: WorkspaceRef,
  options: CreateSessionOptions & { readonly useWorktree?: boolean },
): Promise<SessionSnapshot> {
  const { useWorktree, ...createOptions } = options;
  let created: SessionWorktreeBinding | undefined;
  let snapshot: SessionSnapshot | undefined;
  let initFailure: WorktreeInitializationFailure | undefined;
  try {
    snapshot = await store.driver.createSession(workspace, {
      ...createOptions,
      ...(useWorktree
        ? {
            resolveExecutionCwd: async (sessionId: string) => {
              const binding = await createSessionWorktree(workspace.path, sessionId);
              if (!binding) return undefined;
              created = binding;
              const settings = await store.catalogStore.workspaces.getWorkspace(
                workspace.workspaceId,
              );
              initFailure = await runWorktreeInitialization(
                binding.path,
                settings?.worktreeInitCommand ?? "",
              );
              return binding.path;
            },
          }
        : {}),
    });
    if (created || initFailure) {
      const binding = created;
      await store.catalogStore.sessions.updateControlMetadata(snapshot.ref, {
        ...(binding
          ? {
              worktreePath: binding.path,
              executionCwd: binding.path,
              worktreeBranch: binding.branch,
              worktreeBaseBranch: binding.baseBranch || null,
              worktreeBaseSha: binding.baseSha,
            }
          : {}),
        worktreeInitFailure: initFailure ? JSON.stringify(initFailure) : null,
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

export async function createChildSessionWithIsolation(
  store: ChildSessionIsolationHost,
  workspace: WorkspaceRef,
  parentRef: SessionRef,
  options: CreateSessionOptions,
  isolation: "worktree" | "shared",
): Promise<SessionSnapshot> {
  await store.initialize();
  const parentWorkspace = store.workspaceRefFromState(parentRef.workspaceId);
  if (!parentWorkspace) throw new Error(`Unknown parent workspace: ${parentRef.workspaceId}`);
  const parentMetadata = await store.catalogStore.sessions.getControlMetadata(parentRef);
  const parentCwd =
    parentMetadata?.executionCwd ?? parentMetadata?.worktreePath ?? parentWorkspace.path;
  const settings = await store.catalogStore.workspaces.getWorkspace(workspace.workspaceId);
  let created: SessionWorktreeBinding | undefined;
  let initFailure: WorktreeInitializationFailure | undefined;
  let session: SessionSnapshot | undefined;
  try {
    session = await store.driver.createSession(workspace, {
      ...options,
      resolveExecutionCwd: async (sessionId) => {
        if (isolation === "worktree" && (await inspectGitRepository(parentCwd))) {
          const snapshot = await snapshotSessionWorktree(parentCwd);
          created = await createSessionWorktree(parentCwd, sessionId, snapshot.baseSha);
          if (!created) throw new Error("Unable to create the child session worktree.");
          initFailure = await runWorktreeInitialization(
            created.path,
            settings?.worktreeInitCommand ?? "",
          );
          return created.path;
        }
        return parentCwd;
      },
    });
    const binding = created;
    await store.catalogStore.sessions.updateControlMetadata(session.ref, {
      worktreePath: binding?.path ?? null,
      executionCwd: binding?.path ?? parentCwd,
      worktreeBranch: binding?.branch ?? null,
      worktreeBaseBranch: binding?.baseBranch ?? null,
      worktreeBaseSha: binding?.baseSha ?? null,
      worktreeInitFailure: initFailure ? JSON.stringify(initFailure) : null,
      orchestrationParentWorkspaceId: parentRef.workspaceId,
      orchestrationParentSessionId: parentRef.sessionId,
      orchestrationIsolation: binding ? "worktree" : "shared",
    });
    return session;
  } catch (error) {
    if (created) {
      await removeSessionWorktree(created).catch(() => undefined);
      if (session) await store.driver.retargetExecutionCwd(session.ref).catch(() => undefined);
    }
    throw error;
  }
}

async function requireBinding(
  store: SessionWorktreeHost,
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

function assertSessionIdle(
  store: Pick<SessionWorktreeHost, "sessionFromState">,
  ref: SessionRef,
): void {
  const session = store.sessionFromState(ref);
  if (session?.status === "running") {
    throw new Error("Wait for the session to finish before merging or discarding its worktree.");
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
  store: SessionWorktreeMergeHost,
  target: WorkspaceSessionTarget,
  completedSha?: string,
): Promise<DesktopAppState> {
  await store.initialize();
  return store.withErrorHandling(async () => {
    const { ref, binding } = await requireBinding(store, target);
    assertSessionIdle(store, ref);
    const metadata = await store.catalogStore.sessions.getControlMetadata(ref);
    if (metadata?.orchestrationParentSessionId) {
      if (!metadata.worktreeCompletedSha) {
        throw new Error("This child thread has no recorded completion to merge.");
      }
      if (completedSha !== metadata.worktreeCompletedSha) {
        throw new Error(
          "The child completion changed; review its current diff before merging that commit.",
        );
      }
      const result = await applyChildSessionWorktreeCompletion(
        store,
        ref,
        completedSha,
        binding,
        metadata,
      );
      if (result.error) throw new Error(result.error);
      if (!result.applied) {
        throw new Error(`Child worktree conflicts: ${result.conflicts.join(", ")}`);
      }
      return store.refreshState({ clearLastError: true });
    }
    await mergeWorktree(binding);
    return store.refreshState({ clearLastError: true });
  });
}

export async function mergeChildSessionWorktree(
  store: ChildSessionWorktreeHost,
  target: WorkspaceSessionTarget,
  completedSha: string,
): Promise<{
  readonly applied: boolean;
  readonly conflicts: readonly string[];
  readonly error?: string;
}> {
  await store.initialize();
  const { ref, binding } = await requireBinding(store, target);
  assertSessionIdle(store, ref);
  const metadata = await store.catalogStore.sessions.getControlMetadata(ref);
  if (!metadata?.orchestrationParentSessionId || !metadata.orchestrationParentWorkspaceId) {
    throw new Error("This session is not an isolated child thread.");
  }
  if (!/^[0-9a-f]{40,64}$/i.test(completedSha)) {
    throw new Error("A full completion commit id is required.");
  }
  return applyChildSessionWorktreeCompletion(store, ref, completedSha, binding, metadata);
}

async function applyChildSessionWorktreeCompletion(
  store: ChildSessionWorktreeHost,
  ref: SessionRef,
  completedSha: string,
  binding: SessionWorktreeBinding,
  metadata: NonNullable<
    Awaited<ReturnType<ChildSessionWorktreeHost["catalogStore"]["sessions"]["getControlMetadata"]>>
  >,
): Promise<{
  readonly applied: boolean;
  readonly conflicts: readonly string[];
  readonly error?: string;
}> {
  const latestCompletedSha = metadata.worktreeCompletedSha;
  if (latestCompletedSha !== completedSha) {
    return {
      applied: false,
      conflicts: [],
      error: latestCompletedSha
        ? `This is not the latest returned completion. Latest completion: ${latestCompletedSha}. Read and review that version with read_thread before merging.`
        : "This child thread has no returned completion to merge.",
    };
  }
  if (!(await sessionWorktreeMatchesCommit(binding, completedSha))) {
    return {
      applied: false,
      conflicts: [],
      error:
        "The child worktree contains changes that have not been returned. To merge, use send_message_to_thread to ask the child to finish a run and return a new completion, then review that version. If these changes are not wanted, have the user discard and clean up the worktree.",
    };
  }
  const parentRef = {
    workspaceId: metadata.orchestrationParentWorkspaceId!,
    sessionId: metadata.orchestrationParentSessionId!,
  };
  const parentWorkspace = store.workspaceRefFromState(parentRef.workspaceId);
  if (!parentWorkspace) throw new Error(`Unknown parent workspace: ${parentRef.workspaceId}`);
  const parentMetadata = await store.catalogStore.sessions.getControlMetadata(parentRef);
  const parentPath =
    parentMetadata?.executionCwd ?? parentMetadata?.worktreePath ?? parentWorkspace.path;
  const result = await applySessionWorktreeCompletion(binding, completedSha, parentPath);
  if (!result.applied) return result;
  await removeSessionWorktree(binding);
  await store.catalogStore.sessions.updateControlMetadata(ref, {
    worktreePath: null,
    worktreeBranch: null,
    worktreeBaseBranch: null,
    worktreeBaseSha: null,
    worktreeCompletedSha: null,
    executionCwd: parentPath,
    orchestrationIsolation: "shared",
  });
  await store.driver.retargetExecutionCwd(ref);
  return result;
}

export async function discardSessionWorktree(
  store: WorkspaceOwnerHost,
  target: WorkspaceSessionTarget,
): Promise<DesktopAppState> {
  await store.initialize();
  return store.withErrorHandling(async () => {
    const { ref, binding } = await requireBinding(store, target);
    assertSessionIdle(store, ref);
    const metadata = await store.catalogStore.sessions.getControlMetadata(ref);
    await removeSessionWorktree(binding);
    let executionCwd: string | null = null;
    if (metadata?.orchestrationParentWorkspaceId && metadata.orchestrationParentSessionId) {
      const parentRef = {
        workspaceId: metadata.orchestrationParentWorkspaceId,
        sessionId: metadata.orchestrationParentSessionId,
      };
      const parentWorkspace = store.workspaceRefFromState(parentRef.workspaceId);
      if (!parentWorkspace) throw new Error(`Unknown parent workspace: ${parentRef.workspaceId}`);
      const parentMetadata = await store.catalogStore.sessions.getControlMetadata(parentRef);
      executionCwd =
        parentMetadata?.executionCwd ?? parentMetadata?.worktreePath ?? parentWorkspace.path;
    }
    await store.catalogStore.sessions.updateControlMetadata(ref, {
      worktreePath: null,
      executionCwd,
      worktreeBranch: null,
      worktreeBaseBranch: null,
      worktreeBaseSha: null,
      worktreeCompletedSha: null,
      ...(executionCwd ? { orchestrationIsolation: "shared" as const } : {}),
    });
    await store.driver.retargetExecutionCwd(ref);
    return store.refreshState({ clearLastError: true });
  });
}
