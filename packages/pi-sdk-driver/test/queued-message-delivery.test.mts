import assert from "node:assert/strict";
import test from "node:test";
import type { SessionDriverEvent, SessionQueuedMessage } from "@lancer/session-driver";
import { SessionSupervisor } from "../dist/index.js";

const ref = { workspaceId: "workspace", sessionId: "session" };
const queued = (id: string): SessionQueuedMessage => ({
  id,
  mode: "followUp",
  text: id,
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
});

function deliverableQueue() {
  return new SessionSupervisor() as unknown as {
    withDeliverableQueue(
      record: { queuedMessages: SessionQueuedMessage[] },
      event: SessionDriverEvent,
    ): SessionDriverEvent;
  };
}

function sessionUpdated(queuedMessages: SessionQueuedMessage[]): SessionDriverEvent {
  return {
    type: "sessionUpdated",
    sessionRef: ref,
    timestamp: "2026-11-02T00:00:00.000Z",
    snapshot: { ref, queuedMessages },
  } as unknown as SessionDriverEvent;
}

await test("a snapshot mapped before Stop is delivered with the record's cleared queue", () => {
  // Stop clears the record and emits its own update, but a sessionUpdated mapped
  // while the queue still held entries is already waiting in the event queue.
  // Delivering it unchanged would put the discarded messages back on screen.
  const record = { queuedMessages: [] as SessionQueuedMessage[] };
  const stale = sessionUpdated([queued("one"), queued("two")]);

  const delivered = deliverableQueue().withDeliverableQueue(record, stale);
  if (delivered.type !== "sessionUpdated") throw new Error("Expected a session update");
  // `buildSnapshot` omits the key when nothing is queued; the delivered event
  // must match that shape rather than inventing an empty array.
  assert.equal(delivered.snapshot.queuedMessages, undefined);
  assert.equal("queuedMessages" in delivered.snapshot, false);
});

await test("a snapshot already matching the record is delivered as-is", () => {
  const record = { queuedMessages: [queued("one")] };
  const current = sessionUpdated([queued("one")]);

  assert.equal(deliverableQueue().withDeliverableQueue(record, current), current);
});

await test("a message queued after the snapshot was mapped still reaches the UI", () => {
  const record = { queuedMessages: [queued("one"), queued("two")] };
  const stale = sessionUpdated([queued("one")]);

  const delivered = deliverableQueue().withDeliverableQueue(record, stale);
  if (delivered.type !== "sessionUpdated") throw new Error("Expected a session update");
  assert.deepEqual(
    delivered.snapshot.queuedMessages?.map((message) => message.id),
    ["one", "two"],
  );
});

await test("events without a queue snapshot are never rewritten", () => {
  const record = { queuedMessages: [queued("one")] };
  const delta = {
    type: "assistantDelta",
    sessionRef: ref,
    timestamp: "2026-11-02T00:00:00.000Z",
    text: "hello",
  } as unknown as SessionDriverEvent;

  assert.equal(deliverableQueue().withDeliverableQueue(record, delta), delta);
});
