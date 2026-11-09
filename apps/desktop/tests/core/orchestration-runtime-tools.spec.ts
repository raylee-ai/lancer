import { createServer } from "node:http";
import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import type { SessionRef } from "@lancer/session-driver";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  runOrchestrationRuntimeTool,
  seedAgentDir,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);

async function initializeGitWorkspace(path: string): Promise<void> {
  const git = (...args: string[]) =>
    execFileAsync("git", args, { cwd: path, env: { ...process.env, GIT_DIR: undefined } });
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Lancer Test");
  await git("config", "user.email", "test@example.com");
  await writeFile(join(path, "seed.txt"), "seed\n");
  await git("add", "seed.txt");
  await git("commit", "-qm", "seed");
}

async function startHangingOpenAiServer(): Promise<{
  readonly baseUrl: string;
  readonly pendingRequestCount: () => number;
  readonly close: () => Promise<void>;
}> {
  const pending = new Set<import("node:http").ServerResponse>();
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((request, response) => {
    pending.add(response);
    response.on("close", () => pending.delete(response));
    request.resume();
    // Intentionally leave the response pending: create_child_thread must return
    // after the running acknowledgement rather than await this model turn.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    pendingRequestCount: () => pending.size,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function selectedSessionRef(
  window: Parameters<typeof getDesktopState>[0],
): Promise<SessionRef> {
  const state = await getDesktopState(window);
  if (!state.selectedWorkspaceId || !state.selectedSessionId) {
    throw new Error("Expected a selected session");
  }
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}

test("create_child_thread returns after a slow worker starts, before its turn completes", async () => {
  test.setTimeout(60_000);
  const proofDir = process.env.PI_APP_ORCHESTRATION_PROOF_DIR?.trim();
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
  }
  const server = await startHangingOpenAiServer();
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("orchestration-runtime-start-ack");
  await initializeGitWorkspace(workspacePath);
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["slow-test/slow"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "slow-test",
        defaultModel: "slow",
        enabledModels: ["slow-test/slow"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          "slow-test": {
            baseUrl: server.baseUrl,
            api: "openai-completions",
            apiKey: "unused",
            models: [{ id: "slow" }],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Parent orchestration thread");
    const parentRef = await selectedSessionRef(window);
    const prompt = "Keep this delegated worker running slowly.";
    // The server never answers, so the child's first turn cannot complete. A tool
    // that awaited the turn would never return, and the test timeout names this step.
    const result = await test.step("create_child_thread returns while the turn is in flight", () =>
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "create-child-start-ack",
        sessionRef: parentRef,
        params: { prompt },
      }));

    expect(result.details).toMatchObject({ deliveryStatus: "running", prompt });
    // The worker's model request reached the server and is still unanswered.
    await expect.poll(() => server.pendingRequestCount()).toBeGreaterThan(0);
    const child = (await getDesktopState(window)).orchestrationChildren.find(
      (entry) => entry.sourceToolCallId === "create-child-start-ack",
    );
    if (!child) throw new Error("Expected the delegated child thread to exist.");
    expect(child.status).toBe("running");
    expect(result.details).toMatchObject({ isolation: "worktree" });
    const mergeWhileRunning = await runOrchestrationRuntimeTool(harness, {
      toolName: "merge_child_thread",
      toolCallId: "merge-running-child",
      sessionRef: parentRef,
      params: {
        thread_id: child.id,
        completed_sha: "a".repeat(40),
      },
    });
    expect(mergeWhileRunning.details).toMatchObject({
      error: "Wait for the child thread to finish and return a completion before merging.",
    });
    const state = await getDesktopState(window);
    const childSession = state.workspaces
      .flatMap((workspace) => workspace.sessions)
      .find((session) => session.id === child?.childSessionId);
    expect(childSession?.worktree?.branch).toBe(`lancer/${child?.childSessionId}`);
    expect(childSession?.worktree?.path).not.toBe(workspacePath);
    const catalog = JSON.parse(await readFile(join(userDataDir, "catalogs.json"), "utf8")) as {
      sessions: Array<{
        sessionRef: { sessionId: string };
        executionCwd?: string;
        worktreePath?: string;
      }>;
    };
    const childCatalogEntry = catalog.sessions.find(
      (entry) => entry.sessionRef.sessionId === child?.childSessionId,
    );
    expect(childCatalogEntry?.executionCwd).toBe(childSession?.worktree?.path);
    const childRunningIndicator = window.locator(`.lhc[data-l="lane:${child?.childSessionId}"] .s`);
    await expect(childRunningIndicator).toBeVisible();
    await expect(childRunningIndicator).toHaveText("运行中");
    if (proofDir) {
      await window.screenshot({
        path: join(proofDir, "orchestration-child-running.png"),
        fullPage: true,
      });
    }
  } finally {
    await harness.close();
    await server.close();
  }
});

test("shared child inherits a parent worktree execution directory", async () => {
  test.setTimeout(60_000);
  const server = await startHangingOpenAiServer();
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("orchestration-shared-parent-worktree");
  await initializeGitWorkspace(workspacePath);
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["slow-test/slow"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "slow-test",
      defaultModel: "slow",
      enabledModels: ["slow-test/slow"],
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "slow-test": {
          baseUrl: server.baseUrl,
          api: "openai-completions",
          apiKey: "unused",
          models: [{ id: "slow" }],
        },
      },
    }),
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const initial = await getDesktopState(window);
    const workspaceId = initial.workspaces.find((entry) => entry.path === workspacePath)?.id;
    expect(workspaceId).toBeTruthy();
    await window.evaluate(async (rootWorkspaceId) => {
      const app = globalThis.window.piApp;
      if (!app) throw new Error("piApp IPC bridge is unavailable");
      await app.startThread({
        rootWorkspaceId,
        environment: "local",
        useWorktree: true,
        prompt: "",
      });
    }, workspaceId!);
    const parentRef = await selectedSessionRef(window);
    const parentState = await getDesktopState(window);
    const parent = parentState.workspaces
      .flatMap((workspace) => workspace.sessions)
      .find((session) => session.id === parentRef.sessionId);
    expect(parent?.worktree?.path).toBeTruthy();

    const result = await runOrchestrationRuntimeTool(harness, {
      toolName: "create_child_thread",
      toolCallId: "create-shared-child",
      sessionRef: parentRef,
      params: { prompt: "Read-only inspection only.", isolation: "shared" },
    });
    expect(result.details).toMatchObject({ isolation: "shared", deliveryStatus: "running" });
    await expect.poll(() => server.pendingRequestCount()).toBeGreaterThan(0);

    const current = await getDesktopState(window);
    const child = current.orchestrationChildren.find(
      (entry) => entry.sourceToolCallId === "create-shared-child",
    );
    const childSession = current.workspaces
      .flatMap((workspace) => workspace.sessions)
      .find((session) => session.id === child?.childSessionId);
    expect(childSession?.worktree).toBeUndefined();
    const catalog = JSON.parse(await readFile(join(userDataDir, "catalogs.json"), "utf8")) as {
      sessions: Array<{
        sessionRef: { sessionId: string };
        executionCwd?: string;
        worktreePath?: string;
      }>;
    };
    const childCatalogEntry = catalog.sessions.find(
      (entry) => entry.sessionRef.sessionId === child?.childSessionId,
    );
    expect(childCatalogEntry?.executionCwd).toBe(parent?.worktree?.path);
    expect(childCatalogEntry?.executionCwd).not.toBe(workspacePath);
  } finally {
    await harness.close();
    await server.close();
  }
});

test("create_child_thread surfaces deterministic initial-prompt delivery failures", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("orchestration-runtime-tools");
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Parent orchestration thread");
    const parentRef = await selectedSessionRef(window);
    const prompt = "Child must start this delegated task.";

    await expect(
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "create-child-delivery-failure",
        sessionRef: parentRef,
        params: { prompt },
      }),
    ).rejects.toThrow(/API key|authentication|credential/i);

    const state = await getDesktopState(window);
    const matchingChildren = state.orchestrationChildren.filter(
      (entry) => entry.sourceToolCallId === "create-child-delivery-failure",
    );
    expect(matchingChildren).toHaveLength(1);
    expect(matchingChildren[0]?.status).toBe("failed");
    expect(matchingChildren[0]?.latestTranscript).toMatch(/API key|authentication|credential/i);
    expect(matchingChildren[0]?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Initial prompt delivery failed", status: "failed" }),
      ]),
    );

    // Replaying the same tool call must re-surface the failed launch, not treat
    // the already-created session record as proof of success or create a duplicate.
    await expect(
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "create-child-delivery-failure",
        sessionRef: parentRef,
        params: { prompt },
      }),
    ).rejects.toThrow(/API key|authentication|credential/i);
    expect(
      (await getDesktopState(window)).orchestrationChildren.filter(
        (entry) => entry.sourceToolCallId === "create-child-delivery-failure",
      ),
    ).toHaveLength(1);
  } finally {
    await harness.close();
  }
});
