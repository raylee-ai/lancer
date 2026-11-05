import { expect, test } from "@playwright/test";
import type { SessionConfig } from "@lancer/session-driver";
import { createConversationOwner } from "../../electron/conversation/app-store-composer";

const ref = { workspaceId: "w", sessionId: "s" };
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let initialize = Promise.resolve();
  let hydration = Promise.resolve();
  let sending = Promise.resolve();
  let status = "idle";
  const events: string[] = [];
  const configs = new Map<string, SessionConfig>([["w:s", { thinkingLevel: "medium" }]]);
  const host = {
    initialize: () => initialize,
    conversationState: {
      loadedTranscriptKeys: new Set(["w:s"]),
      transcriptCache: new Map(),
      composerAttachmentsBySession: new Map(),
      composerDraftsBySession: new Map(),
      sessionCommandsBySession: new Map(),
      activeAssistantMessageBySession: new Map(),
      sessionErrorsBySession: new Map(),
      sessionConfigBySession: configs,
    },
    driver: {
      setSessionModel: async () => {
        events.push("model");
      },
      setSessionThinkingLevel: async () => {
        configs.set("w:s", { thinkingLevel: "low" });
        events.push("thinking");
      },
      sendUserMessage: async () => {
        events.push("send");
        await sending;
      },
    },
    runtimeForWorkspace: () => undefined,
    sessionFromState: () => ({ title: "unit", status, updatedAt: "unit" }),
    getQueuedComposerMessages: () => [],
    withErrorHandling: async (work: () => Promise<unknown>) => work(),
    withSessionError: (_ref: unknown, error: unknown) => {
      throw error;
    },
    emit: () => ({}),
    refreshState: async () => ({}),
    ensureSessionReady: async () => {
      await hydration;
    },
    finishLocalComposerCommand: () => undefined,
    setComposerDraftForSession: () => undefined,
    schedulePersistUiState: () => undefined,
    publishSelectedTranscriptFor: () => undefined,
    recordUserMessageRecency: () => true,
    persistComposerAttachments: async () => undefined,
  };
  const owner = createConversationOwner(host as never);
  return {
    owner,
    host,
    configs,
    events,
    setInitialize: (p: Promise<void>) => {
      initialize = p;
    },
    setHydration: (p: Promise<void>) => {
      hydration = p;
    },
    setSending: (p: Promise<void>) => {
      sending = p;
    },
    setStatus: (s: string) => {
      status = s;
    },
  };
}

test("shared owner locks before asynchronous initialization and rejects UI send or a second configuration", async () => {
  const f = fixture();
  const init = deferred();
  f.setInitialize(init.promise);
  const model = f.owner.setSessionModel(ref, "p", "model");
  await expect(f.owner.setSessionThinkingLevel(ref, "high")).rejects.toThrow(/idle/);
  await expect(
    f.owner.submitComposerToSession(ref, "UI input", [], { preserveComposer: true }),
  ).rejects.toThrow(/configuration/);
  expect(f.events).toEqual([]);
  init.resolve();
  await model;
  expect(f.events).toEqual(["model"]);
});

test("shared owner blocks model and thinking changes while a send is still starting or active", async () => {
  const f = fixture();
  const send = deferred();
  f.setSending(send.promise);
  const running = f.owner.sendMessageToSession(ref, "UI message", []);
  await expect(f.owner.setSessionModel(ref, "p", "m")).rejects.toThrow(/idle/);
  await expect(f.owner.setSessionThinkingLevel(ref, "high")).rejects.toThrow(/idle/);
  send.resolve();
  await running;
  f.setStatus("running");
  await expect(f.owner.setSessionModel(ref, "p", "m")).rejects.toThrow(/idle/);
});

test("guard runs at the real send boundary after hydration, before transcript writes", async () => {
  const f = fixture();
  const hydration = deferred();
  f.setHydration(hydration.promise);
  f.host.conversationState.loadedTranscriptKeys.clear();
  let changed = false;
  const sending = f.owner.submitComposerToSession(ref, "relay", [], {
    preserveComposer: true,
    beforeSend: () => {
      if (changed) throw new Error("interposed input");
    },
  });
  changed = true;
  hydration.resolve();
  await expect(sending).rejects.toThrow(/interposed/);
  expect(f.events).toEqual([]);
  expect(f.host.conversationState.transcriptCache.size).toBe(0);
});

test("effective driver thinking level is retained instead of overwritten by requested high", async () => {
  const f = fixture();
  await f.owner.setSessionThinkingLevel(ref, "high");
  expect(f.configs.get("w:s")?.thinkingLevel).toBe("low");
});

for (const command of ["/model p:model", "/thinking high"]) {
  test(`slash command ${command} cannot bypass an active send mutation`, async () => {
    const f = fixture();
    const send = deferred();
    f.setSending(send.promise);
    const running = f.owner.sendMessageToSession(ref, "pending native send", []);
    await expect(f.owner.submitComposerToSession(ref, command, [])).rejects.toThrow(/idle/);
    expect(f.events).not.toContain("model");
    expect(f.events).not.toContain("thinking");
    send.resolve();
    await running;
  });
}

test("background delivery cannot bypass configuration waiting on initialize", async () => {
  const f = fixture();
  const init = deferred();
  f.setInitialize(init.promise);
  const model = f.owner.setSessionModel(ref, "p", "model");
  await expect(f.owner.deliverBackgroundInstruction(ref, "scheduled input")).rejects.toThrow(
    /configuration/,
  );
  expect(f.events).toEqual([]);
  init.resolve();
  await model;
  expect(f.events).toEqual(["model"]);
});

test("background hydration registers sending before its first await and blocks configuration", async () => {
  const f = fixture();
  const hydration = deferred();
  f.setHydration(hydration.promise);
  const background = f.owner.deliverBackgroundInstruction(ref, "scheduled input");
  await expect(f.owner.setSessionModel(ref, "p", "model")).rejects.toThrow(/idle/);
  await expect(f.owner.submitComposerToSession(ref, "/thinking high", [])).rejects.toThrow(/idle/);
  expect(f.events).toEqual([]);
  hydration.resolve();
  await background;
  expect(f.events).toEqual(["send"]);
});
