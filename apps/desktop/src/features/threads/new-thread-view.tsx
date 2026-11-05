import {
  useEffect,
  useRef,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { RuntimeSnapshot } from "@lancer/session-driver/runtime-types";
import type {
  ComposerAttachment,
  NewThreadEnvironment,
  WorkspaceRecord,
} from "../../../contracts/desktop-state";
import { t } from "../../../contracts/i18n";
import type { MentionOption } from "../conversation/hooks/use-mention-menu";
import { ArrowUpIcon, PlusIcon } from "../../ui/icons";
import {
  type ComposerSlashCommand,
  type ComposerSlashCommandSection,
  type ComposerSlashOption,
  type ComposerSlashOptionEmptyState,
} from "../conversation/composer-commands";
import { ComposerSurface } from "../conversation/composer-surface";
import { ModelOnboardingNoticeBanner } from "../settings/model-onboarding-notice";
import type {
  ModelOnboardingState,
  ModelOnboardingSettingsSection,
} from "../settings/model-onboarding";
import { ModelSelector } from "../conversation/model-selector";

interface NewThreadViewProps {
  readonly onSelectDoubaoApp?: () => void;
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspaceId: string;
  readonly runtime?: RuntimeSnapshot;
  readonly environment: NewThreadEnvironment;
  readonly useWorktree: boolean;
  readonly prompt: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly lastError?: string;
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly modelOnboarding: ModelOnboardingState;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly activeSlashCommand?: ComposerSlashCommand;
  readonly activeSlashCommandMeta?: string;
  readonly slashSections: readonly ComposerSlashCommandSection[];
  readonly slashOptions: readonly ComposerSlashOption[];
  readonly selectedSlashCommand?: ComposerSlashCommand;
  readonly selectedSlashOption?: ComposerSlashOption;
  readonly showSlashMenu: boolean;
  readonly showSlashOptionMenu: boolean;
  readonly slashOptionEmptyState?: ComposerSlashOptionEmptyState;
  readonly showMentionMenu: boolean;
  readonly mentionOptions: readonly MentionOption[];
  readonly selectedMentionIndex: number;
  readonly onChangePrompt: (prompt: string) => void;
  readonly onSelectEnvironment: (environment: NewThreadEnvironment) => void;
  readonly onToggleWorktree: (enabled: boolean) => void;
  readonly onSelectWorkspace: (workspaceId: string) => void;
  readonly onOpenFolder?: () => void;
  readonly onSetModel: (provider: string, modelId: string) => void;
  readonly onSetThinking: (level: string) => void;
  readonly onOpenModelSettings: (section: ModelOnboardingSettingsSection) => void;
  readonly onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onComposerPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  readonly onComposerDrop: (event: DragEvent<HTMLDivElement>) => void;
  readonly onClearSlashCommand: () => void;
  readonly onSelectSlashCommand: (command: ComposerSlashCommand) => void;
  readonly onSelectSlashOption: (option: ComposerSlashOption) => void;
  readonly onSelectMention: (option: MentionOption) => void;
  readonly onEnableMentionExtension: (
    option: Extract<MentionOption, { kind: "extension" }>,
  ) => void;
  readonly onAddAttachments: (files: File[]) => void;
  readonly onRemoveAttachment: (attachmentId: string) => void;
  readonly onSubmit: () => void;
}

export function NewThreadView({
  onSelectDoubaoApp,
  workspaces,
  selectedWorkspaceId,
  runtime,
  environment,
  useWorktree,
  prompt,
  attachments,
  lastError,
  provider,
  modelId,
  thinkingLevel,
  modelOnboarding,
  composerRef,
  activeSlashCommand,
  activeSlashCommandMeta,
  slashSections,
  slashOptions,
  selectedSlashCommand,
  selectedSlashOption,
  showSlashMenu,
  showSlashOptionMenu,
  slashOptionEmptyState,
  showMentionMenu,
  mentionOptions,
  selectedMentionIndex,
  onChangePrompt,
  onSelectEnvironment,
  onToggleWorktree,
  onSelectWorkspace,
  onOpenFolder,
  onSetModel,
  onSetThinking,
  onOpenModelSettings,
  onComposerKeyDown,
  onComposerPaste,
  onComposerDrop,
  onClearSlashCommand,
  onSelectSlashCommand,
  onSelectSlashOption,
  onSelectMention,
  onEnableMentionExtension,
  onAddAttachments,
  onRemoveAttachment,
  onSubmit,
}: NewThreadViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workspace = workspaces.find((entry) => entry.id === selectedWorkspaceId);

  useEffect(() => {
    composerRef.current?.focus();
  }, [composerRef]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) {
      return;
    }

    composer.style.height = "0px";
    composer.style.height = `${Math.min(composer.scrollHeight, 260)}px`;
  }, [composerRef, prompt]);

  if (!workspace) {
    return (
      <section className="canvas canvas--empty">
        <div className="empty-panel">
          <div className="session-header__eyebrow">{t("threads.newThread.eyebrow")}</div>
          <h1>{t("threads.newThread.noFolderTitle")}</h1>
          <p>{t("threads.newThread.noFolderBody")}</p>
          {onOpenFolder && (
            <button type="button" onClick={onOpenFolder}>
              {t("menu.openFolder")}
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="canvas canvas--new-thread">
      <div className="new-thread">
        <div className="new-thread__composer composer">
          <div className="new-thread__workspace-row">
            <label className="new-thread__workspace-picker">
              <span>{t("threads.newThread.workspace")}</span>
              <select
                className="new-thread__workspace"
                value={workspace.id}
                onChange={(event) => onSelectWorkspace(event.target.value)}
              >
                {workspaces.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            {onOpenFolder && (
              <button type="button" className="new-thread__open-folder" onClick={onOpenFolder}>
                {t("menu.openFolder")}
              </button>
            )}
          </div>
          <div className="conversation conversation--composer">
            <ComposerSurface
              lastError={lastError}
              activeSlashCommand={activeSlashCommand}
              activeSlashCommandMeta={activeSlashCommandMeta}
              topNotice={
                <ModelOnboardingNoticeBanner
                  notice={modelOnboarding.notice}
                  onOpenSettings={onOpenModelSettings}
                />
              }
              queuedMessages={[]}
              composerDraft={prompt}
              setComposerDraft={onChangePrompt}
              composerRef={composerRef}
              attachments={attachments}
              slashSections={slashSections}
              slashOptions={slashOptions}
              selectedSlashCommand={selectedSlashCommand}
              selectedSlashOption={selectedSlashOption}
              showSlashMenu={showSlashMenu}
              showSlashOptionMenu={showSlashOptionMenu}
              slashOptionEmptyState={slashOptionEmptyState}
              onClearSlashCommand={onClearSlashCommand}
              onComposerKeyDown={onComposerKeyDown}
              onComposerPaste={onComposerPaste}
              onComposerDrop={onComposerDrop}
              onEditQueuedMessage={() => undefined}
              onCancelQueuedEdit={() => undefined}
              onRemoveQueuedMessage={() => undefined}
              onSteerQueuedMessage={() => undefined}
              onRemoveAttachment={onRemoveAttachment}
              onSelectSlashCommand={onSelectSlashCommand}
              onSelectSlashOption={onSelectSlashOption}
              showMentionMenu={showMentionMenu}
              mentionOptions={mentionOptions}
              selectedMentionIndex={selectedMentionIndex}
              onSelectMention={onSelectMention}
              onEnableMentionExtension={onEnableMentionExtension}
              textareaLabel={t("threads.newThread.promptLabel")}
              textareaTestId="new-thread-composer"
              textareaClassName="new-thread__textarea"
              textareaPlaceholder={t("threads.newThread.promptPlaceholder")}
              footer={
                <NewThreadComposerFooter
                  onSelectDoubaoApp={onSelectDoubaoApp}
                  runtime={runtime}
                  environment={environment}
                  useWorktree={useWorktree}
                  provider={provider}
                  modelId={modelId}
                  thinkingLevel={thinkingLevel}
                  modelOnboarding={modelOnboarding}
                  hasContent={Boolean(prompt.trim() || attachments.length > 0)}
                  fileInputRef={fileInputRef}
                  onSelectEnvironment={onSelectEnvironment}
                  onToggleWorktree={onToggleWorktree}
                  onSetModel={onSetModel}
                  onSetThinking={onSetThinking}
                  onAddAttachments={onAddAttachments}
                  onSubmit={onSubmit}
                />
              }
            />
          </div>
        </div>
      </div>
    </section>
  );
}

interface NewThreadComposerFooterProps {
  readonly onSelectDoubaoApp?: () => void;
  readonly runtime?: RuntimeSnapshot;
  readonly environment: NewThreadEnvironment;
  readonly useWorktree: boolean;
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly modelOnboarding: ModelOnboardingState;
  readonly hasContent: boolean;
  readonly fileInputRef: RefObject<HTMLInputElement | null>;
  readonly onSelectEnvironment: (environment: NewThreadEnvironment) => void;
  readonly onToggleWorktree: (enabled: boolean) => void;
  readonly onSetModel: (provider: string, modelId: string) => void;
  readonly onSetThinking: (level: string) => void;
  readonly onAddAttachments: (files: File[]) => void;
  readonly onSubmit: () => void;
}

function NewThreadComposerFooter({
  onSelectDoubaoApp,
  runtime,
  environment,
  useWorktree,
  provider,
  modelId,
  thinkingLevel,
  modelOnboarding,
  hasContent,
  fileInputRef,
  onSelectEnvironment,
  onToggleWorktree,
  onSetModel,
  onSetThinking,
  onAddAttachments,
  onSubmit,
}: NewThreadComposerFooterProps) {
  return (
    <>
      <div className="composer__footer">
        <div className="composer__footer-row">
          <div className="composer__hint new-thread__hint">
            <div className="new-thread__environment-group">
              <button
                className={`new-thread__environment ${environment === "local" ? "new-thread__environment--active" : ""}`}
                type="button"
                onClick={() => onSelectEnvironment("local")}
              >
                <span>{t("threads.newThread.local")}</span>
              </button>
              <button
                className={`new-thread__environment ${environment === "worktree" ? "new-thread__environment--active" : ""}`}
                type="button"
                onClick={() => onSelectEnvironment("worktree")}
              >
                <span>{t("threads.newThread.worktree")}</span>
              </button>
              <label
                className={`new-thread__isolate ${environment === "worktree" ? "new-thread__isolate--disabled" : ""}`}
                title={t("threads.newThread.isolateHint")}
              >
                <input
                  type="checkbox"
                  data-testid="new-thread-worktree"
                  checked={environment === "local" && useWorktree}
                  disabled={environment === "worktree"}
                  onChange={(event) => onToggleWorktree(event.target.checked)}
                />
                <span>{t("threads.newThread.isolate")}</span>
              </label>
            </div>
            <span className="new-thread__hint-separator">·</span>
            <ModelSelector
              onSelectDoubaoApp={onSelectDoubaoApp}
              runtime={runtime}
              provider={provider}
              modelId={modelId}
              thinkingLevel={thinkingLevel}
              dropdownPlacement="above"
              showEmptyModelControl
              unselectedModelLabel={modelOnboarding.unselectedModelLabel}
              emptyModelLabel={t("composer.modelOptionsEmptyTitle")}
              emptyModelTitle={modelOnboarding.emptyModelTitle}
              onSetModel={onSetModel}
              onSetThinking={onSetThinking}
            />
          </div>

          <div className="composer__actions">
            <input
              ref={fileInputRef}
              hidden
              type="file"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length > 0) {
                  onAddAttachments(files);
                }
                event.currentTarget.value = "";
              }}
            />
            <button
              aria-label={t("threads.newThread.attachFiles")}
              className="icon-button composer__attach"
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              <PlusIcon />
            </button>
            <button
              aria-label={t("threads.newThread.start")}
              className="button button--primary button--cta-icon"
              type="button"
              disabled={!hasContent || modelOnboarding.requiresModelSelection}
              onClick={onSubmit}
            >
              <ArrowUpIcon />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
