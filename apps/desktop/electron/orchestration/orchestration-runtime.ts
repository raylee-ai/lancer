import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { OrchestrationWorktreeCompletion } from "../../contracts/desktop-state";

export const createChildThreadToolName = "create_child_thread";
export const createChildThreadAction = "pi_gui_create_child_thread";
export const listThreadsToolName = "list_threads";
export const listThreadsAction = "pi_gui_list_threads";
export const readThreadToolName = "read_thread";
export const readThreadAction = "pi_gui_read_thread";
export const sendMessageToThreadToolName = "send_message_to_thread";
export const sendMessageToThreadAction = "pi_gui_send_message_to_thread";
export const mergeChildThreadToolName = "merge_child_thread";
export const mergeChildThreadAction = "pi_gui_merge_child_thread";

export interface CreateChildThreadToolDetails {
  readonly action: typeof createChildThreadAction;
  readonly prompt: string;
  readonly isolation?: "worktree" | "shared";
  readonly childThreadId?: string;
  readonly childWorkspaceId?: string;
  readonly childSessionId?: string;
  readonly title?: string;
  readonly deliveryStatus?: "running" | "responded";
  readonly error?: string;
}

export interface OrchestrationThreadListEntry {
  readonly threadId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly status: string;
  readonly relationship: "current" | "child" | "workspace";
  readonly updatedAt: string;
  readonly preview: string;
  readonly childThreadId?: string;
  readonly supervisionGate?: "continue" | "wake" | "stop";
  readonly supervisionReason?: string;
  readonly nextSupervisionRunAt?: string;
}

export interface OrchestrationThreadTranscriptMessage {
  readonly id: string;
  readonly role: "parent" | "child" | "system";
  readonly text: string;
  readonly createdAt: string;
}

export interface ListThreadsToolDetails {
  readonly action: typeof listThreadsAction;
  readonly threads?: readonly OrchestrationThreadListEntry[];
  readonly error?: string;
}

export interface ReadThreadToolDetails {
  readonly action: typeof readThreadAction;
  readonly threadId: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly title?: string;
  readonly status?: string;
  readonly childThreadId?: string;
  readonly goal?: string;
  readonly messages?: readonly OrchestrationThreadTranscriptMessage[];
  readonly completion?: OrchestrationWorktreeCompletion & { readonly patch: string };
  readonly error?: string;
}

export interface SendMessageToThreadToolDetails {
  readonly action: typeof sendMessageToThreadAction;
  readonly threadId: string;
  readonly message: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly status?: "queued" | "sent";
  readonly queuedMessageCount?: number;
  readonly error?: string;
}

export interface MergeChildThreadToolDetails {
  readonly action: typeof mergeChildThreadAction;
  readonly threadId: string;
  readonly completedSha: string;
  readonly conflicts?: readonly string[];
  readonly applied?: boolean;
  readonly error?: string;
}

export interface OrchestrationRuntimeBridge {
  readonly createChildThread: (
    ctx: ExtensionContext,
    input: {
      readonly prompt: string;
      readonly toolCallId: string;
      readonly isolation: "worktree" | "shared";
    },
  ) => Promise<AgentToolResult<CreateChildThreadToolDetails>>;
  readonly listThreads: (ctx: ExtensionContext) => Promise<AgentToolResult<ListThreadsToolDetails>>;
  readonly readThread: (
    ctx: ExtensionContext,
    input: { readonly threadId: string; readonly commitSha?: string },
  ) => Promise<AgentToolResult<ReadThreadToolDetails>>;
  readonly sendMessageToThread: (
    ctx: ExtensionContext,
    input: { readonly threadId: string; readonly message: string },
  ) => Promise<AgentToolResult<SendMessageToThreadToolDetails>>;
  readonly mergeChildThread: (
    ctx: ExtensionContext,
    input: { readonly threadId: string; readonly completedSha: string },
  ) => Promise<AgentToolResult<MergeChildThreadToolDetails>>;
}

type OrchestrationToolDetails =
  | CreateChildThreadToolDetails
  | ListThreadsToolDetails
  | ReadThreadToolDetails
  | SendMessageToThreadToolDetails
  | MergeChildThreadToolDetails;

function createCreateChildThreadTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: createChildThreadToolName,
    label: "Create child thread",
    description:
      "Start a child thread for delegated work. File-changing tasks use an isolated worktree by default; read-only research may use shared isolation.",
    promptSnippet: "Start a separate Lancer child thread for delegated work.",
    promptGuidelines: [
      "Use create_child_thread when the user asks you to spin up, delegate to, or run a separate child thread.",
      "Keep the child prompt self-contained: objective, relevant file paths, constraints and acceptance criteria. Never paste the full parent transcript. Child threads start without parent history; results are batched after siblings settle.",
      "Use the default worktree isolation for tasks that may change files. Set isolation to shared only for read-only research.",
    ],
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Concrete instructions for the child thread.",
        },
        isolation: {
          type: "string",
          enum: ["worktree", "shared"],
          description:
            "Execution isolation. Defaults to worktree; use shared only for read-only research.",
        },
      },
      required: ["prompt"],
    },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const prompt = createChildThreadPromptFromParams(params);
      if (!prompt) {
        throw new Error("create_child_thread requires a non-empty prompt.");
      }
      const isolation = isolationFromParams(params);
      return bridge.createChildThread(ctx, { prompt, toolCallId, isolation });
    },
  };
}

function createListThreadsTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: listThreadsToolName,
    label: "List threads",
    description: "List Lancer threads visible to the current workspace and parent thread.",
    promptSnippet: "List relevant Lancer threads for the current workspace and parent context.",
    promptGuidelines: [
      "Use list_threads before reading or messaging another Lancer thread when you need the exact thread id.",
      "Use the returned thread id with read_thread or send_message_to_thread.",
    ],
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return bridge.listThreads(ctx);
    },
  };
}

function createReadThreadTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: readThreadToolName,
    label: "Read thread",
    description: "Read a Lancer thread transcript or child thread summary by id.",
    promptSnippet: "Read a Lancer thread transcript by id.",
    promptGuidelines: [
      "Use read_thread with a thread id returned by list_threads or create_child_thread.",
      "Prefer reading a child thread before summarizing its status back to the parent.",
    ],
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Thread id, child thread id, or session id to read.",
        },
        commit_sha: {
          type: "string",
          description:
            "Optional full completion commit SHA from a child return to read its exact diff.",
        },
      },
      required: ["thread_id"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const threadId = threadIdFromParams(params);
      if (!threadId) {
        return {
          content: [{ type: "text", text: "read_thread requires a thread_id." }],
          details: {
            action: readThreadAction,
            threadId: "",
            error: "read_thread requires a thread_id.",
          },
        };
      }
      const commitSha = commitShaFromParams(params);
      return bridge.readThread(ctx, { threadId, ...(commitSha ? { commitSha } : {}) });
    },
  };
}

function createSendMessageToThreadTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: sendMessageToThreadToolName,
    label: "Send message to thread",
    description: "Send a follow-up message to an existing Lancer thread.",
    promptSnippet: "Send a follow-up to an existing Lancer thread.",
    promptGuidelines: [
      "Use send_message_to_thread to follow up with an existing child or sibling Lancer thread.",
      "Use a thread id returned by list_threads or create_child_thread.",
    ],
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Thread id, child thread id, or session id to message.",
        },
        message: {
          type: "string",
          description: "Follow-up message to send.",
        },
      },
      required: ["thread_id", "message"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const threadId = threadIdFromParams(params);
      const message = messageFromParams(params);
      if (!threadId || !message) {
        return {
          content: [
            { type: "text", text: "send_message_to_thread requires thread_id and message." },
          ],
          details: {
            action: sendMessageToThreadAction,
            threadId: threadId ?? "",
            message: message ?? "",
            error: "send_message_to_thread requires thread_id and message.",
          },
        };
      }
      return bridge.sendMessageToThread(ctx, { threadId, message });
    },
  };
}

function createMergeChildThreadTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: mergeChildThreadToolName,
    label: "Merge child thread",
    description:
      "Apply only the latest returned, reviewed child-thread completion diff to the parent session directory and clean up its worktree. Merging is refused if the child worktree has any later changes.",
    promptSnippet: "Merge a specific reviewed child completion into the parent session.",
    promptGuidelines: [
      "Only the latest completion returned by the child may be merged. Read that completion diff with read_thread and its full commit_sha before merging.",
      "Pass that exact completed SHA to merge_child_thread. If conflicts are reported, tell the user and do not retry automatically.",
      "If the child worktree has changes after its latest returned completion, do not merge. Ask the child to finish a run and return a new completion, or ask the user to discard and clean up the worktree.",
    ],
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Child thread id returned by create_child_thread or list_threads.",
        },
        completed_sha: {
          type: "string",
          description:
            "Exact SHA of the latest returned child completion after reviewing its diff with read_thread.",
        },
      },
      required: ["thread_id", "completed_sha"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const threadId = threadIdFromParams(params);
      const completedSha =
        isRecord(params) && typeof params.completed_sha === "string"
          ? params.completed_sha.trim()
          : "";
      if (!threadId || !completedSha) {
        throw new Error("merge_child_thread requires thread_id and completed_sha.");
      }
      return bridge.mergeChildThread(ctx, { threadId, completedSha });
    },
  };
}

export function createOrchestrationRuntimeTools(
  bridge: OrchestrationRuntimeBridge,
): readonly ToolDefinition<any, OrchestrationToolDetails>[] {
  return [
    createCreateChildThreadTool(bridge),
    createListThreadsTool(bridge),
    createReadThreadTool(bridge),
    createSendMessageToThreadTool(bridge),
    createMergeChildThreadTool(bridge),
  ];
}

export function createOrchestrationRuntimeExtension(
  bridge: OrchestrationRuntimeBridge,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    for (const tool of createOrchestrationRuntimeTools(bridge)) {
      pi.registerTool(tool);
    }
  };
}

export function createChildThreadPromptFromParams(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  return prompt || undefined;
}

function commitShaFromParams(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  const value = typeof params.commit_sha === "string" ? params.commit_sha.trim() : "";
  return value || undefined;
}

function isolationFromParams(params: unknown): "worktree" | "shared" {
  if (!isRecord(params) || params.isolation === undefined) return "worktree";
  if (params.isolation === "worktree" || params.isolation === "shared") return params.isolation;
  throw new Error('create_child_thread isolation must be "worktree" or "shared".');
}

export function createChildThreadPromptFromToolOutput(output: unknown): string | undefined {
  if (!isRecord(output) || !isRecord(output.details)) {
    return undefined;
  }
  if (output.details.action !== createChildThreadAction) {
    return undefined;
  }
  return createChildThreadPromptFromParams(output.details);
}

export function listThreadsRequestedFromToolOutput(output: unknown): boolean {
  return toolOutputDetails(output)?.action === listThreadsAction;
}

export function readThreadIdFromToolOutput(output: unknown): string | undefined {
  const details = toolOutputDetails(output);
  if (details?.action !== readThreadAction) {
    return undefined;
  }
  return threadIdFromParams(details);
}

export function sendMessageToThreadFromToolOutput(
  output: unknown,
): { readonly threadId: string; readonly message: string } | undefined {
  const details = toolOutputDetails(output);
  if (details?.action !== sendMessageToThreadAction) {
    return undefined;
  }
  const threadId = threadIdFromParams(details);
  const message = messageFromParams(details);
  if (!threadId || !message) {
    return undefined;
  }
  return { threadId, message };
}

function toolOutputDetails(output: unknown): Record<string, unknown> | undefined {
  if (!isRecord(output) || !isRecord(output.details)) {
    return undefined;
  }
  return output.details;
}

function threadIdFromParams(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const threadId =
    stringParam(params, "thread_id") ??
    stringParam(params, "threadId") ??
    stringParam(params, "id");
  return threadId || undefined;
}

function messageFromParams(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const message = stringParam(params, "message") ?? stringParam(params, "text");
  return message || undefined;
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
