import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { t, tPlural } from "../../../../contracts/i18n";
import {
  lancerZoneById,
  conversationZoneId,
  stripLancerZonePrefix,
} from "../../../../contracts/lancer-zones";
import type { TrajectoryLane, TrajectoryMetaChip, TrajectoryNode } from "./trajectory-model";

export interface TrajectoryHandoffEdge {
  readonly id: string;
  readonly fromLaneId: string;
  readonly toLaneId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly label?: string;
}

import {
  TRAJECTORY_EVENTS,
  trajectoryCaption,
  trajectoryEvent,
  trajectoryEventLabel,
} from "./trajectory-events";

type EdgePath = { readonly edge: TrajectoryHandoffEdge; readonly d: string };

export function MultiLaneTrajectoryPanel({
  lanes,
  laneNodes,
  handoffs,
  metaChips = [],
  loading,
  error,
  highlightedNodeId,
  onSelectNode,
}: {
  readonly lanes: readonly TrajectoryLane[];
  readonly laneNodes: ReadonlyMap<string, readonly TrajectoryNode[]>;
  readonly handoffs: readonly TrajectoryHandoffEdge[];
  readonly metaChips?: readonly TrajectoryMetaChip[];
  readonly loading: boolean;
  readonly error?: string;
  readonly highlightedNodeId?: string | null;
  readonly onSelectNode: (node: TrajectoryNode) => void;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [paths, setPaths] = useState<readonly EdgePath[]>([]);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || loading || error) {
      setPaths([]);
      return;
    }
    const measure = () => {
      const rect = grid.getBoundingClientRect();
      const next: EdgePath[] = [];
      for (const edge of handoffs) {
        const glyph = (lane: string, node: string) =>
          grid.querySelector<HTMLElement>(
            `[data-lane-id="${CSS.escape(lane)}"][data-node-id="${CSS.escape(node)}"] .trajectory-event-glyph`,
          );
        const from = glyph(edge.fromLaneId, edge.fromNodeId);
        const to = glyph(edge.toLaneId, edge.toNodeId);
        if (!from || !to) continue;
        const a = from.getBoundingClientRect();
        const b = to.getBoundingClientRect();
        const x1 = a.left + a.width / 2 - rect.left;
        const y1 = a.top + a.height / 2 - rect.top;
        const x2 = b.left + b.width / 2 - rect.left;
        const y2 = b.top + b.height / 2 - rect.top;
        const cx = (x1 + x2) / 2;
        next.push({ edge, d: `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}` });
      }
      setPaths(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    for (const column of grid.querySelectorAll(".multi-lane-graph__column"))
      observer.observe(column);
    return () => observer.disconnect();
  }, [handoffs, laneNodes, lanes, loading, error]);

  return (
    <aside
      className="session-trajectory session-trajectory--multi"
      data-testid="session-trajectory-panel"
      data-lane-mode="multi"
    >
      <header className="session-trajectory__header">
        <span className="session-trajectory__title">{t("trajectory.title")}</span>
        <span className="session-trajectory__meta">
          {tPlural(lanes.length, "trajectory.laneCountOne", "trajectory.laneCountMany")}
        </span>
      </header>
      <div className="session-trajectory__body session-trajectory__body--lanes">
        {loading ? (
          <p className="session-trajectory__status">{t("trajectory.loading")}</p>
        ) : error ? (
          <p className="session-trajectory__status session-trajectory__status--error">{error}</p>
        ) : (
          <div
            className="multi-lane-graph"
            ref={gridRef}
            style={{ "--lane-columns": Math.max(1, lanes.length) } as CSSProperties}
          >
            <div className="multi-lane-graph__columns">
              {lanes.map((lane) => {
                const zone = lancerZoneById(conversationZoneId(lane.label));
                return (
                  <div
                    key={lane.id}
                    className="multi-lane-graph__column"
                    style={{ "--lane-color": zone.color } as CSSProperties}
                  >
                    <header
                      className="multi-lane-graph__lane-head"
                      data-current={lane.isCurrent}
                      title={stripLancerZonePrefix(lane.label)}
                    >
                      <div className="multi-lane-graph__lane-heading">
                        <i aria-hidden="true" />
                        <span className="multi-lane-graph__lane-title">{zone.label}</span>
                      </div>
                      <span className="multi-lane-graph__lane-detail">
                        {stripLancerZonePrefix(lane.label)}
                      </span>
                      <span
                        className={`multi-lane-graph__lane-progress ${lane.isCurrent ? "multi-lane-graph__lane-progress--active" : ""}`}
                      />
                      <span className="multi-lane-graph__lane-count">
                        {(laneNodes.get(lane.id) ?? []).length} · {lane.isCurrent ? "聚焦" : "事件"}
                      </span>
                    </header>
                    <ol className="multi-lane-graph__nodes">
                      {(laneNodes.get(lane.id) ?? []).map((node) => {
                        const highlighted =
                          highlightedNodeId === node.id ||
                          highlightedNodeId === node.scrollTargetId;
                        return (
                          <li
                            key={node.id}
                            className={`multi-lane-graph__node ${highlighted ? "multi-lane-graph__node--hl" : ""} ${node.isFork ? "multi-lane-graph__node--fork" : ""}`}
                            data-lane-id={lane.id}
                            data-node-id={node.id}
                            data-scroll-target={node.scrollTargetId}
                            data-event-type={trajectoryEvent(node)}
                          >
                            <button
                              type="button"
                              className="multi-lane-graph__node-button"
                              title={node.title}
                              data-testid={
                                node.kind === "tool_group" ? "trajectory-tool-stage" : undefined
                              }
                              onClick={() => onSelectNode(node)}
                            >
                              <span
                                className={`trajectory-event-glyph trajectory-event-glyph--${trajectoryEvent(node)}`}
                                aria-hidden="true"
                              />
                              <span className="multi-lane-graph__node-text">
                                <span className="multi-lane-graph__node-title">{node.title}</span>
                                <span className="multi-lane-graph__node-preview">
                                  {trajectoryCaption(node)}
                                </span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                );
              })}
            </div>
            <svg className="multi-lane-graph__svg" aria-hidden="true">
              {paths.map(({ edge, d }) => (
                <path
                  key={edge.id}
                  className="multi-lane-graph__handoff"
                  d={d}
                  data-from-node={edge.fromNodeId}
                  data-to-node={edge.toNodeId}
                  data-from-lane={edge.fromLaneId}
                  data-to-lane={edge.toLaneId}
                />
              ))}
            </svg>
          </div>
        )}
      </div>
      <footer className="session-trajectory__legend session-trajectory__legend--grid">
        <span className="session-trajectory__legend-title">
          {t("lancer.trajectory.legendTitle")}
        </span>
        <div className="session-trajectory__legend-items">
          {TRAJECTORY_EVENTS.map((item) => (
            <span key={item.key} className="session-trajectory__legend-item">
              <span
                className={`trajectory-event-glyph trajectory-event-glyph--${item.key}`}
                aria-hidden="true"
              />
              {trajectoryEventLabel(item.key)}
            </span>
          ))}
        </div>
        {metaChips.length > 0 ? (
          <span className="session-trajectory__legend-meta">
            {metaChips.map((chip) => chip.label).join(" · ")}
          </span>
        ) : null}
      </footer>
    </aside>
  );
}
