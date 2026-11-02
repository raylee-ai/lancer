import { Fragment, type CSSProperties } from "react";
import {
  LANCER_SESSION_ZONES,
  conversationZoneId,
  lancerZoneLabel,
  stripLancerZonePrefix,
} from "../../../contracts/lancer-zones";
import { t } from "../../../contracts/i18n";
import { ModelBrandIcon } from "../../ui/model-brand-icon";
import type { ThreadListEntry } from "../threads/thread-groups";

/** Configured relay plans; a chip navigates only when a real matching session exists. */
export function LancerLaneOverview({
  threads,
  selectedSessionId,
  branchName,
  onSelect,
}: {
  readonly threads: readonly ThreadListEntry[];
  readonly selectedSessionId: string;
  readonly branchName?: string;
  readonly onSelect: (target: { workspaceId: string; sessionId: string }) => void;
}) {
  const selected = threads.find((thread) => thread.session.id === selectedSessionId)?.session;
  return (
    <div className="lancer-lane-overview">
      <div className="lancer-lane-overview__rows">
        {LANCER_SESSION_ZONES.map((zone) => (
          <div
            className="lancer-lane-overview__row"
            key={zone.id}
            style={{ "--lane-color": zone.color } as CSSProperties}
          >
            <span className="lancer-lane-overview__zone">
              <i />
              {lancerZoneLabel(zone)}
            </span>
            {zone.relay.map((model, index) => {
              const thread = threads.find(
                (entry) =>
                  conversationZoneId(entry.session.title) === zone.id &&
                  entry.session.config?.provider === model.provider &&
                  entry.session.config?.modelId === model.modelId,
              );
              return (
                <Fragment key={`${model.provider}:${model.modelId}`}>
                  {index ? <span className="lancer-lane-overview__arrow">→</span> : null}
                  <button
                    type="button"
                    disabled={!thread}
                    title={
                      thread
                        ? stripLancerZonePrefix(thread.session.title)
                        : `${model.label} · ${t("lancer.process.planStep")}`
                    }
                    className={`lancer-lane-overview__model${thread?.session.id === selectedSessionId ? " lancer-lane-overview__model--selected" : ""}`}
                    onClick={() =>
                      thread &&
                      onSelect({ workspaceId: thread.workspaceId, sessionId: thread.session.id })
                    }
                  >
                    <ModelBrandIcon provider={model.provider} modelId={model.modelId} />
                    {model.label}
                  </button>
                </Fragment>
              );
            })}
          </div>
        ))}
      </div>
      {selected ? (
        <header className="lancer-lane-overview__context">
          <span>
            {lancerZoneLabel(
              LANCER_SESSION_ZONES.find((zone) => zone.id === conversationZoneId(selected.title)) ??
                LANCER_SESSION_ZONES[0]!,
            )}
          </span>
          <b data-testid="thread-title">{stripLancerZonePrefix(selected.title)}</b>
          <small>{branchName}</small>
        </header>
      ) : null}
    </div>
  );
}
