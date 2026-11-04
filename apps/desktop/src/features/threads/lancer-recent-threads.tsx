import type { ThreadListEntry } from "./thread-groups";
import { stripLancerZonePrefix } from "../../../contracts/lancer-zones";
import { t } from "../../../contracts/i18n";
import { ModelBrandIcon } from "../../ui/model-brand-icon";

export function LancerRecentThreads({
  threads,
  onSelect,
}: {
  readonly threads: readonly ThreadListEntry[];
  readonly onSelect: (target: { workspaceId: string; sessionId: string }) => void;
}) {
  const running = threads.filter((thread) => thread.session.status === "running").length;
  const title = t("lancer.recent.title");
  return (
    <footer className="lancer-recent-threads" aria-label={title}>
      <span>{title}</span>
      <div className="lancer-recent-threads__items">
        {threads.slice(0, 8).map((thread) => (
          <button
            key={`${thread.workspaceId}:${thread.session.id}`}
            type="button"
            title={stripLancerZonePrefix(thread.session.title)}
            aria-label={stripLancerZonePrefix(thread.session.title)}
            onClick={() =>
              onSelect({ workspaceId: thread.workspaceId, sessionId: thread.session.id })
            }
          >
            <ModelBrandIcon
              provider={thread.session.config?.provider}
              modelId={thread.session.config?.modelId}
            />
            <i data-status={thread.session.status} />
          </button>
        ))}
      </div>
      <small>{t("lancer.recent.summary", { running, count: threads.length })}</small>
    </footer>
  );
}
