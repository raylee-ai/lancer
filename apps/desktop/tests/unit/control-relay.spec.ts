import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createEmptyDesktopAppState, type DesktopAppState } from "../../contracts/desktop-state";
import { ControlService } from "../../electron/control/control-service";
import { ControlServer } from "../../electron/control/control-server";

const exec = promisify(execFile);
const ref = { workspaceId: "w", sessionId: "s" };
function fixture() {
  let state: DesktopAppState = {
    ...createEmptyDesktopAppState(),
    workspaces: [
      {
        id: "w",
        name: "test",
        path: tmpdir(),
        kind: "primary",
        sessions: [
          {
            id: "s",
            title: "unit",
            preview: "",
            updatedAt: "before",
            status: "idle",
            hasUnseenUpdate: false,
            config: { provider: "first", modelId: "model", thinkingLevel: "medium" },
          },
        ],
      },
    ],
  };
  const changes: unknown[] = [];
  let hydration: Promise<void> = Promise.resolve();
  let modelChange: Promise<void> = Promise.resolve();
  let complete: () => void = () => {};
  const patch = (config: object) => {
    state = {
      ...state,
      workspaces: state.workspaces.map((w) => ({
        ...w,
        sessions: w.sessions.map((s) => ({ ...s, config: { ...s.config, ...config } })),
      })),
    };
  };
  const service = new ControlService(
    {
      snapshot: () => state,
      getStateForView: async () => state,
      getSelectedTranscriptForView: async () => ({ ...ref, transcript: [] }),
      setSessionModel: async (target, provider, modelId) => {
        changes.push({ target, provider, modelId });
        await modelChange;
        patch({ provider, modelId });
        return state;
      },
      setSessionThinkingLevel: async (target, thinkingLevel) => {
        changes.push({ target, thinkingLevel });
        patch({ thinkingLevel });
        return state;
      },
      submitControlMessage: async (_target, _message, _mode, beforeSubmit) => {
        await hydration;
        beforeSubmit?.();
        changes.push("send");
        await new Promise<void>((resolveRun) => {
          complete = resolveRun;
        });
        return state;
      },
    },
    async () => ref,
  );
  return {
    service,
    changes,
    patch,
    state: () => state,
    set: (next: Partial<DesktopAppState>) => {
      state = { ...state, ...next };
    },
    setHydration: (next: Promise<void>) => {
      hydration = next;
    },
    setModelChange: (next: Promise<void>) => {
      modelChange = next;
    },
    finish: () => complete(),
  };
}

async function guard(service: ControlService) {
  const result = (await service.handle({ operation: "wait", session: "s" })) as {
    session: { controlGuard: object };
  };
  return result.session.controlGuard;
}

test("set-model reuses store, returns actual route and carries guard through thinking/send", async () => {
  const f = fixture();
  const changed = (await f.service.handle({
    operation: "set-model",
    session: "s",
    model: "magpie/provider/model",
    expected: await guard(f.service),
  })) as { controlGuard: object };
  expect(changed).toMatchObject({ model: "magpie/provider/model" });
  const thinking = (await f.service.handle({
    operation: "set-thinking",
    session: "s",
    thinkingLevel: "high",
    expected: changed.controlGuard,
  })) as { controlGuard: object };
  expect(thinking).toMatchObject({ thinkingLevel: "high" });
  expect(f.changes).toEqual([
    { target: ref, provider: "magpie", modelId: "provider/model" },
    { target: ref, thinkingLevel: "high" },
  ]);
  await expect(
    f.service.handle({ operation: "set-model", session: "s", model: "bad" }),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  f.set({ lastError: "runtime refusal" });
  await expect(
    f.service.handle({ operation: "set-model", session: "s", model: "other/model" }),
  ).rejects.toThrow("runtime refusal");
});

test("model/thinking reject running, waiting, pending and concurrent configuration; send rejects configuration in progress", async () => {
  const f = fixture();
  const operations = [
    { operation: "set-model", model: "other/model" },
    { operation: "set-thinking", thinkingLevel: "high" },
  ];
  for (const status of ["running", "waiting", "queued"] as const) {
    f.service.journal.status(ref, status);
    for (const op of operations)
      await expect(f.service.handle({ ...op, session: "s" })).rejects.toMatchObject({
        code: "SESSION_BUSY",
      });
  }
  f.service.journal.status(ref, "idle");
  let release: () => void = () => {};
  f.setModelChange(
    new Promise<void>((done) => {
      release = done;
    }),
  );
  const changing = f.service.handle({ ...operations[0], session: "s" });
  for (const op of [...operations, { operation: "send", message: "no" }])
    await expect(f.service.handle({ ...op, session: "s" })).rejects.toMatchObject({
      code: "SESSION_BUSY",
    });
  release();
  await changing;
  await f.service.handle({ operation: "send", session: "s", message: "pending" });
  for (const op of operations)
    await expect(f.service.handle({ ...op, session: "s" })).rejects.toMatchObject({
      code: "SESSION_BUSY",
    });
  f.finish();
});

test("optimistic guard rejects UI change between model/thinking/send and repeats the check after hydration", async () => {
  const f = fixture();
  const before = await guard(f.service);
  f.patch({ thinkingLevel: "low" });
  await expect(
    f.service.handle({ operation: "send", session: "s", message: "no", expected: before }),
  ).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  const beforeCursor = await guard(f.service);
  f.service.journal.status(ref, "queued");
  f.service.journal.status(ref, "idle");
  await expect(
    f.service.handle({
      operation: "set-model",
      session: "s",
      model: "other/model",
      expected: beforeCursor,
    }),
  ).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  let release: () => void = () => {};
  f.setHydration(
    new Promise<void>((done) => {
      release = done;
    }),
  );
  await f.service.handle({
    operation: "send",
    session: "s",
    message: "no",
    expected: await guard(f.service),
  });
  f.set({
    workspaces: f.state().workspaces.map((w) => ({
      ...w,
      sessions: w.sessions.map((s) => ({ ...s, updatedAt: "UI interposed" })),
    })),
  });
  release();
  await expect
    .poll(
      async () =>
        (
          (await f.service.handle({ operation: "wait", session: "s" })) as {
            session: { submission: { state: string } };
          }
        ).session.submission.state,
    )
    .toBe("failed");
  expect(f.changes).not.toContain("send");
  const other = fixture();
  await expect(
    other.service.handle({ operation: "send", session: "s", message: "no", expected: before }),
  ).rejects.toMatchObject({ code: "SESSION_CHANGED" });
});

test("normal runtime event reports completed while idle, aborted and failure never do", async () => {
  const f = fixture();
  expect(await f.service.handle({ operation: "wait", session: "s" })).toMatchObject({
    outcome: "idle",
  });
  const session = f.state().workspaces[0]!.sessions[0]!;
  f.service.journal.observe({
    type: "runCompleted",
    sessionRef: ref,
    timestamp: new Date().toISOString(),
    runId: "normal",
    snapshot: { ...session, ref, workspace: { workspaceId: "w", path: tmpdir() } },
  });
  expect(await f.service.handle({ operation: "wait", session: "s" })).toMatchObject({
    outcome: "completed",
  });
  expect(f.service.journal.logs(ref).find((e) => e.kind === "runCompleted")).toMatchObject({
    runId: "normal",
    outcome: "completed",
  });
  f.service.journal.observe({
    type: "runCompleted",
    sessionRef: ref,
    timestamp: new Date().toISOString(),
    runId: "stopped",
    outcome: "aborted",
    snapshot: { ...session, ref, workspace: { workspaceId: "w", path: tmpdir() } },
  });
  expect(await f.service.handle({ operation: "wait", session: "s" })).toMatchObject({
    outcome: "failed",
  });
});

function raw(socketPath: string, token: string, body: string) {
  return new Promise<number>((done, reject) => {
    const req = request(
      { socketPath, path: "/v1", method: "POST", headers: { Authorization: `Bearer ${token}` } },
      (response) => {
        response.resume();
        response.once("end", () => done(response.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("real local IPC authenticates, reuses protected token, invokes CLI and disables without TCP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancer-relay-ipc-"));
  const f = fixture();
  const server = new ControlServer(directory, (input) => f.service.handle(input));
  try {
    await server.setEnabled(true);
    if (process.platform === "win32") expect(server.socketPath).toMatch(/^\\\\\.\\pipe\\/);
    const token = (await readFile(server.tokenPath, "utf8")).trim();
    expect(await raw(server.socketPath, "wrong", "{}")).toBe(401);
    expect(await raw(server.socketPath, token, "bad json")).toBe(400);
    const cli = await exec(process.execPath, [
      resolve("scripts/lancer-ctl.mjs"),
      "set-model",
      "s",
      "next/model",
      "--user-data-dir",
      directory,
    ]);
    expect(JSON.parse(cli.stdout) as object).toMatchObject({ model: "next/model" });
    const competitor = new ControlServer(directory, async () => ({}));
    await expect(competitor.setEnabled(true)).rejects.toThrow();
    await server.setEnabled(false);
    await expect(raw(server.socketPath, token, "{}")).rejects.toThrow();
    await server.setEnabled(true);
    expect((await readFile(server.tokenPath, "utf8")).trim()).toBe(token);
  } finally {
    await server.setEnabled(false);
  }
});

test("Windows refuses an inherited directory ACL and malformed token without replacing bytes", async () => {
  test.skip(process.platform !== "win32", "Windows ACL boundary");
  const directory = await mkdtemp(join(tmpdir(), "lancer-relay-acl-"));
  await mkdir(join(directory, "control-local"));
  const server = new ControlServer(directory, async () => ({}));
  await expect(server.setEnabled(true)).rejects.toThrow(/ACL/);
  const validDirectory = await mkdtemp(join(tmpdir(), "lancer-relay-token-"));
  const valid = new ControlServer(validDirectory, async () => ({}));
  await valid.setEnabled(true);
  await valid.setEnabled(false);
  await writeFile(valid.tokenPath, "malformed");
  await expect(valid.setEnabled(true)).rejects.toThrow(/Invalid control.token/);
  expect(await readFile(valid.tokenPath, "utf8")).toBe("malformed");
});
