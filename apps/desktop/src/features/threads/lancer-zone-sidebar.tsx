import type { SessionRecord } from "../../../contracts/desktop-state";
import {
  LANCER_SESSION_ZONES,
  conversationZoneId,
  lancerZoneLabel,
  stripLancerZonePrefix,
} from "../../../contracts/lancer-zones";
import { tPlural } from "../../../contracts/i18n";
import { ModelBrandIcon } from "../../ui/model-brand-icon";
import type { ThreadListEntry } from "./thread-groups";

function modelLabel(session: SessionRecord): string {
  const model = session.config?.modelId ?? "gpt-5";
  return model.includes("/") ? model.split("/").pop()! : model;
}

export function buildZoneThreadGroups(threads: readonly ThreadListEntry[]): readonly {
  readonly zoneId: string;
  readonly label: string;
  readonly color: string;
  readonly threads: readonly ThreadListEntry[];
}[] {
  const byZone = new Map<string, ThreadListEntry[]>();
  for (const thread of threads) {
    const zoneId = conversationZoneId(thread.session.title);
    const list = byZone.get(zoneId) ?? [];
    list.push(thread);
    byZone.set(zoneId, list);
  }
  return LANCER_SESSION_ZONES.map((zone) => ({
    zoneId: zone.id,
    label: lancerZoneLabel(zone),
    color: zone.color,
    threads: byZone.get(zone.id) ?? [],
  }));
}

export function LancerZoneSidebarSections({
  threads,
  selectedSessionId,
  onSelect,
}: {
  readonly threads: readonly ThreadListEntry[];
  readonly selectedSessionId?: string;
  readonly onSelect: (thread: ThreadListEntry) => void;
}) {
  const groups = buildZoneThreadGroups(threads);

  return (
    <div className="lancer-zone-sidebar" data-testid="lancer-zone-sidebar">
      {groups.map((group) => (
        <section key={group.zoneId} className="lancer-zone-sidebar__section">
          <header className="lancer-zone-sidebar__head">
            <span className="lancer-zone-sidebar__dot" style={{ background: group.color }} />
            <span className="lancer-zone-sidebar__title">{group.label}</span>
            <span className="lancer-zone-sidebar__count">
              {tPlural(
                group.threads.length,
                "lancer.zone.sessionCountOne",
                "lancer.zone.sessionCountMany",
              )}
            </span>
          </header>
          <ul className="lancer-zone-sidebar__list">
            {group.threads.map((thread) => {
              const active = thread.session.id === selectedSessionId;
              return (
                <li key={thread.session.id}>
                  <button
                    type="button"
                    className={`lancer-zone-sidebar__row ${active ? "lancer-zone-sidebar__row--active" : ""}`}
                    onClick={() => onSelect(thread)}
                  >
                    <span className="lancer-zone-sidebar__model" aria-hidden="true">
                      <ModelBrandIcon
                        provider={thread.session.config?.provider}
                        modelId={thread.session.config?.modelId}
                      />
                    </span>
                    <span className="lancer-zone-sidebar__body">
                      <span className="lancer-zone-sidebar__name">
                        {stripLancerZonePrefix(thread.session.title)}
                      </span>
                      <span
                        className="lancer-zone-sidebar__meta"
                        title={modelLabel(thread.session)}
                      >
                        <span className="lancer-zone-sidebar__branch">
                          {thread.environment.branchName ?? thread.environment.label}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
