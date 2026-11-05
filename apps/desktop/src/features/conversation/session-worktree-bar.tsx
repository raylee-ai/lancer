import { useState } from "react";
import type { SessionRecord, SessionWorktreeDiff } from "../../../contracts/desktop-state";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { t } from "../../../contracts/i18n";

export function SessionWorktreeBar({
  api,
  workspaceId,
  session,
}: {
  readonly api: PiDesktopApi;
  readonly workspaceId: string;
  readonly session: SessionRecord;
}) {
  const worktree = session.worktree;
  const [diff, setDiff] = useState<SessionWorktreeDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  if (!worktree) return null;
  const target = { workspaceId, sessionId: session.id };
  const baseLabel = worktree.baseBranch || t("threads.worktree.detached");
  const run = (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void action()
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="session-worktree" data-testid="session-worktree">
      <div className="session-worktree__summary">
        <span className="session-worktree__branch" title={worktree.path}>
          {worktree.branch}
        </span>
        <span className="session-worktree__path" title={worktree.path}>
          {worktree.path}
        </span>
      </div>
      <div className="session-worktree__actions">
        <button
          type="button"
          data-testid="session-worktree-diff"
          disabled={busy}
          onClick={() =>
            run(async () => {
              setDiff(await api.getSessionWorktreeDiff(target));
            })
          }
        >
          {t("threads.worktree.diff")}
        </button>
        <button
          type="button"
          data-testid="session-worktree-merge"
          disabled={busy || session.status === "running"}
          onClick={() => {
            if (
              !window.confirm(
                t("threads.worktree.mergeConfirm", { branch: worktree.branch, base: baseLabel }),
              )
            ) {
              return;
            }
            run(() => api.mergeSessionWorktree(target));
          }}
        >
          {t("threads.worktree.merge", { branch: baseLabel })}
        </button>
        <button
          type="button"
          data-testid="session-worktree-discard"
          disabled={busy || session.status === "running"}
          onClick={() => {
            if (
              !window.confirm(t("threads.worktree.discardConfirm", { branch: worktree.branch }))
            ) {
              return;
            }
            setDiff(null);
            run(() => api.discardSessionWorktree(target));
          }}
        >
          {t("threads.worktree.discard")}
        </button>
      </div>
      {error ? <p className="session-worktree__error">{error}</p> : null}
      {diff ? (
        <div className="session-worktree__dialog" role="dialog" aria-modal="true">
          <div className="session-worktree__dialog-card">
            <header className="session-worktree__dialog-header">
              <strong>
                {diff.branch}
                <span> → {diff.baseBranch || diff.baseSha.slice(0, 7)}</span>
              </strong>
              <button type="button" onClick={() => setDiff(null)}>
                {t("threads.worktree.close")}
              </button>
            </header>
            <pre className="session-worktree__stat">
              {diff.stat || t("threads.worktree.noChanges")}
            </pre>
            <pre className="session-worktree__patch">
              {diff.patch || t("threads.worktree.noChanges")}
            </pre>
            {diff.truncated ? <p>{t("threads.worktree.truncated")}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
