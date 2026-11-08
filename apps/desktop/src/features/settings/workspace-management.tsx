import { useState, type Dispatch, type SetStateAction } from "react";
import type { DesktopAppState } from "../../../contracts/desktop-state";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { t } from "../../../contracts/i18n";
import { updateSnapshot } from "../../app/desktop-app-state";
import { useWorkspaceMenu } from "../threads/hooks/use-workspace-menu";
import { WorkspaceFolderContent } from "../threads/sidebar";
import { SettingsGroup } from "./settings-utils";

/** Workspace operations remain available without replacing the module sidebar. */
export function WorkspaceManagement({
  api,
  snapshot,
  setSnapshot,
}: {
  readonly api: PiDesktopApi;
  readonly snapshot: DesktopAppState;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
}) {
  const wsMenu = useWorkspaceMenu({ api, setSnapshot, updateSnapshot });
  const linked = new Map(
    Object.values(snapshot.worktreesByWorkspace)
      .flat()
      .filter((worktree) => worktree.linkedWorkspaceId)
      .map((worktree) => [worktree.linkedWorkspaceId!, worktree]),
  );
  return (
    <SettingsGroup title={t("app.settings.workspace")}>
      <div data-testid="workspace-management">
        {snapshot.workspaces.map((workspace) => (
          <section className="workspace-group" data-workspace-id={workspace.id} key={workspace.id}>
            <WorkspaceFolderContent
              workspace={workspace}
              canDrag={false}
              selectedWorkspace={snapshot.workspaces.find(
                (item) => item.id === snapshot.selectedWorkspaceId,
              )}
              linkedWorktreeByWorkspaceId={linked}
              wsMenu={wsMenu}
              api={api}
            />
            <WorktreeInitCommand
              workspaceId={workspace.id}
              command={workspace.worktreeInitCommand ?? ""}
              api={api}
              setSnapshot={setSnapshot}
            />
          </section>
        ))}
      </div>
    </SettingsGroup>
  );
}

function WorktreeInitCommand({
  workspaceId,
  command,
  api,
  setSnapshot,
}: {
  readonly workspaceId: string;
  readonly command: string;
  readonly api: PiDesktopApi;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
}) {
  const [value, setValue] = useState(command);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  return (
    <div className="workspace-init-command">
      <label>
        <span>{t("threads.workspace.worktreeInitCommand")}</span>
        <textarea
          value={value}
          maxLength={4000}
          placeholder={t("threads.workspace.worktreeInitPlaceholder")}
          onChange={(event) => {
            setValue(event.target.value);
            setSaved(false);
          }}
        />
      </label>
      <p>{t("threads.workspace.worktreeInitHint")}</p>
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          setSaving(true);
          setError(undefined);
          void updateSnapshot(setSnapshot, () =>
            api.setWorkspaceWorktreeInitCommand(workspaceId, value),
          )
            .then(() => setSaved(true))
            .catch((cause: unknown) =>
              setError(cause instanceof Error ? cause.message : String(cause)),
            )
            .finally(() => setSaving(false));
        }}
      >
        {saved ? t("threads.workspace.worktreeInitSaved") : t("threads.workspace.worktreeInitSave")}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
