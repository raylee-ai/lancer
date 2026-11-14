import type { ComponentProps } from "react";
import type { PiDesktopApi } from "../../contracts/ipc";
import type { SessionRecord, WorkspaceRecord, WorktreeRecord } from "../../contracts/desktop-state";
import { t } from "../../contracts/i18n";
import { DiffPanel } from "../features/workbench/diff-panel";
import { FileWorkbench } from "../features/workbench/file-workbench";
import { TerminalPanel } from "../features/workbench/terminal-panel";
import { renderBuiltinToolPanel } from "../features/workbench/builtin-tools";
import type { useWorkbench } from "../features/workbench/use-workbench";
import {
  ExtensionViewPanel,
  type ExtensionViewTheme,
} from "../features/extensions/extension-view-panel";
import type { useExtensionViews } from "../features/extensions/use-extension-views";
import type { useExtensionHostActions } from "../features/extensions/use-extension-host-actions";

export function ThreadToolPanel({
  api,
  workspace,
  session,
  workbench,
  extensionView,
  target,
  theme,
  extensionActions,
  filesWorkspace,
  filesWorktree,
  fileRequest,
  contexts,
}: {
  readonly api: PiDesktopApi;
  readonly workspace: WorkspaceRecord;
  readonly session: SessionRecord;
  readonly workbench: ReturnType<typeof useWorkbench>;
  readonly extensionView?: ReturnType<typeof useExtensionViews>["views"][number];
  readonly target: ComponentProps<typeof ExtensionViewPanel>["target"] | null;
  readonly theme: ExtensionViewTheme;
  readonly extensionActions: ReturnType<typeof useExtensionHostActions>;
  readonly filesWorkspace?: WorkspaceRecord;
  readonly filesWorktree?: WorktreeRecord;
  readonly fileRequest: ComponentProps<typeof DiffPanel>["fileRequest"];
  readonly contexts: ComponentProps<typeof DiffPanel>["contexts"];
}) {
  const key = `${workspace.id}:${session.id}`;
  if (extensionView?.state === "ready" && target)
    return (
      <ExtensionViewPanel
        api={api}
        target={target}
        view={extensionView}
        theme={theme}
        onBeforePrepareTaskDraft={extensionActions.beforePrepareTaskDraft}
        onPrepareTaskDraftPendingChange={extensionActions.handlePrepareTaskDraftPendingChange}
      />
    );
  const tool = workbench.activeTool;
  if (!tool || tool.kind === "extension") return null;
  return renderBuiltinToolPanel(tool.kind, {
    changes: () => (
      <DiffPanel
        key={key}
        workspaceId={workspace.id}
        sessionId={session.id}
        api={api}
        sessionStatus={session.status}
        selection={workbench.view.changes}
        onSelectionChange={workbench.setChanges}
        onOpenFile={workbench.openFile}
        fileRequest={fileRequest}
        contexts={contexts}
      />
    ),
    files: () =>
      filesWorkspace ? (
        <FileWorkbench
          key={key}
          api={api}
          onTabsChange={workbench.setFiles}
          sessionStatus={session.status}
          tabs={workbench.view.files.tabs}
          worktree={filesWorktree}
          workspace={filesWorkspace}
        />
      ) : (
        <p className="workbench__unavailable" role="status">
          {t("app.fileCheckoutUnavailable")}
        </p>
      ),
    terminal: () => (
      <TerminalPanel
        key={key}
        workspace={workspace}
        sessionId={session.id}
        executionCwd={session.executionCwd ?? workspace.path}
        onHide={() => workbench.closeTool("terminal")}
      />
    ),
  });
}
