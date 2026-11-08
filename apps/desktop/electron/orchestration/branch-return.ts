import type { SessionDriverEvent } from "@lancer/session-driver";
import type {
  OrchestrationChildThread,
  OrchestrationEvidenceRecord,
  OrchestrationWorktreeCompletion,
} from "../../contracts/desktop-state";
import type { WorktreeInitializationFailure } from "../workspace/session-worktree-sessions";

export const BRANCH_RETURN_TOOL = "lancer-branch-return";
export function branchReturnEvidence(
  child: OrchestrationChildThread,
  event: SessionDriverEvent,
  completion?: OrchestrationWorktreeCompletion,
  initFailure?: WorktreeInitializationFailure,
  completionError?: string,
): OrchestrationEvidenceRecord | undefined {
  if (event.type !== "runCompleted" && event.type !== "runFailed") return;
  if (
    child.childSessionId !== event.sessionRef.sessionId ||
    child.childWorkspaceId !== event.sessionRef.workspaceId
  )
    return;
  if (event.type === "runCompleted" && event.outcome === "aborted") return;
  if (child.supervisionLoop?.gate === "stop") return;
  const id = `return:${child.id}:${event.runId ?? event.timestamp}`;
  if (child.evidence.some((e) => e.id === id)) return;
  const failed = event.type === "runFailed";
  const result = failed ? event.error.message : child.latestTranscript;
  const completionText =
    completion?.isolation === "shared"
      ? "共用父会话目录，没有独立的改动记录。"
      : completion
        ? `分支：${completion.branch}\n起点提交：${completion.baseSha}\n完成提交：${completion.completedSha}\n改动文件：${completion.files?.join(", ") || "无"}\n差异统计：${completion.stat || "无"}`
        : "";
  const initText = initFailure
    ? `工作树初始化命令失败（退出码：${initFailure.exitCode ?? "无法取得"}）：${initFailure.command}\n${initFailure.output}`
    : "";
  const handoffText =
    completion?.isolation === "worktree"
      ? "请先用 read_thread 读取并核对这个分支指定完成提交的改动，再决定用 merge_child_thread 合入或不合。"
      : completion?.isolation === "shared"
        ? "该子会话共用父会话目录，没有独立的改动记录，不能按独立补丁合入。"
        : "这次没有记录到可供核对的独立完成提交，不要尝试合入。";
  return {
    id,
    childThreadId: child.id,
    kind: "worker_report",
    source: "worker-reported",
    status: "reported",
    title: failed ? "分支失败回传" : "分支完成回传",
    toolName: BRANCH_RETURN_TOOL,
    ...(completion ? { completion } : {}),
    detail: [
      `[${id}]`,
      `并行分支「${child.title}」${failed ? "失败" : "已完成"}。`,
      `任务：${child.goal}`,
      `结果（分支报告，需核对）：\n${result}`,
      completionText,
      initText,
      completionError ? `无法记录独立改动：${completionError}` : "",
      handoffText,
      "继续完成你在当前会话中已获授权的原任务，包括要求生成的汇总文件。尚有依赖未完成时说明进展；依赖齐备后完成原定交付。不要因为这条回传自动重试或创建额外任务。",
    ]
      .filter(Boolean)
      .join("\n\n"),
    parentSessionId: child.parentSessionId,
    childSessionId: child.childSessionId,
    createdAt: event.timestamp,
  };
}
