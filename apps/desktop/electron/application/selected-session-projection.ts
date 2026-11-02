import { sessionKey } from "@lancer/session-driver";
import type { DesktopAppState, QueuedComposerMessage } from "../../contracts/desktop-state";
import type { QueuedComposerEditState } from "../conversation/session-state-map";
import { cloneComposerAttachments } from "./app-store-utils";

/** The per-session mirrors the selected-session projection reads. */
export interface SelectedSessionQueueSources {
  readonly queuedComposerMessagesBySession: ReadonlyMap<string, readonly QueuedComposerMessage[]>;
  readonly queuedComposerEditsBySession: ReadonlyMap<string, QueuedComposerEditState>;
}

/** Shared empty result: publishing runs per streamed token, so avoid churn. */
const NO_QUEUED_MESSAGES: readonly QueuedComposerMessage[] = [];

/**
 * The queue the composer shows for the selected session.
 *
 * The session mirrors, not the published snapshot, are the source of truth: they
 * are updated by driver events. Reusing the previously projected array kept an
 * orphaned queue alive in every response built before the session-event FIFO
 * drained — the visible "Stop did not clear the queue" defect.
 */
export function projectQueuedComposerMessages(
  workspaceId: string,
  sessionId: string,
  sources: SelectedSessionQueueSources,
): readonly QueuedComposerMessage[] {
  if (!workspaceId || !sessionId) {
    return NO_QUEUED_MESSAGES;
  }

  const queued = sources.queuedComposerMessagesBySession.get(
    sessionKey({ workspaceId, sessionId }),
  );
  if (!queued || queued.length === 0) {
    return NO_QUEUED_MESSAGES;
  }

  // Steer messages are folded into the transcript, so the composer list only
  // shows follow-ups — matching what the driver is holding for the next turn.
  return queued
    .filter((message) => message.mode === "followUp")
    .map((message) => ({
      ...message,
      attachments: cloneComposerAttachments(message.attachments),
    }));
}

export function projectEditingQueuedMessageId(
  workspaceId: string,
  sessionId: string,
  sources: SelectedSessionQueueSources,
): string | undefined {
  if (!workspaceId || !sessionId) {
    return undefined;
  }

  return sources.queuedComposerEditsBySession.get(sessionKey({ workspaceId, sessionId }))
    ?.messageId;
}

/** Re-derive every queue field that belongs to the selected session. */
export function projectSelectedSessionFields(
  state: DesktopAppState,
  sources: SelectedSessionQueueSources,
): DesktopAppState {
  return {
    ...state,
    queuedComposerMessages: projectQueuedComposerMessages(
      state.selectedWorkspaceId,
      state.selectedSessionId,
      sources,
    ),
    editingQueuedMessageId: projectEditingQueuedMessageId(
      state.selectedWorkspaceId,
      state.selectedSessionId,
      sources,
    ),
  };
}
