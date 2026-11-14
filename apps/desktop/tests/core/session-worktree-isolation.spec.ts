import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  runOrchestrationRuntimeTool,
  seedAgentDir,
  selectSession,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("a child of an own-worktree session executes in the parent checkout", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeGitWorkspace("child-worktree-isolation");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["isolation-fixture/scripted"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "isolation-fixture",
        defaultModel: "scripted",
        enabledModels: ["isolation-fixture/scripted"],
        packages: [],
        compaction: { enabled: false },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(agentDir, "auth.json"),
    `${JSON.stringify({ "isolation-fixture": { type: "api_key", key: "LOCAL_FIXTURE" } }, null, 2)}\n`,
  );
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(
    join(agentDir, "extensions", "isolation-fixture.ts"),
    `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export default function isolationFixture(pi) {
  pi.on("input", async (event, ctx) => {
    if (!String(event.text || "").includes("CHILD_ISOLATION_MARKER")) return;
    await writeFile(join(ctx.cwd, "child-execution-cwd.txt"), String(ctx.cwd));
  });
  pi.registerProvider("isolation-fixture", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_FIXTURE",
    api: "isolation-fixture",
    models: [{ id: "scripted", name: "Isolation fixture", reasoning: false, input: ["text"], contextWindow: 8000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }],
    streamSimple(model) {
      const text = "CHILD_ISOLATION_DONE";
      const message = { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
  });
}
`,
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    const workspaceId = (await getDesktopState(window)).selectedWorkspaceId;
    expect(workspaceId).toBeTruthy();
    await window.evaluate(
      async ({ id }) => {
        const app = globalThis.window.piApp;
        if (!app) throw new Error("piApp IPC bridge is unavailable");
        await app.createSession({
          workspaceId: id,
          title: "Isolated parent",
          useWorktree: true,
        });
      },
      { id: workspaceId! },
    );
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.workspaces
          .flatMap((workspace) => workspace.sessions)
          .find((session) => session.id === state.selectedSessionId)?.worktree?.path;
      })
      .toBeTruthy();
    const parentState = await getDesktopState(window);
    const parent = parentState.workspaces
      .flatMap((workspace) => workspace.sessions)
      .find((session) => session.id === parentState.selectedSessionId);
    const parentRef = {
      workspaceId: parentState.selectedWorkspaceId!,
      sessionId: parentState.selectedSessionId!,
    };
    const worktreePath = parent?.worktree?.path;
    expect(worktreePath).toBeTruthy();

    await runOrchestrationRuntimeTool(harness, {
      toolName: "create_child_thread",
      toolCallId: "child-isolation",
      sessionRef: parentRef,
      params: { prompt: "CHILD_ISOLATION_MARKER write only inside the parent checkout" },
    });

    const markerPath = join(worktreePath!, "child-execution-cwd.txt");
    await expect
      .poll(async () =>
        access(markerPath).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    const parentCheckout = await realpath(worktreePath!);
    expect(await realpath((await readFile(markerPath, "utf8")).trim())).toBe(parentCheckout);
    await expect(access(join(workspacePath, "child-execution-cwd.txt"))).rejects.toThrow();
    const child = (await getDesktopState(window)).orchestrationChildren.find(
      (entry) => entry.sourceToolCallId === "child-isolation",
    );
    expect(child?.childSessionId).toBeTruthy();
    const childSession = (await getDesktopState(window)).workspaces
      .flatMap((workspace) => workspace.sessions)
      .find((session) => session.id === child?.childSessionId);
    expect(childSession?.executionCwd).toBeTruthy();
    expect(await realpath(childSession!.executionCwd!)).toBe(parentCheckout);
    expect(childSession?.worktree).toBeUndefined();
  } finally {
    await harness.close();
  }
});

test("merge and discard refuse a running own-worktree session", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeGitWorkspace("worktree-race");
  const releasePath = join(workspacePath, "release-worktree-race");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["race-fixture/scripted"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "race-fixture",
        defaultModel: "scripted",
        enabledModels: ["race-fixture/scripted"],
        packages: [],
        compaction: { enabled: false },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(agentDir, "auth.json"),
    `${JSON.stringify({ "race-fixture": { type: "api_key", key: "LOCAL_FIXTURE" } }, null, 2)}\n`,
  );
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(
    join(agentDir, "extensions", "race-fixture.ts"),
    `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { access } from "node:fs/promises";
export default function raceFixture(pi) {
  pi.registerProvider("race-fixture", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_FIXTURE",
    api: "race-fixture",
    models: [{ id: "scripted", name: "Race fixture", reasoning: false, input: ["text"], contextWindow: 8000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }],
    streamSimple(model, context) {
      const index = context.messages.findLastIndex((message) => message.role === "user");
      const prompt = context.messages[index]?.content?.filter((part) => part.type === "text").map((part) => part.text).join(" ") || "";
      const text = "RACE_DONE";
      const message = { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      (async () => {
        if (prompt.includes("HOLD_WORKTREE")) {
          while (true) {
            try { await access(${JSON.stringify(releasePath)}); break; } catch {}
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        stream.push({ type: "done", reason: "stop", message });
      })().catch((error) => stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: String(error) } }));
      return stream;
    },
  });
}
`,
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    const workspaceId = (await getDesktopState(window)).selectedWorkspaceId!;
    await window.evaluate(
      async ({ id }) => {
        const app = globalThis.window.piApp;
        if (!app) throw new Error("piApp IPC bridge is unavailable");
        await app.createSession({ workspaceId: id, title: "Race parent", useWorktree: true });
      },
      { id: workspaceId },
    );
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.workspaces
          .flatMap((workspace) => workspace.sessions)
          .find((session) => session.id === state.selectedSessionId)?.worktree?.path;
      })
      .toBeTruthy();
    const before = await getDesktopState(window);
    const session = before.workspaces
      .flatMap((workspace) => workspace.sessions)
      .find((entry) => entry.id === before.selectedSessionId);
    const worktreePath = session?.worktree?.path;
    expect(worktreePath).toBeTruthy();
    const target = {
      workspaceId: before.selectedWorkspaceId!,
      sessionId: before.selectedSessionId!,
    };

    await expect(window.getByTestId("composer")).toBeVisible();
    await window.getByTestId("composer").fill("HOLD_WORKTREE");
    await window.getByTestId("send").click();
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.workspaces
          .flatMap((workspace) => workspace.sessions)
          .find((entry) => entry.id === target.sessionId)?.status;
      })
      .toBe("running");

    const overlap = (operation: "mergeSessionWorktree" | "discardSessionWorktree") =>
      harness.electronApp.evaluate(
        async (_, payload) => {
          const hooks = (
            globalThis as {
              __PI_APP_TEST_HOOKS?: Record<
                string,
                (sessionTarget: {
                  workspaceId: string;
                  sessionId: string;
                }) => Promise<{ lastError?: string }>
              >;
            }
          ).__PI_APP_TEST_HOOKS;
          const run = hooks?.[payload.operation];
          if (!run) throw new Error(`${payload.operation} test hook is unavailable`);
          return run(payload.target);
        },
        { operation, target },
      );
    const mergeState = await overlap("mergeSessionWorktree");
    const discardState = await overlap("discardSessionWorktree");
    expect(mergeState.lastError).toMatch(/Stop the session|being merged|in use/i);
    expect(discardState.lastError).toMatch(/Stop the session|being discarded|in use/i);
    expect(await readFile(join(worktreePath!, "README.md"), "utf8")).toContain("worktree-race");
    expect(await readFile(join(workspacePath, "README.md"), "utf8")).toContain("worktree-race");

    await writeFile(releasePath, "go\n");
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.workspaces
          .flatMap((workspace) => workspace.sessions)
          .find((entry) => entry.id === target.sessionId)?.status;
      })
      .toBe("idle");
    await selectSession(window, "Race parent");
    const discarded = await window.evaluate(async (sessionTarget) => {
      const app = globalThis.window.piApp;
      if (!app) throw new Error("piApp IPC bridge is unavailable");
      return app.discardSessionWorktree(sessionTarget);
    }, target);
    expect(discarded.lastError).toBeUndefined();
    await expect(access(join(worktreePath!, "README.md"))).rejects.toThrow();
    expect(await readFile(join(workspacePath, "README.md"), "utf8")).toContain("worktree-race");
    const repeated = await window.evaluate(async (sessionTarget) => {
      const app = globalThis.window.piApp;
      if (!app) throw new Error("piApp IPC bridge is unavailable");
      return app.discardSessionWorktree(sessionTarget);
    }, target);
    expect(repeated.lastError).toMatch(/no git worktree/i);
    expect(await readFile(join(workspacePath, "README.md"), "utf8")).toContain("worktree-race");
  } finally {
    await harness.close();
  }
});
