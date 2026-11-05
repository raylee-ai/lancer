import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { request, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { SessionRef, SessionRuntimeMetadata } from "@lancer/session-driver";
import { createEmptyDesktopAppState, type DesktopAppState } from "../../contracts/desktop-state";
import { ControlService } from "../../electron/control/control-service";
import { ControlServer } from "../../electron/control/control-server";
import { ControlStream } from "../../electron/control/control-stream";

// Node-only API proof. No renderer state shortcuts or Electron/provider claims.
const a = { workspaceId: "ws", sessionId: "a" };
const b = { workspaceId: "ws", sessionId: "b" };
const timestamp = "2026-01-01T00:00:00.000Z";

function fixture(cwd = "/tmp/workspace") {
  const state: DesktopAppState = {
    ...createEmptyDesktopAppState(),
    workspaces: [
      {
        id: "ws",
        name: "Workspace",
        path: cwd,
        kind: "primary",
        sessions: ["a", "b"].map((id) => ({
          id,
          title: `Task ${id}`,
          updatedAt: timestamp,
          preview: "",
          status: "idle" as const,
          hasUnseenUpdate: false,
          config: { provider: "fixture", modelId: "model" },
        })),
      },
    ],
  };
  const metadata = new Map<string, SessionRuntimeMetadata>();
  const updates: { ref: SessionRef; patch: Partial<SessionRuntimeMetadata> }[] = [];
  const order: string[] = [];
  const created: unknown[] = [];
  const deliveries: unknown[] = [];
  const cancellations: SessionRef[] = [];
  let cancel = async () => state;
  const service = new ControlService(
    {
      snapshot: () => state,
      getStateForView: async () => state,
      getSelectedTranscriptForView: async () => ({ ...a, transcript: [] }),
      submitControlMessage: async (ref, message, mode) => {
        order.push("send");
        deliveries.push({ ref, message, mode });
        return state;
      },
      getControlMetadata: async (ref: SessionRef) => metadata.get(ref.sessionId) ?? {},
      updateControlMetadata: async (ref: SessionRef, patch: Partial<SessionRuntimeMetadata>) => {
        order.push("metadata");
        updates.push({ ref, patch });
        metadata.set(ref.sessionId, { ...metadata.get(ref.sessionId), ...patch });
      },
      cancelCurrentRun: (ref: SessionRef | undefined) => {
        if (!ref) throw new Error("Stop must target an explicit session");
        cancellations.push(ref);
        return cancel();
      },
    },
    async (input) => {
      order.push("create");
      created.push(input);
      return a;
    },
  );
  return {
    service,
    metadata,
    updates,
    created,
    deliveries,
    cancellations,
    order,
    state,
    setCancel: (callback: () => Promise<DesktopAppState>) => {
      cancel = callback;
    },
  };
}

test("lanes filters catalog metadata and leaves unknown runtime values null", async () => {
  const f = fixture();
  f.metadata.set("a", {
    laneGroup: "group",
    orchestratorId: "lead",
    role: "lane",
    stage: "test",
    progress: 0.25,
  });
  expect(await f.service.handle({ operation: "lanes", group: "group" })).toMatchObject({
    lanes: [
      {
        id: "a",
        title: "Task a",
        model: "fixture/model",
        status: "idle",
        laneGroup: "group",
        orchestratorId: "lead",
        role: "lane",
        stage: "test",
        progress: 0.25,
        startedAt: null,
        finishedAt: null,
        elapsed: null,
        resultPath: null,
        lastLine: null,
      },
    ],
  });
  expect(await f.service.handle({ operation: "lanes", group: "absent" })).toEqual({ lanes: [] });
  expect(await f.service.handle({ operation: "lanes" })).toMatchObject({
    lanes: [{ id: "a" }, { id: "b", stage: null, progress: null, resultPath: null }],
  });
  await expect(f.service.handle({ operation: "lanes", group: "" })).rejects.toMatchObject({
    code: "INVALID_REQUEST",
  });
});

test("new saves group/orchestrator/role before dispatch and drafts never send", async () => {
  for (const draft of [false, true]) {
    const f = fixture();
    const result = await f.service.handle({
      operation: "new",
      cwd: "/tmp/workspace",
      name: "Lane",
      group: "g",
      orchestrator: "leader",
      role: "lane",
      ...(draft ? { draft: true } : { message: "work" }),
    });
    expect(result).toMatchObject(draft ? { created: true, started: false } : { accepted: true });
    expect(f.metadata.get("a")).toEqual({ laneGroup: "g", orchestratorId: "leader", role: "lane" });
    expect(f.created).toEqual([{ cwd: "/tmp/workspace", name: "Lane", model: undefined }]);
    expect(f.deliveries).toHaveLength(draft ? 0 : 1);
    expect(f.order).toEqual(draft ? ["create", "metadata"] : ["create", "metadata", "send"]);
  }
  const legacy = fixture();
  await legacy.service.handle({ operation: "new", cwd: "/tmp/workspace", draft: true });
  expect(legacy.updates).toEqual([]);
  for (const fields of [{ role: "invalid" }, { group: "" }, { orchestrator: 42 }]) {
    await expect(
      legacy.service.handle({ operation: "new", cwd: "/tmp", draft: true, ...fields }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  }
  expect(legacy.created).toHaveLength(1);
});

test("new infers lane roles only for grouped creation", async () => {
  for (const [fields, role] of [
    [{ group: "g" }, "lead"],
    [{ group: "g", orchestrator: "leader" }, "lane"],
    [{ group: "g", orchestrator: "leader", role: "lead" }, "lead"],
  ] as const) {
    const f = fixture();
    await f.service.handle({ operation: "new", cwd: "/tmp", draft: true, ...fields });
    expect(f.metadata.get("a")?.role).toBe(role);
  }
});

test("optional store capabilities preserve reads and reject unsupported writes", async () => {
  const { state } = fixture();
  const service = new ControlService(
    {
      snapshot: () => state,
      getStateForView: async () => state,
      getSelectedTranscriptForView: async () => ({ ...a, transcript: [] }),
      submitControlMessage: async () => state,
    },
    async () => a,
  );
  expect(await service.handle({ operation: "lanes" })).toMatchObject({
    lanes: [{ id: "a" }, { id: "b" }],
  });
  for (const input of [
    { operation: "stop", session: "a" },
    { operation: "set-stage", session: "a", stage: "test" },
  ])
    await expect(service.handle(input)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});

test("set-stage persists boundaries, clears null and preserves omitted fields", async () => {
  const f = fixture();
  await f.service.handle({
    operation: "set-stage",
    session: "ws:a",
    stage: "testing",
    progress: 0,
  });
  expect(f.metadata.get("a")).toMatchObject({ stage: "testing", progress: 0 });
  await f.service.handle({ operation: "set-stage", session: "a", progress: 1 });
  expect(f.metadata.get("a")).toMatchObject({ stage: "testing", progress: 1 });
  await f.service.handle({ operation: "set-stage", session: "a", stage: null });
  expect(f.metadata.get("a")).toMatchObject({ stage: null, progress: 1 });
  await f.service.handle({ operation: "set-stage", session: "a", progress: null });
  expect(f.metadata.get("a")).toMatchObject({ stage: null, progress: null });
});

test("invalid stage/progress never mutate metadata", async () => {
  const f = fixture();
  for (const fields of [
    { stage: "x".repeat(121) },
    { stage: " " },
    { stage: 12 },
    ...[-0.1, 1.1, NaN, Infinity, "0.5"].map((progress) => ({ progress })),
  ]) {
    await expect(
      f.service.handle({ operation: "set-stage", session: "a", ...fields }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  }
  expect(f.updates).toEqual([]);
});

test("set-result accepts workspace files and rejects traversal, directories and symlink escapes", async () => {
  test.skip(process.platform === "win32", "Unix symlink fixture");
  const root = await mkdtemp("/tmp/lancer-result-");
  const outside = await mkdtemp(`${root}-outside-`);
  await writeFile(join(root, "result.json"), "{}");
  await writeFile(join(outside, "secret.json"), "{}");
  await symlink(join(outside, "secret.json"), join(root, "escape.json"));
  await symlink(outside, join(root, "escape-dir"));
  await symlink(join(root, "result.json"), join(root, "inside.json"));
  const f = fixture(root);
  const canonical = await realpath(join(root, "result.json"));
  for (const path of ["result.json", canonical, "inside.json"]) {
    expect(await f.service.handle({ operation: "set-result", session: "a", path })).toMatchObject({
      session: a,
      resultPath: canonical,
    });
  }
  for (const path of [
    root,
    outside,
    join(outside, "secret.json"),
    "escape.json",
    "escape-dir/secret.json",
    "../",
    "",
  ]) {
    await expect(
      f.service.handle({ operation: "set-result", session: "a", path }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  }
  await expect(
    f.service.handle({ operation: "set-result", session: "a", path: "missing.json" }),
  ).rejects.toThrow();
  expect(f.updates).toHaveLength(3);
  expect(f.metadata.get("a")?.resultPath).toBe(canonical);
});

test("stop coalesces in-flight cancellation and remains idempotent after completion", async () => {
  const f = fixture();
  let release!: (state: DesktopAppState) => void;
  f.setCancel(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = f.service.handle({ operation: "stop", session: "a" });
  const second = f.service.handle({ operation: "stop", session: "ws:a" });
  await expect.poll(() => f.cancellations.length).toBe(1);
  release(f.state);
  expect(await Promise.all([first, second])).toEqual([
    { stopped: true, session: a },
    { stopped: true, session: a },
  ]);
  f.setCancel(async () => f.state);
  expect(await f.service.handle({ operation: "stop", session: "a" })).toEqual({
    stopped: true,
    session: a,
  });
  expect(f.cancellations).toEqual([a, a]);
  f.setCancel(async () => {
    throw new Error("cancel failed");
  });
  await expect(f.service.handle({ operation: "stop", session: "a" })).rejects.toThrow(
    "cancel failed",
  );
  f.setCancel(async () => f.state);
  await expect(f.service.handle({ operation: "stop", session: "a" })).resolves.toMatchObject({
    stopped: true,
  });
});

test("logs redact nested tool secrets, retain output/exit code and resume exclusively", async () => {
  const f = fixture();
  f.service.journal.observe({ type: "assistantDelta", sessionRef: a, timestamp, text: "hello" });
  f.service.journal.observe({
    type: "toolStarted",
    sessionRef: a,
    timestamp,
    callId: "call",
    toolName: "bash",
    input: {
      command: "test",
      apiKey: "hidden-key",
      nested: [{ token: "hidden-token", password: "hidden-password", secret: "hidden-secret" }],
    },
  });
  f.service.journal.observe({
    type: "toolFinished",
    sessionRef: a,
    timestamp,
    callId: "call",
    success: false,
    output: { text: "first line\nsecond line", details: { exitCode: 2 } },
  });
  const events = f.service.journal.logs(a);
  expect(await f.service.handle({ operation: "logs", session: "a" })).toEqual({ events });
  expect(JSON.stringify(events)).not.toMatch(/hidden-/);
  expect(events.find((event) => event.kind === "toolStarted")).toMatchObject({
    toolName: "bash",
    input: { apiKey: "[REDACTED]" },
  });
  expect(events.find((event) => event.kind === "toolFinished")).toMatchObject({
    text: "first line\nsecond line",
    exitCode: 2,
    success: false,
  });
  expect(
    await f.service.handle({ operation: "logs", session: "a", since: events[0]!.seq }),
  ).toEqual({ events: events.slice(1) });
  expect(await f.service.handle({ operation: "logs", session: "b" })).toEqual({ events: [] });
  for (const operation of ["logs", "stream"])
    for (const since of [-1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      await expect(f.service.handle({ operation, session: "a", since })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
    }
});

test("lane projection exposes each runtime status, real timing and last output", async () => {
  const f = fixture();
  for (const status of ["queued", "running", "waiting", "done", "failed", "idle"] as const) {
    f.service.journal.status(a, status, timestamp);
    expect(await f.service.handle({ operation: "lanes" })).toMatchObject({
      lanes: [
        { id: "a", status },
        { id: "b", status: "idle" },
      ],
    });
  }
  f.service.journal.status(a, "running", timestamp);
  f.service.journal.observe({
    type: "assistantDelta",
    sessionRef: a,
    timestamp,
    text: "last output",
  });
  f.service.journal.status(a, "done", "2026-01-01T00:00:02.000Z");
  expect(await f.service.handle({ operation: "lanes" })).toMatchObject({
    lanes: [
      {
        startedAt: timestamp,
        finishedAt: "2026-01-01T00:00:02.000Z",
        elapsed: 2000,
        lastLine: "last output",
      },
      { id: "b" },
    ],
  });
});

function connect(socketPath: string, token: string, input: unknown): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: "/v1",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
      resolve,
    );
    req.on("error", reject);
    req.end(JSON.stringify(input));
  });
}

test("stream POST authenticates, replays then pushes NDJSON and closes when disabled", async () => {
  test.skip(process.platform === "win32", "Unix transport");
  const directory = await mkdtemp("/tmp/lancer-runtime-");
  const f = fixture();
  const server = new ControlServer(directory, (input) => f.service.handle(input));
  let response: IncomingMessage | undefined;
  try {
    await server.setEnabled(true);
    const token = (await readFile(server.tokenPath, "utf8")).trim();
    for (const [credential, input, status, code] of [
      ["wrong", { operation: "stream" }, 401, "UNAUTHORIZED"],
      [token, { operation: "stream", since: -1 }, 400, "INVALID_REQUEST"],
    ] as const) {
      const rejected = await connect(server.socketPath, credential, input);
      expect(rejected.statusCode).toBe(status);
      let body = "";
      for await (const chunk of rejected) body += String(chunk);
      expect(JSON.parse(body)).toMatchObject({ ok: false, error: { code } });
    }
    f.service.journal.status(a, "queued", timestamp);
    const cursor = f.service.journal.logs(a)[0]!.seq;
    f.service.journal.status(a, "running", timestamp);
    f.service.journal.status(b, "running", timestamp);
    response = await connect(server.socketPath, token, {
      operation: "stream",
      session: "ws:a",
      since: cursor,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/x-ndjson");
    const lines = createInterface({ input: response });
    const iterator = lines[Symbol.asyncIterator]();
    const replay = await iterator.next();
    if (replay.done) throw new Error("Stream ended before replay");
    expect(JSON.parse(replay.value)).toMatchObject({
      sessionId: "a",
      kind: "status",
      text: "running",
      seq: cursor + 1,
    });
    f.service.journal.status(b, "done", timestamp);
    f.service.journal.status({ workspaceId: "other", sessionId: "a" }, "failed", timestamp);
    f.service.journal.status(a, "done", timestamp);
    const live = await iterator.next();
    if (live.done) throw new Error("Stream ended before live event");
    expect(JSON.parse(live.value)).toEqual(f.service.journal.logs(a).at(-1));
    // Disabling deliberately aborts the HTTP body rather than sending a final record.
    lines.close();
    response.on("error", () => {});
    const closed = new Promise<void>((resolve) => response!.once("close", resolve));
    await server.setEnabled(false);
    await closed;
  } finally {
    response?.destroy();
    await server.setEnabled(false);
  }
});

test("unscoped stream merges sessions in cursor order without replay duplication", async () => {
  const f = fixture();
  f.service.journal.status(a, "running", timestamp);
  f.service.journal.status(b, "queued", timestamp);
  const stream = await f.service.handle({ operation: "stream", since: 1 });
  expect(stream).toBeInstanceOf(ControlStream);
  if (!(stream instanceof ControlStream)) throw new Error("Expected ControlStream");
  try {
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ seq: 2, sessionId: "b" });
    f.service.journal.status(a, "done", timestamp);
    expect((await iterator.next()).value).toMatchObject({ seq: 3, sessionId: "a" });
  } finally {
    stream.close();
  }
});

test("persisted done after restart is not fresh normal completion evidence", async () => {
  const f = fixture();
  f.metadata.set("a", { runtimeStatus: "done", startedAt: timestamp, finishedAt: timestamp });
  expect(await f.service.handle({ operation: "wait", session: "a" })).toMatchObject({
    done: true,
    outcome: "idle",
  });
});
