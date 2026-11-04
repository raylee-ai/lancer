import { t, type MessageKey } from "../../../../contracts/i18n";
import type { TrajectoryNode } from "./trajectory-model";

/**
 * Shared by the legend and event rendering. `labelKey` is resolved at render
 * time; the Chinese `pattern`s stay verbatim because they match transcript
 * titles produced by the runtime, not interface copy.
 */
export const TRAJECTORY_EVENTS = [
  { key: "submit", labelKey: "lancer.trajectory.submit", pattern: /^提交\/保存/ },
  { key: "handoff", labelKey: "lancer.trajectory.handoff", pattern: /^(?:Handoff|交接|接收交接)/i },
  { key: "checkpoint", labelKey: "lancer.trajectory.checkpoint", pattern: /^检查点/ },
  { key: "test", labelKey: "lancer.trajectory.test", pattern: /^测试.*(?:通过|成功)/ },
  { key: "test-fail", labelKey: "lancer.trajectory.testFail", pattern: /^测试.*失败/ },
  { key: "review", labelKey: "lancer.trajectory.review", pattern: /^审查/ },
  { key: "fork", labelKey: "lancer.trajectory.fork", pattern: /^分叉/ },
  { key: "merge", labelKey: "lancer.trajectory.merge", pattern: /^合并/ },
  { key: "artifact", labelKey: "lancer.trajectory.artifact", pattern: /^(?:产物|已保存)/ },
  { key: "tool", labelKey: "lancer.trajectory.tool", pattern: /^工具调用/ },
  { key: "model", labelKey: "lancer.trajectory.model", pattern: /^模型切换/ },
  { key: "compact", labelKey: "lancer.trajectory.compact", pattern: /^(?:上下文压缩|Compaction)/ },
  { key: "wait", labelKey: "lancer.trajectory.wait", pattern: /^等待你/ },
  { key: "xref", labelKey: "lancer.trajectory.xref", pattern: /^(?:跨线引用|引用)/ },
  { key: "error", labelKey: "lancer.trajectory.error", pattern: /^(?:错误|渲染失败)/ },
  { key: "retry", labelKey: "lancer.trajectory.retry", pattern: /^重试/ },
] as const satisfies readonly {
  readonly key: string;
  readonly labelKey: MessageKey;
  readonly pattern: RegExp;
}[];

export type TrajectoryEvent = (typeof TRAJECTORY_EVENTS)[number]["key"];

export function trajectoryEvent(node: TrajectoryNode): TrajectoryEvent {
  if (node.eventType) return node.eventType;
  if (node.kind === "handoff") return "handoff";
  if (node.kind === "compaction") return "compact";
  if (node.kind === "branch_summary") return "fork";
  const explicit = TRAJECTORY_EVENTS.find((event) => event.pattern.test(node.title));
  if (explicit) return explicit.key;
  if (node.kind === "tool_group" || node.state === "tool") return "tool";
  if (node.state === "user" || node.state === "summary") return "checkpoint";
  return "submit";
}

/** Legend label for a trajectory event, already localized. */
export function trajectoryEventLabel(event: TrajectoryEvent): string {
  return t(TRAJECTORY_EVENTS.find((entry) => entry.key === event)!.labelKey);
}

export function trajectoryCaption(node: TrajectoryNode): string {
  return `${trajectoryEventLabel(trajectoryEvent(node))} · ${node.id.slice(-6)}`;
}
