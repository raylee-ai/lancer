import { expect, test } from "@playwright/test";
import { createEmptyDesktopAppState } from "../../contracts/desktop-state";
import type { QueuedComposerMessage } from "../../contracts/desktop-state";
import {
  projectEditingQueuedMessageId,
  projectQueuedComposerMessages,
  projectSelectedSessionFields,
} from "../../electron/application/selected-session-projection";
import type { SelectedSessionQueueSources } from "../../electron/application/selected-session-projection";

const workspaceId = "workspace-1";
const sessionId = "session-1";
const key = `${workspaceId}:${sessionId}`;

function queued(mode: QueuedComposerMessage["mode"], id: string): QueuedComposerMessage {
  return {
    id,
    mode,
    text: `text-${id}`,
    attachments: [],
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
  };
}

function sources(
  messages: readonly QueuedComposerMessage[] = [],
  editingMessageId?: string,
): SelectedSessionQueueSources {
  return {
    queuedComposerMessagesBySession: new Map([[key, [...messages]]]),
    queuedComposerEditsBySession: new Map(
      editingMessageId
        ? [[key, { messageId: editingMessageId, restoreDraft: "", restoreAttachments: [] }]]
        : [],
    ),
  };
}

test("selection projection drops a queue the mirrors no longer hold", () => {
  const state = {
    ...createEmptyDesktopAppState(),
    selectedWorkspaceId: workspaceId,
    selectedSessionId: sessionId,
    // What the last publish resolved before the driver cleared its queue on Stop.
    queuedComposerMessages: [queued("followUp", "one"), queued("followUp", "two")],
    editingQueuedMessageId: "one",
  };

  expect(projectQueuedComposerMessages(workspaceId, sessionId, sources())).toEqual([]);
  const projected = projectSelectedSessionFields(state, sources());
  expect(projected.queuedComposerMessages).toEqual([]);
  expect(projected.editingQueuedMessageId).toBeUndefined();
});

test("only follow-ups reach the composer list", () => {
  const state = {
    ...createEmptyDesktopAppState(),
    selectedWorkspaceId: workspaceId,
    selectedSessionId: sessionId,
  };

  const projected = projectSelectedSessionFields(
    state,
    sources([queued("steer", "steer-1"), queued("followUp", "follow-1")]),
  );

  expect(projected.queuedComposerMessages.map((message) => message.id)).toEqual(["follow-1"]);
});

test("projection copies attachments instead of sharing the mirror", () => {
  const message: QueuedComposerMessage = {
    ...queued("followUp", "with-file"),
    attachments: [
      {
        id: "attachment-1",
        kind: "file",
        name: "report.md",
        mimeType: "text/markdown",
        fsPath: "/tmp/report.md",
        sizeBytes: 1,
      },
    ],
  };
  const source = sources([message]);
  const projected = projectQueuedComposerMessages(workspaceId, sessionId, source);

  expect(projected[0]?.attachments).not.toBe(message.attachments);
  expect(projected[0]?.attachments).toEqual(message.attachments);
});

test("editing id is read from the mirror, not from the published snapshot", () => {
  expect(projectEditingQueuedMessageId(workspaceId, sessionId, sources([], "follow-1"))).toBe(
    "follow-1",
  );
  expect(projectEditingQueuedMessageId(workspaceId, sessionId, sources())).toBeUndefined();
});

test("no selection projects an empty queue", () => {
  const state = {
    ...createEmptyDesktopAppState(),
    queuedComposerMessages: [queued("followUp", "stale")],
  };

  expect(projectSelectedSessionFields(state, sources()).queuedComposerMessages).toEqual([]);
});
