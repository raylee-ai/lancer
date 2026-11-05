import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonCatalogStore } from "@lancer/catalogs/node";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";

await test("session tools use the resolved execution directory and reopen from catalog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-execution-cwd-"));
  const agentDir = join(root, "agent");
  const workspacePath = join(root, "workspace");
  const worktreePath = join(root, "worktree");
  const otherPath = join(root, "other-worktree");
  const catalogFilePath = join(root, "catalog.json");
  await mkdir(agentDir);
  await mkdir(workspacePath);
  await mkdir(worktreePath);
  await mkdir(otherPath);
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

  const seen: string[] = [];
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath,
    createAgentSessionRuntimeImpl: async (options) => {
      seen.push(options?.cwd ?? "");
      const runtime = await createAgentSessionRuntimeWithNpmFallback({ ...options, tools: [] });
      runtime.session.agent.streamFunction = (() => {
        throw new Error("This test does not run a model");
      }) as AgentSessionRuntime["session"]["agent"]["streamFunction"];
      return runtime;
    },
  });
  const workspace = { workspaceId: "cwd-workspace", path: workspacePath };
  let preparedId = "";
  const snapshot = await driver.createSession(workspace, {
    initialModel: { provider: "cwd-test", modelId: "scripted" },
    resolveExecutionCwd: async (sessionId) => {
      preparedId = sessionId;
      return worktreePath;
    },
  });
  assert.equal(preparedId, snapshot.ref.sessionId);
  assert.equal(seen.at(-1), worktreePath);
  const sessionFile = await new JsonCatalogStore({ catalogFilePath }).getSessionFile(snapshot.ref);
  assert.ok(sessionFile);
  assert.equal(sessionFile.startsWith(worktreePath), false);

  await driver.closeSession(snapshot.ref);
  const catalogs = new JsonCatalogStore({ catalogFilePath });
  await catalogs.sessions.updateControlMetadata(snapshot.ref, { worktreePath: otherPath });
  await driver.openSession(snapshot.ref);
  assert.equal(seen.at(-1), otherPath);

  await catalogs.sessions.updateControlMetadata(snapshot.ref, { worktreePath: null });
  await driver.retargetExecutionCwd(snapshot.ref);
  assert.equal(seen.at(-1), workspacePath);
  await driver.closeSession(snapshot.ref);
});
