import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { createEmptyDesktopAppState, type DesktopAppState } from "../../contracts/desktop-state";
import { ControlService } from "../../electron/control/control-service";
import { ControlServer } from "../../electron/control/control-server";
import { decodePersistedUiState } from "../../electron/persistence/app-store-persistence";

const exec = promisify(execFile);
const cli = resolve("scripts/lancer-ctl.mjs");

function fixture() {
  let state: DesktopAppState = {
    ...createEmptyDesktopAppState(),
    workspaces: [
      {
        id: "ws",
        name: "Partition",
        path: "/tmp/workspace",
        kind: "primary",
        sessions: [
          {
            id: "a",
            title: "Alpha task",
            updatedAt: "2026-01-01",
            preview: "",
            status: "idle",
            hasUnseenUpdate: false,
            config: { provider: "fixture", modelId: "model" },
          },
          {
            id: "b",
            title: "Alpha other",
            updatedAt: "2026-01-01",
            preview: "",
            status: "idle",
            hasUnseenUpdate: false,
          },
        ],
      },
    ],
  };
  const deliveries: unknown[] = [];
  let finish: (state: DesktopAppState) => void = () => {};
  const service = new ControlService(
    {
      snapshot: () => state,
      getStateForView: async () => state,
      getSelectedTranscriptForView: async () => ({
        workspaceId: "ws",
        sessionId: "a",
        transcript: [
          { id: "u", kind: "message", role: "user", text: "question", createdAt: "now" },
          {
            id: "r",
            kind: "message",
            role: "assistant",
            text: "FULL assistant reply\nline two",
            createdAt: "now",
          },
          { id: "p", kind: "activity", label: "Finished", createdAt: "now" },
        ],
      }),
      setSessionThinkingLevel: async (ref, thinkingLevel) => {
        deliveries.push({ ref, thinkingLevel });
        if (state.lastError) return state;
        state = {
          ...state,
          workspaces: state.workspaces.map((workspace) => ({
            ...workspace,
            sessions: workspace.sessions.map((session) =>
              workspace.id === ref.workspaceId && session.id === ref.sessionId
                ? { ...session, config: { ...session.config, thinkingLevel } }
                : session,
            ),
          })),
        };
        return state;
      },
      submitControlMessage: (ref, message, mode) => {
        deliveries.push({ ref, message, mode });
        return new Promise<DesktopAppState>((resolveState) => {
          finish = resolveState;
        });
      },
    },
    async (input) => {
      deliveries.push(input);
      return { workspaceId: "ws", sessionId: "a" };
    },
  );
  return {
    service,
    deliveries,
    set: (next: Partial<DesktopAppState>) => {
      state = { ...state, ...next };
    },
    running: () => {
      state = {
        ...state,
        workspaces: state.workspaces.map((workspace) => ({
          ...workspace,
          sessions: workspace.sessions.map((session) => ({
            ...session,
            status: "running" as const,
          })),
        })),
      };
    },
    finish: () => finish(state),
  };
}

test("control resolves exact identity, rejects ambiguous titles and validates input", async () => {
  const f = fixture();
  const { service } = f;
  await expect(service.handle({ operation: "tail", session: "Alpha" })).rejects.toMatchObject({
    code: "AMBIGUOUS_SESSION",
  });
  await expect(service.handle({ operation: "tail", session: "missing" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(service.handle({ operation: "tail", session: "ws:a", n: 0 })).rejects.toMatchObject({
    code: "INVALID_REQUEST",
  });
  await expect(
    service.handle({ operation: "send", session: "a", message: " " }),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(
    service.handle({ operation: "send", session: "a", message: "/new" }),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(
    service.handle({ operation: "send", session: "a", message: "hi", mode: "bad" }),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(
    service.handle({ operation: "new", cwd: "/tmp", message: "hi", model: "bad" }),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(
    service.handle({ operation: "new", cwd: "/tmp", message: "hi", zone: "invalid" }),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(
    service.handle({ operation: "new", cwd: "/tmp", message: "hi", worktree: "yes" }),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  f.set({
    globalModelSettings: {
      defaultProvider: "default",
      defaultModelId: "model",
      enabledModelPatterns: [],
    },
  });
  expect(await service.handle({ operation: "sessions" })).toMatchObject({
    sessions: [
      { id: "a", model: "fixture/model", modelSource: "session", zoneId: "chat" },
      { id: "b", model: "default/model", modelSource: "workspace-default" },
    ],
  });
  expect(await service.handle({ operation: "tail", session: "Alpha task", n: 1 })).toMatchObject({
    done: true,
    lastAssistant: "FULL assistant reply\nline two",
    messages: [{ kind: "activity", label: "Finished" }],
    session: { id: "a", workspace: "Partition", cwd: "/tmp/workspace", model: "fixture/model" },
  });
});

test("set-thinking targets existing sessions, validates levels and surfaces owner failures", async () => {
  const f = fixture();
  for (const thinkingLevel of [undefined, null, 1, "", "HIGH", "invalid"])
    await expect(
      f.service.handle({ operation: "set-thinking", session: "a", thinkingLevel }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  for (const [session, code] of [
    ["Alpha", "AMBIGUOUS_SESSION"],
    ["missing", "NOT_FOUND"],
  ])
    await expect(
      f.service.handle({ operation: "set-thinking", session, thinkingLevel: "high" }),
    ).rejects.toMatchObject({ code });
  expect(f.deliveries).toEqual([]);
  for (const thinkingLevel of ["off", "minimal", "low", "medium", "high", "xhigh", "max"])
    expect(
      await f.service.handle({ operation: "set-thinking", session: "Alpha task", thinkingLevel }),
    ).toEqual({ session: { workspaceId: "ws", sessionId: "a" }, thinkingLevel });
  expect(f.deliveries).toHaveLength(7);
  expect(f.deliveries[4]).toEqual({
    ref: { workspaceId: "ws", sessionId: "a" },
    thinkingLevel: "high",
  });
  expect(await f.service.handle({ operation: "sessions" })).toMatchObject({
    sessions: [
      { id: "a", thinkingLevel: "max" },
      { id: "b", thinkingLevel: null },
    ],
  });
  f.set({ lastError: "Runtime rejected thinking change" });
  await expect(
    f.service.handle({ operation: "set-thinking", session: "ws:a", thinkingLevel: "high" }),
  ).rejects.toThrow("Runtime rejected thinking change");
  f.set({ localControlEnabled: false });
  await expect(
    f.service.handle({ operation: "set-thinking", session: "a", thinkingLevel: "high" }),
  ).rejects.toMatchObject({ code: "DISABLED" });
  expect(f.deliveries).toHaveLength(8);
});

test("send acknowledges asynchronously, wait includes startup, queue/steer route through composer", async () => {
  const f = fixture();
  expect(
    await f.service.handle({ operation: "send", session: "a", message: "hello" }),
  ).toMatchObject({ accepted: true, mode: "send" });
  expect(await f.service.handle({ operation: "wait", session: "a" })).toMatchObject({
    done: false,
    session: { pending: 1 },
  });
  await expect(
    f.service.handle({ operation: "send", session: "a", message: "again" }),
  ).rejects.toMatchObject({ code: "SESSION_BUSY" });
  await expect(
    f.service.handle({ operation: "send", session: "a", message: "again", mode: "queue" }),
  ).rejects.toMatchObject({ code: "SESSION_STARTING" });
  f.finish();
  await expect
    .poll(
      async () =>
        ((await f.service.handle({ operation: "wait", session: "a" })) as { done: boolean }).done,
    )
    .toBe(true);
  f.running();
  await expect(
    f.service.handle({ operation: "send", session: "a", message: "busy" }),
  ).rejects.toMatchObject({ code: "SESSION_BUSY" });
  await f.service.handle({ operation: "send", session: "a", message: "queued", mode: "queue" });
  f.finish();
  await f.service.handle({ operation: "send", session: "a", message: "steering", mode: "steer" });
  expect(f.deliveries).toEqual([
    { ref: { workspaceId: "ws", sessionId: "a" }, message: "hello", mode: "followUp" },
    { ref: { workspaceId: "ws", sessionId: "a" }, message: "queued", mode: "followUp" },
    { ref: { workspaceId: "ws", sessionId: "a" }, message: "steering", mode: "steer" },
  ]);
  f.finish();
});

test("waiting UI, failures, creation and disabled preference are explicit", async () => {
  const f = fixture();
  f.set({
    sessionExtensionUiBySession: {
      "ws:a": {
        instanceId: "x",
        pendingDialogs: [
          {
            kind: "confirm",
            requestId: "permission",
            title: "Approve",
            message: "Tool permission",
          },
        ],
        widgets: [],
        statuses: [],
      },
    },
  });
  expect(await f.service.handle({ operation: "wait", session: "a" })).toMatchObject({
    done: false,
    session: { status: "waiting" },
  });
  f.set({ sessionExtensionUiBySession: {}, lastError: "provider rejected" });
  expect(await f.service.handle({ operation: "wait", session: "a" })).toMatchObject({
    done: true,
    outcome: "failed",
    error: "provider rejected",
  });
  expect(
    await f.service.handle({
      operation: "new",
      cwd: "/tmp/new",
      name: "new",
      model: "fixture/model",
      message: "begin",
    }),
  ).toMatchObject({ accepted: true });
  expect(f.deliveries[0]).toEqual({ cwd: "/tmp/new", name: "new", model: "fixture/model" });
  f.finish();
  f.set({ localControlEnabled: false });
  await expect(f.service.handle({ operation: "sessions" })).rejects.toMatchObject({
    code: "DISABLED",
  });
  expect(
    decodePersistedUiState({ version: 19, localControlEnabled: false }).localControlEnabled,
  ).toBe(false);
  expect(() => decodePersistedUiState({ version: 19, localControlEnabled: "false" })).toThrow();
});

function rawCall(socketPath: string, token: string, body: string) {
  return new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
    const req = request(
      { socketPath, path: "/v1", method: "POST", headers: { Authorization: `Bearer ${token}` } },
      (response) => {
        let result = "";
        response.on("data", (chunk: Buffer) => {
          result += chunk.toString();
        });
        response.on("end", () =>
          resolveResponse({ status: response.statusCode ?? 0, body: result }),
        );
        response.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("Unix socket authenticates, protects files, runs CLI and closes without fallback", async () => {
  test.skip(process.platform === "win32", "Unix transport");
  const directory = await mkdtemp("/tmp/lancer-control-");
  const f = fixture();
  const server = new ControlServer(directory, (input) => f.service.handle(input));
  try {
    await server.setEnabled(true);
    const token = (await readFile(server.tokenPath, "utf8")).trim();
    expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(server.tokenPath)).mode & 0o777).toBe(0o600);
    expect((await rawCall(server.socketPath, "wrong", "{}")).status).toBe(401);
    expect((await rawCall(server.socketPath, token, "not json")).status).toBe(400);
    expect((await rawCall(server.socketPath, token, "x".repeat(1024 * 1024 + 64))).status).toBe(
      413,
    );
    expect(
      (await rawCall(server.socketPath, token, JSON.stringify({ operation: "sessions" }))).status,
    ).toBe(200);
    const listed = await exec(process.execPath, [
      cli,
      "sessions",
      "--json",
      "--user-data-dir",
      directory,
    ]);
    expect((JSON.parse(listed.stdout) as { sessions: unknown[] }).sessions).toHaveLength(2);
    await expect(
      exec(process.execPath, [cli, "send", "Alpha", "hi", "--user-data-dir", directory]),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("AMBIGUOUS_SESSION") });
    const file = join(directory, "message.txt");
    await writeFile(file, "hello from file\nline 2");
    const sent = await exec(process.execPath, [
      cli,
      "send",
      "a",
      "--file",
      file,
      "--user-data-dir",
      directory,
    ]);
    expect((JSON.parse(sent.stdout) as { accepted: boolean }).accepted).toBe(true);
    f.finish();
    const tail = await exec(process.execPath, [
      cli,
      "tail",
      "a",
      "-n",
      "1",
      "--json",
      "--user-data-dir",
      directory,
    ]);
    expect((JSON.parse(tail.stdout) as { lastAssistant: string }).lastAssistant).toContain(
      "FULL assistant reply",
    );
    const waited = await exec(process.execPath, [
      cli,
      "wait",
      "a",
      "--timeout",
      "2",
      "--user-data-dir",
      directory,
    ]);
    expect((JSON.parse(waited.stdout) as { done: boolean }).done).toBe(true);
    f.running();
    await expect(
      exec(process.execPath, [cli, "wait", "a", "--timeout", "0.1", "--user-data-dir", directory]),
    ).rejects.toMatchObject({ code: 2, stdout: expect.stringContaining('"timedOut": true') });
    await server.setEnabled(false);
    await expect(
      exec(process.execPath, [cli, "sessions", "--user-data-dir", directory]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("not running or local control is disabled"),
    });
    await server.setEnabled(true);
    expect((await readFile(server.tokenPath, "utf8")).trim()).toBe(token);
    const competitor = new ControlServer(directory, async () => ({}));
    await expect(competitor.setEnabled(true)).rejects.toThrow("already in use");
  } finally {
    await server.setEnabled(false);
  }
});

test("transport recovers only a stale owned socket after an owned process exits", async () => {
  test.skip(process.platform === "win32", "Unix transport");
  const directory = await mkdtemp("/tmp/lancer-control-");
  const server = new ControlServer(directory, async () => ({}));
  const child = spawn(
    process.execPath,
    [
      "-e",
      'require("node:net").createServer().listen(process.argv[1], () => console.log("ready"))',
      server.socketPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await once(child.stdout, "data");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    expect((await stat(server.socketPath)).isSocket()).toBe(true);
    await server.setEnabled(true);
    expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await server.setEnabled(false);
  }
});

test("transport refuses to overwrite a non-socket or insecure token", async () => {
  test.skip(process.platform === "win32", "Unix transport");
  const directory = await mkdtemp("/tmp/lancer-control-");
  const server = new ControlServer(directory, async () => ({}));
  await writeFile(server.tokenPath, "a".repeat(64), { mode: 0o644 });
  await expect(server.setEnabled(true)).rejects.toThrow("0600");
  const other = await mkdtemp("/tmp/lancer-control-");
  const second = new ControlServer(other, async () => ({}));
  await writeFile(second.socketPath, "retained sentinel");
  await expect(second.setEnabled(true)).rejects.toThrow("Refusing to replace");
  expect(await readFile(second.socketPath, "utf8")).toBe("retained sentinel");
});

test("draft creation never dispatches a model message and rejects mixed intent", async () => {
  const f = fixture();
  await expect(
    f.service.handle({
      operation: "new",
      draft: true,
      cwd: "/tmp",
      zone: "video",
      name: "待办 · 下载视频",
    }),
  ).resolves.toMatchObject({ created: true, started: false, workspaceId: "ws", sessionId: "a" });
  expect(f.deliveries).toEqual([
    { cwd: "/tmp", name: "lancer-zone:video|待办 · 下载视频", model: undefined },
  ]);
  await expect(
    f.service.handle({ operation: "new", draft: true, cwd: "/tmp", message: "do work" }),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(
    f.service.handle({ operation: "new", draft: "yes", cwd: "/tmp" }),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  expect(f.deliveries).toHaveLength(1);
});

test("new forwards a worktree request and reports none until the app records one", async () => {
  const f = fixture();
  await expect(
    f.service.handle({
      operation: "new",
      cwd: "/tmp",
      draft: true,
      name: "isolated",
      worktree: true,
    }),
  ).resolves.toMatchObject({ created: true, started: false, worktree: null });
  expect(f.deliveries.at(-1)).toEqual({
    cwd: "/tmp",
    model: undefined,
    name: "isolated",
    worktree: true,
  });
});
