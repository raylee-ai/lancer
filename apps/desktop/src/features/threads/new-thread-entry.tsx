import type { WorkspaceRecord } from "../../../contracts/desktop-state";
import type { SettingsSection } from "../settings/settings-view";
import type { useNewThreadController } from "./hooks/use-new-thread-controller";
import { NewThreadView } from "./new-thread-view";

/** Share the new-conversation controls between the desktop shells. */
export function NewThreadEntry({
  controller,
  workspaces,
  onSelectDoubaoApp,
  openSettings,
  error,
}: {
  readonly controller: ReturnType<typeof useNewThreadController>;
  readonly workspaces: readonly WorkspaceRecord[];
  readonly onSelectDoubaoApp?: () => void;
  readonly openSettings: (workspaceId?: string, section?: SettingsSection) => void;
  readonly error?: string | null;
}) {
  return (
    <NewThreadView
      onOpenFolder={controller.openFolder}
      onSelectDoubaoApp={onSelectDoubaoApp}
      workspaces={workspaces}
      selectedWorkspaceId={controller.rootWorkspaceId || workspaces[0]?.id || ""}
      runtime={controller.runtime}
      environment={controller.environment}
      useWorktree={controller.useWorktree}
      prompt={controller.prompt}
      attachments={controller.attachments}
      lastError={controller.composerError || error || undefined}
      provider={controller.resolvedProvider}
      modelId={controller.resolvedModelId}
      thinkingLevel={controller.resolvedThinkingLevel}
      modelOnboarding={controller.modelOnboarding}
      composerRef={controller.composerRef}
      activeSlashCommand={controller.slashMenu.activeSlashFlow?.command}
      activeSlashCommandMeta={controller.slashMenu.activeSlashFlow?.command?.description}
      slashSections={controller.slashMenu.slashSections}
      slashOptions={controller.slashMenu.slashOptions}
      selectedSlashCommand={
        controller.slashMenu.activeSlashOptionCommand ?? controller.slashMenu.selectedSlashCommand
      }
      selectedSlashOption={controller.slashMenu.selectedSlashOption}
      showSlashMenu={controller.slashMenu.showSlashMenu}
      showSlashOptionMenu={controller.slashMenu.showSlashOptionMenu}
      slashOptionEmptyState={controller.slashMenu.slashOptionEmptyState}
      showMentionMenu={controller.mentionMenu.showMentionMenu}
      mentionOptions={controller.mentionMenu.mentionOptions}
      selectedMentionIndex={controller.mentionMenu.selectedIndex}
      onChangePrompt={controller.setPrompt}
      onSelectEnvironment={controller.setEnvironment}
      onToggleWorktree={controller.setUseWorktree}
      onSelectWorkspace={controller.selectWorkspace}
      onSetModel={(provider, modelId) => {
        controller.setProvider(provider);
        controller.setModelId(modelId);
      }}
      onSetThinking={controller.setThinkingLevel}
      onOpenModelSettings={(section) => openSettings(controller.workspace?.id, section)}
      onComposerKeyDown={controller.handleComposerKeyDown}
      onComposerPaste={controller.handleComposerPaste}
      onComposerDrop={controller.handleComposerDrop}
      onClearSlashCommand={controller.slashMenu.resetSlashUi}
      onSelectSlashCommand={(command) => {
        controller.slashMenu.applySlashCommandSelection(command, "click");
      }}
      onSelectSlashOption={(option) => {
        controller.slashMenu.applySlashOptionSelection(option);
      }}
      onSelectMention={controller.mentionMenu.insertMention}
      onEnableMentionExtension={controller.mentionMenu.enableMentionExtension}
      onAddAttachments={controller.addAttachments}
      onRemoveAttachment={controller.removeAttachment}
      onSubmit={controller.startThread}
    />
  );
}
