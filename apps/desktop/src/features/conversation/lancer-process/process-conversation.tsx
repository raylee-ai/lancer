import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { DisplayTimelineItem } from "../../../../contracts/timeline-types";
import { useTimelineViewport, type TimelineViewport } from "../hooks/use-timeline-viewport";
import { ProcessConversationRow } from "./process-conversation-row";
import { TranscriptHydrateError } from "../conversation-timeline";
import "./process-global.css";
import "./conversation-layout.css";
import { useProcessData } from "./process-glyph";
import type { ProcessSurfaceActions, ProcessViewState } from "./process-types";
import { visibleProcessMessages } from "./visible-process-messages";
import { t } from "../../../../contracts/i18n";

export function ProcessConversation({
  state,
  actions,
  viewport,
  sessionKey,
  onViewport,
  search,
  headerContent,
  loading,
  failure,
  onRetry,
  notifications = true,
}: {
  readonly state: ProcessViewState;
  readonly actions: ProcessSurfaceActions;
  readonly viewport?: TimelineViewport;
  readonly sessionKey: string;
  readonly onViewport?: (viewport: TimelineViewport) => void;
  readonly search?: ReactNode;
  readonly headerContent?: ReactNode;
  readonly loading?: boolean;
  readonly failure?: boolean;
  readonly onRetry?: () => void;
  readonly notifications?: boolean;
}) {
  const data = useProcessData();
  const items = useMemo(() => visibleProcessMessages(data, state), [data, state.lane, state.time]);
  const conversationEvents = data.conversationEvents ?? data.events;
  const pane = useRef<HTMLDivElement>(null);
  const rows = useMemo<readonly DisplayTimelineItem[]>(
    () =>
      items.map((message) => ({
        kind: "activity",
        id: message.anchorId ?? message.id,
        createdAt: "",
        label:
          message.text ??
          conversationEvents.find((event) => event.id === message.eventId)?.label ??
          "",
      })),
    [items, conversationEvents],
  );
  const owned = useTimelineViewport({
    sessionKey,
    active: !viewport,
    transcriptReady: !loading && !failure,
    rows,
    paneRef: pane,
    gap: 6,
  });
  const owner = viewport ?? owned;
  const virtualized = items.length > 30;
  const visible = new Map(owner.visibleRows.map((row) => [row.item.id, row]));
  useLayoutEffect(() => {
    onViewport?.(owner);
  }, [owner, onViewport]);
  const current = data.lanes.find((lane) => lane.id === state.lane);
  const title = data.titles[state.lane];
  return (
    <div className="process-conversation-surface">
      {search}
      {state.lane !== "all" ? headerContent : null}
      <div
        className="cv timeline-pane"
        data-testid="timeline-pane"
        ref={owner.attachPane}
        tabIndex={0}
      >
        <header className="cvh">
          {state.lane === "all" ? (
            <>
              <b>全部会话</b>
              <span className="mu">
                {t("lancer.process.interleaved", { count: data.lanes.length })}
              </span>
              <span className="smp">点任一行展开过程</span>
            </>
          ) : (
            <>
              <span className="tg" style={{ background: current?.color }}>
                {data.assistants ? (current?.parentLaneId ? "分支" : "会话") : current?.name}
              </span>
              <b data-testid="thread-title">{title?.title}</b>
              <span className="smp">{title?.branch}</span>
            </>
          )}
          {actions.onToggleAll ? (
            <button type="button" onClick={actions.onToggleAll}>
              {state.open.size ? "全部折叠" : "展开详情"}
            </button>
          ) : null}
        </header>
        {failure ? (
          <TranscriptHydrateError retrying={Boolean(loading)} onRetry={onRetry} />
        ) : loading ? (
          <div data-testid="transcript-skeleton">加载中…</div>
        ) : (
          <div
            className={`cc process-conversation-items ${state.lane === "all" ? "process-conversation-items--global" : "process-conversation-items--lane"} ${virtualized ? "timeline--virtualized" : ""}`}
            data-testid="transcript"
            style={virtualized ? { height: owner.totalHeight } : undefined}
          >
            {items.map((message) => {
              const id = message.anchorId ?? message.id,
                placement = visible.get(id);
              if (virtualized && !placement) return null;
              return (
                <MeasuredProcessMessage
                  key={message.id}
                  id={id}
                  viewport={owner}
                  top={virtualized ? placement?.top : undefined}
                >
                  <ProcessConversationRow
                    message={message}
                    event={conversationEvents.find((event) => event.id === message.eventId)}
                    state={state}
                    actions={actions}
                    global={state.lane === "all"}
                  />
                </MeasuredProcessMessage>
              );
            })}
          </div>
        )}
        {notifications && owner.showJumpToLatest ? (
          <button
            type="button"
            className="timeline-jump"
            data-testid="timeline-jump"
            onClick={owner.jumpToLatest}
          >
            下方有新动态
          </button>
        ) : null}
      </div>
    </div>
  );
}
function MeasuredProcessMessage({
  id,
  viewport,
  top,
  children,
}: {
  readonly id: string;
  readonly viewport: TimelineViewport;
  readonly top?: number;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () =>
      viewport.measureRow(id, element.getBoundingClientRect().height, viewport.layoutGeneration);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [id, viewport.measureRow, viewport.layoutGeneration]);
  return (
    <div
      ref={ref}
      data-message-id={id}
      className="process-timeline__block"
      style={top === undefined ? undefined : { position: "absolute", top, left: 0, right: 0 }}
    >
      {children}
    </div>
  );
}
