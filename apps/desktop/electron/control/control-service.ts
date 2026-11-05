import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ControlStream } from "./control-stream";
import { RuntimeJournal } from "./runtime-journal";
import { expectThinkingLevel } from "../ipc/request-validation";
import { sessionKey, type SessionRef, type SessionTranscriptItem } from "@lancer/session-driver";
import type { DesktopAppStore } from "../application/app-store";
import type { DesktopAppState } from "../../contracts/desktop-state";
import {
  LANCER_SESSION_ZONES,
  formatSessionTitleForZone,
  lancerZoneById,
  conversationZoneId,
  stripLancerZonePrefix,
} from "../../contracts/lancer-zones";

export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type ControlStore = Pick<
  DesktopAppStore,
  "snapshot" | "getStateForView" | "getSelectedTranscriptForView" | "submitControlMessage"
> &
  Partial<
    Pick<
      DesktopAppStore,
      | "subscribeToSessionEvents"
      | "subscribe"
      | "cancelCurrentRun"
      | "setSessionModel"
      | "setSessionThinkingLevel"
      | "getControlMetadata"
      | "updateControlMetadata"
    >
  >;
interface Submission {
  readonly id: string;
  readonly mode: string;
  state: "pending" | "complete" | "failed";
  error?: string;
  sessionUpdatedAt?: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ControlError("INVALID_REQUEST", "Expected a JSON object");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new ControlError("INVALID_REQUEST", `${field} must be a nonempty string`);
  return value;
}

export class ControlService {
  // Keep only the latest receipt per session, not a second transcript/history store.
  private readonly instanceId = randomUUID();
  private readonly latest = new Map<string, Submission>();
  private readonly pending = new Map<string, number>();
  readonly journal = new RuntimeJournal();
  private readonly metadata = new Map<
    string,
    Awaited<ReturnType<DesktopAppStore["getControlMetadata"]>>
  >();
  private readonly configuring = new Set<string>();
  private readonly stopping = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: ControlStore,
    private readonly create: (input: {
      cwd: string;
      model?: string;
      name?: string;
    }) => Promise<SessionRef>,
  ) {
    store.subscribe?.((state) => {
      for (const workspace of state.workspaces)
        for (const session of workspace.sessions) {
          const ref = { workspaceId: workspace.id, sessionId: session.id };
          const current = this.journal.state(ref);
          const waiting =
            (state.sessionExtensionUiBySession[sessionKey(ref)]?.pendingDialogs.length ?? 0) > 0;
          if (waiting && current?.status !== "waiting") this.journal.status(ref, "waiting");
          else if (!waiting && current?.status === "waiting" && session.status === "running")
            this.journal.status(ref, "running");
        }
    });
    store.subscribeToSessionEvents?.(async (event) => {
      const before = this.journal.state(event.sessionRef);
      this.journal.observe(event);
      const after = this.journal.state(event.sessionRef);
      if (
        this.store.updateControlMetadata &&
        after &&
        (before?.startedAt !== after.startedAt ||
          before?.finishedAt !== after.finishedAt ||
          before?.status !== after.status)
      ) {
        await this.updateMetadata(
          event.sessionRef,
          {
            startedAt: after.startedAt,
            finishedAt: after.finishedAt,
            runtimeStatus: after.status,
          },
          false,
        );
      }
    });
  }

  private sessions(state: DesktopAppState) {
    return state.workspaces.flatMap((workspace) =>
      workspace.sessions.map((session) => {
        const ref = { workspaceId: workspace.id, sessionId: session.id };
        const key = sessionKey(ref);
        const waiting = (state.sessionExtensionUiBySession[key]?.pendingDialogs.length ?? 0) > 0;
        const receipt = this.latest.get(key);
        const saved = this.metadata.get(key);
        const observed = this.journal.state(ref);
        const interrupted =
          !observed &&
          session.status === "idle" &&
          (saved?.runtimeStatus === "running" || saved?.runtimeStatus === "waiting");
        const elapsed =
          saved?.startedAt && saved.finishedAt
            ? Math.max(0, Date.parse(saved.finishedAt) - Date.parse(saved.startedAt))
            : null;
        const explicitModel =
          session.config?.provider && session.config.modelId
            ? `${session.config.provider}/${session.config.modelId}`
            : null;
        const defaults =
          state.runtimeByWorkspace[workspace.id]?.settings ?? state.globalModelSettings;
        const defaultModel =
          defaults.defaultProvider && defaults.defaultModelId
            ? `${defaults.defaultProvider}/${defaults.defaultModelId}`
            : null;
        return {
          ...ref,
          id: session.id,
          updatedAt: session.updatedAt,
          controlGuard: {
            instanceId: this.instanceId,
            updatedAt: session.updatedAt,
            cursor: this.journal.logs(ref).at(-1)?.seq ?? 0,
            model: explicitModel ?? defaultModel,
            thinkingLevel: session.config?.thinkingLevel ?? null,
          },
          title: stripLancerZonePrefix(session.title),
          rawTitle: session.title,
          zoneId: conversationZoneId(session.title),
          zone: lancerZoneById(conversationZoneId(session.title)).label,
          workspace: workspace.name,
          cwd: workspace.path,
          model: explicitModel ?? defaultModel,
          thinkingLevel: session.config?.thinkingLevel ?? null,
          modelSource: explicitModel ? "session" : defaultModel ? "workspace-default" : "unknown",
          ...saved,
          elapsed: Number.isFinite(elapsed) ? elapsed : null,
          ...observed,
          lastLine: observed?.lastLine ?? this.journal.logs(ref).at(-1)?.text ?? null,
          status: waiting
            ? "waiting"
            : session.status === "running" || session.status === "failed"
              ? session.status
              : (observed?.status ??
                (interrupted ? "failed" : saved?.runtimeStatus) ??
                session.status),
          archived: Boolean(session.archivedAt),
          pending: this.pending.get(key) ?? 0,
          submission: receipt ? { ...receipt } : null,
        };
      }),
    );
  }

  private resolve(selector: unknown, state: DesktopAppState): SessionRef {
    const query = text(selector, "session");
    const sessions = this.sessions(state);
    const exact = sessions.filter(
      (session) => session.id === query || sessionKey(session) === query,
    );
    const matches = exact.length
      ? exact
      : sessions.filter((session) =>
          session.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        );
    if (!matches.length) throw new ControlError("NOT_FOUND", `No session matches: ${query}`);
    if (matches.length !== 1)
      throw new ControlError(
        "AMBIGUOUS_SESSION",
        `Multiple sessions match ${query}; use workspaceId:sessionId: ${matches.map((s) => sessionKey(s)).join(", ")}`,
      );
    const match = matches[0];
    if (!match) throw new ControlError("NOT_FOUND", "Session no longer exists");
    return { workspaceId: match.workspaceId, sessionId: match.sessionId };
  }

  private session(ref: SessionRef, state = this.store.snapshot()) {
    const result = this.sessions(state).find((entry) => sessionKey(entry) === sessionKey(ref));
    if (!result) throw new ControlError("NOT_FOUND", "Session no longer exists");
    return result;
  }

  private assertGuard(ref: SessionRef, expected: unknown): void {
    if (expected === undefined) return;
    const wanted = record(expected);
    const actual = this.session(ref).controlGuard;
    for (const field of ["instanceId", "updatedAt", "cursor", "model", "thinkingLevel"] as const)
      if (wanted[field] !== actual[field])
        throw new ControlError("SESSION_CHANGED", `Session changed before dispatch: ${field}`);
  }

  private send(ref: SessionRef, message: string, mode: unknown, expected?: unknown) {
    this.assertGuard(ref, expected);
    if (mode !== "send" && mode !== "queue" && mode !== "steer")
      throw new ControlError("INVALID_REQUEST", "mode must be send, queue or steer");
    const current = this.session(ref);
    if (this.configuring.has(sessionKey(ref)))
      throw new ControlError("SESSION_BUSY", "Session configuration is changing");
    if (
      mode === "send" &&
      (current.status === "running" ||
        current.status === "waiting" ||
        current.status === "queued" ||
        current.pending)
    )
      throw new ControlError("SESSION_BUSY", "Session is busy; use --mode queue or --mode steer");
    // Before the runtime reports running, a second prompt could otherwise start a competing run.
    if (current.pending && current.status !== "running" && current.status !== "waiting")
      throw new ControlError(
        "SESSION_STARTING",
        "Session is starting or settling; inspect status before sending again",
      );
    const before = current.controlGuard;
    const key = sessionKey(ref);
    const submission: Submission = { id: randomUUID(), mode, state: "pending" };
    this.latest.set(key, submission);
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    if (mode === "send" && this.store.subscribeToSessionEvents) this.journal.status(ref, "queued");
    void this.store
      .submitControlMessage(
        ref,
        message,
        mode === "steer" ? "steer" : "followUp",
        expected === undefined
          ? undefined
          : () => {
              // Rechecked by the store after session hydration, before the first write.
              // The control-owned queued status is the only allowed intervening event.
              const actual = this.session(ref);
              if (actual.archived || actual.status === "running" || actual.status === "waiting")
                throw new ControlError("SESSION_CHANGED", "Session started before guarded send");
              this.assertGuard(ref, {
                ...record(expected),
                cursor: this.journal.logs(ref).at(-1)?.seq ?? 0,
              });
              const intervening = this.journal.logs(ref, before.cursor);
              if (intervening.some((event) => event.kind !== "status" || event.status !== "queued"))
                throw new ControlError("SESSION_CHANGED", "Runtime changed before guarded send");
            },
      )
      .then(async () => {
        const state = await this.store.getStateForView({
          selectedWorkspaceId: ref.workspaceId,
          selectedSessionId: ref.sessionId,
        });
        const error = state.lastError;
        submission.state = error ? "failed" : "complete";
        if (error) submission.error = error;
      })
      .catch((error: unknown) => {
        submission.state = "failed";
        submission.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        submission.sessionUpdatedAt = this.store
          .snapshot()
          .workspaces.find((workspace) => workspace.id === ref.workspaceId)
          ?.sessions.find((session) => session.id === ref.sessionId)?.updatedAt;
        const count = (this.pending.get(key) ?? 1) - 1;
        if (count) this.pending.set(key, count);
        else this.pending.delete(key);
        if (!count && this.journal.state(ref)?.status === "queued")
          this.journal.status(ref, submission.state === "failed" ? "failed" : "idle");
      });
    return {
      accepted: true,
      session: ref,
      submissionId: submission.id,
      mode,
      controlGuard: before,
    };
  }

  async handle(raw: unknown): Promise<unknown> {
    const snapshot = this.store.snapshot();
    if (!snapshot.localControlEnabled)
      throw new ControlError("DISABLED", "Local control API is disabled in Settings");
    const input = record(raw);
    const operation = text(input.operation, "operation");
    if (this.store.getControlMetadata) {
      await Promise.all(
        snapshot.workspaces.flatMap((workspace) =>
          workspace.sessions.map(async (session) => {
            const ref = { workspaceId: workspace.id, sessionId: session.id };
            this.metadata.set(sessionKey(ref), await this.store.getControlMetadata!(ref));
          }),
        ),
      );
    }
    if (!this.store.snapshot().localControlEnabled)
      throw new ControlError("DISABLED", "Local control was disabled");
    if (operation === "sessions") return { sessions: this.sessions(snapshot) };
    if (operation === "lanes") {
      await Promise.all(this.sessions(snapshot).map((ref) => this.hydrateLogs(ref)));
      const group = input.group === undefined ? undefined : text(input.group, "group");
      return {
        lanes: this.sessions(snapshot)
          .filter((session) => !group || session.laneGroup === group)
          .map((session) => ({
            ...session,
            stage: session.stage ?? null,
            progress: session.progress ?? null,
            startedAt: session.startedAt ?? null,
            finishedAt: session.finishedAt ?? null,
            elapsed: session.elapsed ?? null,
            resultPath: session.resultPath ?? null,
            lastLine: session.lastLine ?? null,
          })),
      };
    }
    if (operation === "stream") {
      const ref = input.session === undefined ? undefined : this.resolve(input.session, snapshot);
      const since = this.cursor(input.since);
      const refs = ref ? [ref] : this.sessions(snapshot);
      await Promise.all(refs.map((entry) => this.hydrateLogs(entry)));
      return new ControlStream((push) => {
        const matches = (event: { workspaceId: string; sessionId: string; seq: number }) =>
          event.seq > since &&
          (!ref || (event.sessionId === ref.sessionId && event.workspaceId === ref.workspaceId));
        const unsubscribe = this.journal.subscribe((event) => {
          if (matches(event)) push(event);
        });
        for (const event of this.journal.logs(ref, since)) push(event);
        return unsubscribe;
      });
    }
    if (operation === "new") {
      if (input.draft !== undefined && typeof input.draft !== "boolean")
        throw new ControlError("INVALID_REQUEST", "draft must be boolean");
      if (input.draft === true && input.message !== undefined)
        throw new ControlError("INVALID_REQUEST", "A draft cannot include a message");
      const message = input.draft === true ? undefined : this.message(input.message);
      const cwd = text(input.cwd, "cwd");
      const model = input.model === undefined ? undefined : text(input.model, "model");
      if (model && !/^[^/]+\/.+/.test(model))
        throw new ControlError("INVALID_REQUEST", "model must be provider/id");
      let name = input.name === undefined ? undefined : text(input.name, "name");
      if (input.zone !== undefined) {
        const zone = text(input.zone, "zone");
        if (!LANCER_SESSION_ZONES.some((entry) => entry.id === zone))
          throw new ControlError("INVALID_REQUEST", "zone must be video, research, lancer or xhs");
        name = formatSessionTitleForZone(zone, name ?? "New thread");
      }
      const group = input.group === undefined ? undefined : text(input.group, "group");
      const orchestratorId =
        input.orchestrator === undefined ? undefined : text(input.orchestrator, "orchestrator");
      if (input.role !== undefined && input.role !== "lead" && input.role !== "lane")
        throw new ControlError("INVALID_REQUEST", "role must be lead or lane");
      const ref = await this.create({ cwd, model, name });
      if (group || orchestratorId || input.role) {
        await this.updateMetadata(ref, {
          laneGroup: group,
          orchestratorId,
          role: (input.role as "lead" | "lane" | undefined) ?? (orchestratorId ? "lane" : "lead"),
        });
      }
      if (!this.store.snapshot().localControlEnabled)
        throw new ControlError("DISABLED", "Local control was disabled");
      if (message === undefined) return { created: true, started: false, ...ref };
      return this.send(ref, message, "send");
    }
    const ref = this.resolve(input.session, snapshot);
    if (operation === "logs") {
      const since = this.cursor(input.since);
      await this.hydrateLogs(ref);
      return { events: this.journal.logs(ref, since) };
    }
    if (operation === "stop") {
      const key = sessionKey(ref);
      let stopping = this.stopping.get(key);
      if (!stopping) {
        if (!this.store.cancelCurrentRun)
          throw new ControlError("UNAVAILABLE", "Cancellation unavailable");
        stopping = this.store.cancelCurrentRun(ref);
        this.stopping.set(key, stopping);
      }
      try {
        await stopping;
        const current = this.journal.state(ref)?.status;
        if (current === "running" || current === "waiting" || current === "queued") {
          this.journal.status(ref, "failed");
          await this.updateMetadata(
            ref,
            { runtimeStatus: "failed", finishedAt: this.journal.state(ref)?.finishedAt },
            false,
          );
        }
      } finally {
        this.stopping.delete(key);
      }
      return { stopped: true, session: ref };
    }
    if (operation === "set-thinking" || operation === "set-model") {
      const key = sessionKey(ref);
      this.assertGuard(ref, input.expected);
      const current = this.session(ref);
      if (
        current.pending ||
        ["running", "waiting", "queued"].includes(current.status) ||
        this.configuring.has(key) ||
        this.stopping.has(key)
      )
        throw new ControlError(
          "SESSION_BUSY",
          "Session must be idle before changing model or thinking",
        );
      this.configuring.add(key);
      try {
        if (operation === "set-model") {
          const model = text(input.model, "model");
          if (!/^[^/\s]+\/[^\s]+$/.test(model))
            throw new ControlError("INVALID_REQUEST", "model must be exact provider/id");
          if (!this.store.setSessionModel)
            throw new ControlError("UNAVAILABLE", "Session model control unavailable");
          const slash = model.indexOf("/");
          const state = await this.store.setSessionModel(
            ref,
            model.slice(0, slash),
            model.slice(slash + 1),
          );
          if (state.lastError) throw new Error(state.lastError);
          const actual = this.session(ref, state);
          return { session: ref, model: actual.model, controlGuard: actual.controlGuard };
        }
        let thinkingLevel: ReturnType<typeof expectThinkingLevel>;
        try {
          thinkingLevel = expectThinkingLevel(input.thinkingLevel);
        } catch (error) {
          throw new ControlError(
            "INVALID_REQUEST",
            error instanceof Error ? error.message : String(error),
          );
        }
        if (!this.store.setSessionThinkingLevel)
          throw new ControlError("UNAVAILABLE", "Session thinking control unavailable");
        const state = await this.store.setSessionThinkingLevel(ref, thinkingLevel);
        if (state.lastError) throw new Error(state.lastError);
        const actual = this.session(ref, state);
        return {
          session: ref,
          thinkingLevel: actual.thinkingLevel,
          controlGuard: actual.controlGuard,
        };
      } finally {
        this.configuring.delete(key);
      }
    }
    if (operation === "set-result") {
      const workspace = this.session(ref).cwd;
      const root = await realpath(workspace);
      const path = await realpath(resolve(root, text(input.path, "path")));
      const inside = relative(root, path);
      if (
        !inside ||
        inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        inside === ".." ||
        isAbsolute(inside) ||
        !(await stat(path)).isFile()
      )
        throw new ControlError("INVALID_REQUEST", "result must be a file inside the workspace");
      await this.updateMetadata(ref, { resultPath: path });
      return { session: ref, resultPath: path };
    }
    if (operation === "set-stage") {
      const saved = this.metadata.get(sessionKey(ref));
      const stage =
        input.stage === undefined
          ? (saved?.stage ?? null)
          : input.stage === null
            ? null
            : text(input.stage, "stage");
      if (stage && stage.length > 120)
        throw new ControlError("INVALID_REQUEST", "stage exceeds 120 characters");
      const progress = input.progress === undefined ? (saved?.progress ?? null) : input.progress;
      if (
        progress !== null &&
        (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0 || progress > 1)
      )
        throw new ControlError("INVALID_REQUEST", "progress must be null or 0..1");
      await this.updateMetadata(ref, {
        ...(input.stage === undefined ? {} : { stage }),
        ...(input.progress === undefined ? {} : { progress }),
      });
      return { session: ref, stage, progress };
    }
    if (operation === "send")
      return this.send(ref, this.message(input.message), input.mode ?? "send", input.expected);
    if (operation !== "tail" && operation !== "wait")
      throw new ControlError("INVALID_REQUEST", `Unknown operation: ${operation}`);
    const view = { selectedWorkspaceId: ref.workspaceId, selectedSessionId: ref.sessionId };
    const state = await this.store.getStateForView(view);
    const session = this.session(ref, state);
    const done =
      session.status !== "running" &&
      session.status !== "waiting" &&
      session.status !== "queued" &&
      session.pending === 0;
    const error =
      state.lastError ??
      (session.submission?.state === "failed" &&
      session.submission.sessionUpdatedAt === session.updatedAt
        ? session.submission.error
        : undefined);
    const result = {
      session,
      done,
      outcome: done
        ? error || session.status === "failed"
          ? "failed"
          : session.status === "done" &&
              this.journal
                .logs(ref)
                .some((event) => event.kind === "runCompleted" && event.outcome === "completed")
            ? "completed"
            : "idle"
        : session.status,
      error,
    };
    if (operation === "wait") return result;
    const n = input.n ?? 20;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 1000)
      throw new ControlError("INVALID_REQUEST", "n must be an integer from 1 to 1000");
    const transcript = (await this.store.getSelectedTranscriptForView(view))?.transcript ?? [];
    const lastAssistant = [...transcript]
      .reverse()
      .find((item) => item.kind === "message" && item.role === "assistant");
    return {
      ...result,
      messages: transcript.slice(-n),
      lastAssistant: lastAssistant?.kind === "message" ? lastAssistant.text : null,
    };
  }

  private async hydrateLogs(ref: SessionRef): Promise<void> {
    if (this.journal.logs(ref).length) return;
    const selected = await this.store.getSelectedTranscriptForView({
      selectedWorkspaceId: ref.workspaceId,
      selectedSessionId: ref.sessionId,
    });
    const items: SessionTranscriptItem[] = [];
    for (const item of selected?.transcript ?? []) {
      if (item.kind === "message") items.push(item);
      if (item.kind === "tool" && item.status !== "running")
        items.push({ ...item, status: item.status });
    }
    this.journal.seed(ref, items);
  }

  private cursor(value: unknown): number {
    if (value === undefined) return 0;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new ControlError("INVALID_REQUEST", "since must be a nonnegative safe integer");
    return value;
  }

  private async updateMetadata(
    ref: SessionRef,
    patch: Parameters<DesktopAppStore["updateControlMetadata"]>[1],
    publish = true,
  ): Promise<void> {
    if (!this.store.updateControlMetadata)
      throw new ControlError("UNAVAILABLE", "Metadata storage unavailable");
    await this.store.updateControlMetadata(ref, patch);
    this.metadata.set(sessionKey(ref), { ...this.metadata.get(sessionKey(ref)), ...patch });
    if (publish)
      this.journal.status(
        ref,
        this.journal.state(ref)?.status ?? this.session(ref).status,
        undefined,
        patch,
      );
  }

  private message(value: unknown): string {
    const message = text(value, "message");
    // Commands can navigate windows or consume composer state; this text-only API never impersonates a window.
    if (message.trimStart().startsWith("/"))
      throw new ControlError(
        "INVALID_REQUEST",
        "Slash commands require the Lancer composer; send a plain-text instruction instead",
      );
    return message;
  }
}
