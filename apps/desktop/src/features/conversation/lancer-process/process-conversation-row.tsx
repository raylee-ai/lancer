import { RunningBorder } from "./running-border";
import { Fragment, type ReactNode } from "react";
import type {
  ProcessEvent,
  ProcessMessage,
  ProcessSurfaceActions,
  ProcessViewState,
} from "./process-types";
import { actorName, clock, EVENT_NAMES, knownDurationSeconds } from "./process-math";
import { ProcessActorIcon, ProcessGlyph, useProcessData } from "./process-glyph";
import { ShellAssistantAvatar } from "./assistant-avatar";

/** The prototype's colored code spans, parsed as text (never executable/raw HTML). */
export function ProcessCode({ text }: { readonly text: string }) {
  return (
    <>
      {text.split("\n").map((line, lineIndex) => {
        let color = "";
        const pieces: ReactNode[] = [];
        for (const [index, part] of line.split(/(<\/?[arc]>)/g).entries()) {
          if (/^<[arc]>$/.test(part)) color = part[1]!;
          else if (/^<\/[arc]>$/.test(part)) color = "";
          else if (part)
            pieces.push(
              <span key={index} className={color || (line.startsWith("$ ") ? "p" : undefined)}>
                {part}
              </span>,
            );
        }
        return (
          <Fragment key={lineIndex}>
            {lineIndex ? "\n" : null}
            {pieces}
          </Fragment>
        );
      })}
    </>
  );
}
export function ProcessArtifactCard({ card }: { readonly card?: string }) {
  const data = useProcessData();
  if (!card) return null;
  if (card === "kf")
    return (
      <div className="kfs" aria-label="关键帧 ×6">
        {["00:02", "00:09", "00:21", "00:34", "00:52", "01:10"].map((time, i) => (
          <div key={time} className={i % 2 ? "" : "k"}>
            <span>{time}</span>
          </div>
        ))}
      </div>
    );
  const split = card.indexOf(":");
  const kind = card.slice(0, split),
    parts = card.slice(split + 1).split("|");
  if (kind === "file")
    return (
      <div className="fc">
        <span className="fi">{parts[2]}</span>
        <span>
          <b>{parts[0]}</b>
          <small>{parts[1]}</small>
        </span>
        <button type="button" className="op2">
          打开
        </button>
      </div>
    );
  const [from = "", to = ""] = (parts[0] ?? "").split(">");
  return (
    <div className="hp process-handoff" data-process-id="handoff">
      <div className="h">
        <ProcessActorIcon actor={from} />
        <span className="mu">→</span>
        <ProcessActorIcon actor={to} />
        交接包 · {actorName(data, from)} → {actorName(data, to)}
        <span className="ok">context {parts[4]}</span>
      </div>
      <div className="r">
        <span>文件</span>
        <span className="mono">{parts[1]}</span>
      </div>
      <div className="r">
        <span>摘要</span>
        <span>{parts[2]}</span>
      </div>
      <div className="r">
        <span>决策</span>
        <span>{parts[3]}</span>
      </div>
    </div>
  );
}
export function ProcessConversationRow({
  message,
  event,
  state,
  actions,
  global = false,
}: {
  readonly message: ProcessMessage;
  readonly event?: ProcessEvent;
  readonly state: ProcessViewState;
  readonly actions: ProcessSurfaceActions;
  readonly global?: boolean;
}) {
  const data = useProcessData();
  if (message.kind === "user")
    return <div className="um process-user">{message.nativeBody ?? message.text}</div>;
  if (message.kind === "assistant") {
    const threadId = `t${message.time}`;
    const threadOpen = state.open.has(threadId);
    return (
      <div
        className={`am process-assistant ${state.highlighted === message.id ? "process-assistant--hl" : ""}`}
        data-running={message.running || undefined}
        data-process-id={message.id}
      >
        {message.running ? <RunningBorder radius={5} /> : null}
        <span
          className="process-bubble-anchor"
          aria-hidden="true"
          data-chat-anchor={state.flightTimes ? event?.id : undefined}
          data-anchor-key={state.flightTimes && event ? `chat:${event.id}` : undefined}
        />
        <div className="who">
          <ShellAssistantAvatar
            identity={data.assistantId ?? message.actor ?? "grok"}
            avatar={data.assistants?.profiles.find((p) => p.id === data.assistantId)?.avatar}
          />
          <b title={actorName(data, message.actor ?? "grok")}>
            {data.assistants?.profiles.find((p) => p.id === data.assistantId)?.name ??
              actorName(data, message.actor ?? "grok")}
          </b>
          <time className="process-message-time">
            {message.timestampLabel ?? (data.assistants ? "" : clock(message.time))}
          </time>
        </div>
        <div className="tx">{message.nativeBody ?? message.text}</div>
        {message.completed ? (
          <span className="rx">
            <b>✓</b> 阶段完成
          </span>
        ) : null}
        {message.replies ? (
          <>
            <button type="button" className="thr" onClick={() => actions.onToggle(threadId)}>
              {threadOpen ? "▾" : "▸"} {message.replies.length} 条回复
            </button>
            {threadOpen ? (
              <div className="thb">
                {message.replies.map(([who, text], i) => (
                  <div key={i}>
                    <b>{who}</b>
                    {text}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    );
  }
  // Summary records have no tree node, but their saved content still belongs
  // in the conversation. Only node-backed rows use the interactive process header.
  if (!event) return message.nativeBody ?? null;
  const done = !event.running && event.time <= state.time;
  const open = state.open.has(message.id);
  const lane = data.lanes.find((lane) => lane.id === event.lane)!;
  const highlighted = state.highlighted === event.id || state.hovered === event.id;
  const steps = message.steps ?? [];
  // Local results such as /status are activity steps inside this stage. The
  // collapsed header only names the first one ("Resumed session"), so the
  // command text has to stay in the row or it never appears in the transcript.
  const closedActivityLabels = steps.filter(
    (step) => !step.nativeBody && step.kind !== "think" && step.label,
  );
  const seconds = knownDurationSeconds(steps);
  const durationSuffix = seconds === null ? "" : ` · ${seconds}s`;
  const groupId = `g${message.id}`;
  // Real tool bodies used to force this group open, making its toggle inert.
  const groupOpen = !state.open.has(groupId);
  const kind = EVENT_NAMES[event.kind];
  const title = event.artifactPath
    ? `${message.text ?? "交付"} · ${event.label} · ${event.hash}`
    : event.label.startsWith(kind.slice(0, 2)) || event.label.startsWith(kind.slice(-2))
      ? event.label
      : `${kind} · ${event.label}`;
  return (
    <div
      className={`process-stage ${open ? "process-stage--open" : ""} ${highlighted ? "process-stage--hl" : ""}`}
      data-process-id={message.id}
      data-unverified={event.unverified || undefined}
      data-scroll-target={event.id}
    >
      <button
        type="button"
        className={`eh process-stage__head ${open ? "op" : ""} ${done ? "" : "pend"} ${highlighted ? "hl" : ""}`}
        data-running={Boolean(event.running && !event.fail && event.kind !== "error")}
        data-ev={event.id}
        data-tg={message.id}
        style={{ "--lc": event.unverified ? "#9ca3af" : lane.color } as React.CSSProperties}
        aria-expanded={open}
        onClick={() => actions.onToggle(message.id)}
      >
        {event.running && !event.fail && event.kind !== "error" ? <RunningBorder /> : null}
        <span className="cv2">▶</span>
        <span
          className={`gl process-stage__status process-stage__status--${done ? (event.fail || event.kind === "error" ? "error" : "done") : "running"}`}
          data-chat-anchor={event.id}
          data-anchor-key={`chat:${event.id}`}
        >
          {done ? (
            <ProcessGlyph
              event={event}
              confirmed={state.time >= event.time + (event.waitDuration ?? 0)}
            />
          ) : (
            <span className="gg pending-glyph" />
          )}
        </span>
        {global ? (
          <span className="lt" style={{ background: lane.color }}>
            {lane.name}
          </span>
        ) : null}
        <span className="ti process-stage__title">
          {done ? title : `正在${event.kind === "handoff" ? "交接" : "处理"} · ${event.label}…`}
        </span>
        <span className="mt">
          {done
            ? event.artifactPath
              ? (event.errorCode ?? event.statusCode)
              : `${steps.length ? `${steps.length} 步` : ""}${durationSuffix}`
            : `${actorName(data, event.actor)} 工作中`}
        </span>
      </button>
      {!open && closedActivityLabels.length > 0 ? (
        <div className="process-stage__activities">
          {closedActivityLabels.map((step) => (
            <span key={step.id} className="process-stage__activity">
              {step.label}
            </span>
          ))}
        </div>
      ) : null}
      {open ? (
        <div className="eb process-stage__body">
          {steps.length ? (
            <button
              type="button"
              className="sgp"
              aria-expanded={groupOpen}
              onClick={() => actions.onToggle(groupId)}
            >
              {groupOpen ? "▾" : "▸"}{" "}
              {event.artifacts
                ? `${steps.length} 个产物 · ${event.unverified ? "未验证" : (event.statusCode ?? "")}`
                : `${done ? "已完成" : "运行中"} ${steps.length} 个步骤${seconds === null ? "" : ` · ${seconds} 秒`}`}
            </button>
          ) : null}
          {groupOpen && steps.length ? (
            <div className="slst">
              {steps.map((step) => {
                if (step.nativeBody) return <Fragment key={step.id}>{step.nativeBody}</Fragment>;
                const expanded = state.open.has(step.id),
                  thinking = step.kind === "think";
                const verb = { think: "", run: "运行", read: "读取", search: "搜索", edit: "编辑" }[
                  step.kind
                ];
                return (
                  <Fragment key={step.id}>
                    <button
                      type="button"
                      className={`srw ${expanded ? "op" : ""}`}
                      aria-expanded={expanded}
                      data-tg={step.id}
                      onClick={() => actions.onToggle(step.id)}
                    >
                      <span className="cv2">▶</span>
                      {thinking ? (
                        <span className="k">{step.label}</span>
                      ) : (
                        <>
                          {verb} <span className="k">{step.label}</span>
                        </>
                      )}
                      <span className="d">{thinking ? "" : step.duration}</span>
                    </button>
                    {expanded ? (
                      <div className={`sdt ${thinking ? "th" : ""}`}>
                        <ProcessCode text={step.detail} />
                      </div>
                    ) : null}
                  </Fragment>
                );
              })}
            </div>
          ) : null}
          {event.kind === "wait" ? (
            <>
              <div className="opt">
                <span>标题 A · 一周通勤穿搭</span>
                <span className={state.time >= event.time + (event.waitDuration ?? 0) ? "on" : ""}>
                  标题 B · 5 套上班不费脑
                </span>
              </div>
              <div className="smp">
                {state.time >= event.time + (event.waitDuration ?? 0)
                  ? "你选择了 标题 B"
                  : "等待你选择标题"}
              </div>
            </>
          ) : null}
          {message.nativeBody}
          <ProcessArtifactCard card={message.card} />
        </div>
      ) : null}
    </div>
  );
}
