import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";

await test("prompt start and worktree merge or discard exclude each other", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktree-operation-"));
  const agentDir = join(root, "agent");
  const workspacePath = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(workspacePath);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("This test must never use the network");
  });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [], compaction: { enabled: false }, cacheWarming: "off" }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "cwd-test": {
          baseUrl: "http://127.0.0.1:9/never-contact",
          apiKey: "LOCAL_TEST_CANARY",
          api: "openai-completions",
          models: [{ id: "scripted", input: ["text"], contextWindow: 8000, maxTokens: 1000 }],
        },
      },
    }),
  );

  let promptCalls = 0;
  let releasePrompt: (() => void) | undefined;
  let markPromptEntered: (() => void) | undefined;
  const promptEntered = new Promise<void>((resolve) => {
    markPromptEntered = resolve;
  });
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalog.json"),
    createAgentSessionRuntimeImpl: async (options) => {
      const runtime = await createAgentSessionRuntimeWithNpmFallback({ ...options, tools: [] });
      runtime.session.agent.streamFunction = (() => {
        throw new Error("This test does not run a model");
      }) as AgentSessionRuntime["session"]["agent"]["streamFunction"];
      const session = runtime.session as unknown as {
        prompt: (...args: unknown[]) => Promise<unknown>;
      };
      session.prompt = async () => {
        promptCalls += 1;
        markPromptEntered?.();
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      };
      return runtime;
    },
  });
  const snapshot = await driver.createSession(
    { workspaceId: "cwd-workspace", path: workspacePath },
    { initialModel: { provider: "cwd-test", modelId: "scripted" } },
  );

  const held = driver.beginWorktreeOperation(snapshot.ref, "merge");
  await assert.rejects(
    driver.sendUserMessage(snapshot.ref, { text: "should not start" }),
    /being merged/,
  );
  await assert.rejects(
    driver.replaceQueuedMessages(snapshot.ref, [
      {
        id: "queued",
        mode: "followUp",
        text: "should not start",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]),
    /being merged/,
  );
  assert.equal(promptCalls, 0);
  assert.throws(
    () => driver.beginWorktreeOperation(snapshot.ref, "discard"),
    /already being merged or discarded/,
  );
  held();

  const sending = driver.sendUserMessage(snapshot.ref, { text: "hold this turn" });
  await promptEntered;
  assert.equal(promptCalls, 1);
  assert.throws(() => driver.beginWorktreeOperation(snapshot.ref, "discard"), /Stop the session/);
  assert.throws(() => driver.beginWorktreeOperation(snapshot.ref, "merge"), /Stop the session/);
  releasePrompt?.();
  await sending;
  assert.equal(promptCalls, 1);
});
