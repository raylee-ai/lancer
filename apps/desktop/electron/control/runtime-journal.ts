import type {
  SessionDriverEvent,
  SessionLaneMetadata,
  SessionRef,
  SessionTranscriptItem,
} from "@lancer/session-driver";

export type RuntimeStatus = "running" | "queued" | "waiting" | "done" | "failed" | "idle";
/** Metadata carried by store-owned status publications. */
export type RuntimeJournalStatusExtras = Readonly<SessionLaneMetadata>;

export interface RuntimeJournalEvent extends Omit<
  RuntimeJournalStatusExtras,
  "startedAt" | "finishedAt"
> {
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly seq: number;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly ts: string;
  readonly kind: SessionDriverEvent["type"] | "status";
  readonly status?: RuntimeStatus;
  readonly text: string;
  readonly runId?: string;
  readonly outcome?: "completed" | "aborted";
  readonly callId?: string;
  readonly toolName?: string;
  readonly input?: unknown;
  readonly success?: boolean;
  readonly exitCode?: number;
}
export interface RuntimeJournalState {
  status: RuntimeStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** Milliseconds, computed at read time while active. */
  elapsed: number;
  lastLine: string;
}

function key(ref: SessionRef): string {
  return JSON.stringify([ref.workspaceId, ref.sessionId]);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const sensitiveKey = /key|token|secret|password|authorization/i;

function scrub(text: string, secrets: Set<string>): string {
  // Quoted/unquoted shell assignments, JSON-style credentials and CLI flags.
  text = text.replace(
    /((?:[\w-]*(?:key|token|secret|password)[\w-]*)["']?[\t ]*(?:=|:|[\t ])[\t ]*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;}&]+))/gi,
    (
      _match,
      prefix: string,
      double: string | undefined,
      single: string | undefined,
      bare: string | undefined,
    ) => {
      const value = double ?? single ?? bare;
      if (value && value !== "[REDACTED]") secrets.add(value);
      const quote = double !== undefined ? '"' : single !== undefined ? "'" : "";
      return `${prefix}${quote}[REDACTED]${quote}`;
    },
  );
  text = text.replace(/\bBearer\s+([A-Za-z0-9._~+\/-]+=*)/gi, (_match, value: string) => {
    secrets.add(value);
    return "Bearer [REDACTED]";
  });
  text = text.replace(
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g,
    (value) => {
      secrets.add(value);
      return "[REDACTED]";
    },
  );
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    text = text
      .split("[REDACTED]")
      .map((part) => part.split(secret).join("[REDACTED]"))
      .join("[REDACTED]");
  }
  return text;
}

function capture(
  value: unknown,
  secrets: Set<string>,
  sensitive = false,
  seen = new WeakSet<object>(),
): void {
  if (typeof value === "string") {
    if (sensitive && value) secrets.add(value);
    scrub(value, secrets);
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [name, item] of Object.entries(value)) {
    capture(item, secrets, sensitive || sensitiveKey.test(name), seen);
  }
}

function redact(value: unknown, secrets: Set<string>, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return scrub(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const result: unknown = Array.isArray(value)
    ? value.map((item: unknown) => redact(item, secrets, seen))
    : Object.fromEntries(
        Object.entries(value).map(([name, item]: [string, unknown]) => [
          name,
          sensitiveKey.test(name) ? "[REDACTED]" : redact(item, secrets, seen),
        ]),
      );
  seen.delete(value);
  return result;
}
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!record(output)) return "";
  if (typeof output.text === "string") return output.text;
  if (Array.isArray(output.content)) {
    return output.content
      .filter(record)
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("\n");
  }
  return "";
}
function exitCode(output: unknown): number | undefined {
  if (!record(output)) return undefined;
  const code = output.exitCode ?? (record(output.details) ? output.details.exitCode : undefined);
  return typeof code === "number" && Number.isFinite(code) ? code : undefined;
}

/** In-memory observer only. Global cursors are monotonic; refs include the workspace.
 * No retention truncation: every observed output remains available for replay.
 */
export class RuntimeJournal {
  private seq = 0;
  private readonly entries = new Map<string, RuntimeJournalEvent[]>();
  private readonly states = new Map<string, RuntimeJournalState>();
  private readonly secrets = new Map<string, Set<string>>();
  private readonly listeners = new Set<(event: RuntimeJournalEvent) => void>();

  constructor(private readonly now: () => number = Date.now) {}

  logs(ref: SessionRef | undefined, since = 0): RuntimeJournalEvent[] {
    const entries = ref ? (this.entries.get(key(ref)) ?? []) : [...this.entries.values()].flat();
    return entries
      .filter((event) => event.seq > since)
      .sort((a, b) => a.seq - b.seq)
      .map((event) => structuredClone(event));
  }

  /** Project existing history only before any live or seeded entry for this ref.
   * Synchronous check and projection let live events win an awaited hydration race.
   * Historical entries never infer runtime state or timing.
   */
  seed(ref: SessionRef, items: readonly SessionTranscriptItem[]): void {
    const id = key(ref);
    if (this.entries.get(id)?.length) return;
    const secrets = this.secrets.get(id) ?? new Set<string>();
    this.secrets.set(id, secrets);
    // Capture credentials before projecting earlier text that may echo them.
    for (const item of items) {
      if (item.kind === "tool") {
        capture(item.input, secrets);
        capture(item.output, secrets);
      } else if (item.role === "assistant") capture(item.text, secrets);
    }
    for (const item of items) {
      const base = { ...ref, ts: item.createdAt };
      if (item.kind === "message") {
        if (item.role !== "assistant") continue;
        this.append({
          ...base,
          seq: ++this.seq,
          kind: "assistantDelta",
          text: scrub(item.text, secrets),
        });
      } else {
        const input = redact(item.input, secrets);
        this.append({
          ...base,
          seq: ++this.seq,
          kind: "toolStarted",
          callId: item.callId,
          toolName: item.toolName,
          input,
          text: `${item.toolName} ${JSON.stringify(input) ?? ""}`.trimEnd(),
        });
        const code = exitCode(item.output);
        this.append({
          ...base,
          seq: ++this.seq,
          kind: "toolFinished",
          callId: item.callId,
          success: item.status === "success",
          ...(code === undefined ? {} : { exitCode: code }),
          text: scrub(outputText(item.output), secrets),
        });
      }
    }
  }

  state(ref: SessionRef): RuntimeJournalState | undefined {
    const state = this.states.get(key(ref));
    if (!state) return undefined;
    const end = state.finishedAt === null ? this.now() : Date.parse(state.finishedAt);
    return {
      ...state,
      elapsed: state.startedAt === null ? 0 : Math.max(0, end - Date.parse(state.startedAt)),
    };
  }

  subscribe(listener: (event: RuntimeJournalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Store-owned transitions also enter the global replay/subscription stream. */
  status(
    ref: SessionRef,
    status: RuntimeStatus,
    ts = new Date(this.now()).toISOString(),
    extras: RuntimeJournalStatusExtras = {},
  ): void {
    const previous = this.state(ref);
    if (previous?.status === status && Object.keys(extras).length === 0) return;
    const state = previous ?? this.emptyState();
    if (status === "running" && (state.startedAt === null || state.finishedAt !== null)) {
      state.startedAt = ts;
      state.finishedAt = null;
    }
    if (status === "done" || status === "failed" || status === "idle") {
      if (state.startedAt !== null) state.finishedAt ??= ts;
    } else if (status === "queued" && state.finishedAt !== null) {
      state.startedAt = null;
      state.finishedAt = null;
    }
    state.status = status;
    this.states.set(key(ref), state);
    this.publishStatus(ref, state, ts, extras);
  }

  private publishStatus(
    ref: SessionRef,
    state: RuntimeJournalState,
    ts: string,
    extras: RuntimeJournalStatusExtras = {},
  ): void {
    this.append({
      ...structuredClone(extras),
      seq: ++this.seq,
      ...ref,
      ts,
      kind: "status",
      status: state.status,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      text: state.status,
    });
  }

  private emptyState(): RuntimeJournalState {
    return { status: "idle", startedAt: null, finishedAt: null, elapsed: 0, lastLine: "" };
  }

  observe(event: SessionDriverEvent): void {
    const id = key(event.sessionRef);
    const previous = this.state(event.sessionRef);
    const state = previous ?? this.emptyState();
    const previousStatus = previous?.status;
    const secrets = this.secrets.get(id) ?? new Set<string>();
    this.secrets.set(id, secrets);
    if (event.type === "toolStarted") capture(event.input, secrets);
    if (event.type === "toolFinished") capture(event.output, secrets);
    if (event.type === "runFailed") capture(event.error, secrets);
    const start = () => {
      if (state.startedAt === null || state.finishedAt !== null) {
        state.startedAt = event.timestamp;
        state.finishedAt = null;
      }
      state.status = "running";
    };
    const finish = (status: "done" | "failed") => {
      state.status = status;
      if (state.startedAt !== null) state.finishedAt ??= event.timestamp;
    };
    let text = "";
    let extra: Partial<RuntimeJournalEvent> = {};
    switch (event.type) {
      case "assistantDelta":
        start();
        text = event.text;
        break;
      case "toolStarted": {
        start();
        const input = redact(event.input, secrets);
        text = `${event.toolName} ${JSON.stringify(input) ?? ""}`.trimEnd();
        extra = { callId: event.callId, toolName: event.toolName, input };
        break;
      }
      case "toolUpdated":
        start();
        text = event.text ?? "";
        extra = { callId: event.callId };
        break;
      case "toolFinished":
        start();
        text = outputText(event.output);
        extra = { callId: event.callId, success: event.success };
        if (exitCode(event.output) !== undefined)
          extra = { ...extra, exitCode: exitCode(event.output) };
        break;
      case "runCompleted":
        extra = { outcome: event.outcome ?? "completed" };
        finish(event.outcome === "aborted" ? "failed" : "done");
        text = event.outcome === "aborted" ? "Run interrupted" : "Run completed";
        break;
      case "runFailed":
        finish("failed");
        text = event.error.message;
        break;
      case "sessionOpened":
      case "sessionUpdated":
        if (event.type === "sessionUpdated" && event.outcome === "aborted") {
          finish("failed");
          text = "Run interrupted";
          break;
        }
        if (event.snapshot.status === "running") {
          if (state.status !== "waiting") start();
        } else if (event.snapshot.status === "failed") {
          finish("failed");
        } else if (event.snapshot.queuedMessages?.length) {
          state.status = "queued";
          if (state.finishedAt !== null) {
            state.startedAt = null;
            state.finishedAt = null;
          }
        } else if (state.status !== "done" && state.status !== "failed") {
          state.status = "idle";
          if (state.startedAt !== null) state.finishedAt ??= event.timestamp;
        }
        text = state.status;
        break;
      case "queuedMessageStarted":
        start();
        text = "Queued message started";
        break;
      case "hostUiRequest":
        if (!["confirm", "input", "select", "editor"].includes(event.request.kind)) return;
        state.status = "waiting";
        text = "Waiting for input";
        break;
      default:
        return;
    }
    // toolStarted already redacts string values before JSON serialization. Scrubbing
    // the serialized form would corrupt property names and the tool name.
    if (event.type !== "toolStarted") text = scrub(text, secrets);
    if (text) state.lastLine = text.split(/\r?\n/).at(-1) ?? "";
    this.states.set(id, state);
    const entry: RuntimeJournalEvent = {
      ...extra,
      seq: ++this.seq,
      ...event.sessionRef,
      ts: event.timestamp,
      kind: event.type,
      text,
      ...(event.runId ? { runId: event.runId } : {}),
    };
    this.append(entry);
    if (previousStatus !== state.status) {
      this.publishStatus(event.sessionRef, state, event.timestamp);
    }
  }

  private append(entry: RuntimeJournalEvent): void {
    const id = key(entry);
    const entries = this.entries.get(id) ?? [];
    entries.push(entry);
    this.entries.set(id, entries);
    for (const listener of [...this.listeners]) listener(structuredClone(entry));
  }
}
