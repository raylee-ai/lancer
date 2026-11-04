import { useEffect, useState } from "react";
import type { RuntimeSnapshot } from "@lancer/session-driver/runtime-types";
import type { LanguagePreference, ModelSettingsScopeMode } from "../../../contracts/desktop-state";
import { t } from "../../../contracts/i18n";
import { defaultTerminalShell } from "../../../contracts/terminal-model";
import { SettingsSegmented, SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";

interface SettingsGeneralSectionProps {
  readonly runtime?: RuntimeSnapshot;
  readonly language: LanguagePreference;
  readonly modelSettingsScopeMode: ModelSettingsScopeMode;
  readonly integratedTerminalShell: string;
  readonly localControlEnabled: boolean;
  readonly onSetLocalControlEnabled: (enabled: boolean) => void;
  readonly onSetLanguage: (language: LanguagePreference) => void;
  readonly onSetModelSettingsScopeMode: (mode: ModelSettingsScopeMode) => void;
  readonly onSetIntegratedTerminalShell: (shellPath: string) => void;
  readonly onToggleSkillCommands: (enabled: boolean) => void;
}

export function SettingsGeneralSection({
  runtime,
  language,
  modelSettingsScopeMode,
  integratedTerminalShell,
  localControlEnabled,
  onSetLocalControlEnabled,
  onSetLanguage,
  onSetModelSettingsScopeMode,
  onSetIntegratedTerminalShell,
  onToggleSkillCommands,
}: SettingsGeneralSectionProps) {
  const [terminalShellDraft, setTerminalShellDraft] = useState(integratedTerminalShell);

  useEffect(() => {
    setTerminalShellDraft(integratedTerminalShell);
  }, [integratedTerminalShell]);

  const commitTerminalShellDraft = () => {
    if (terminalShellDraft !== integratedTerminalShell) {
      onSetIntegratedTerminalShell(terminalShellDraft);
    }
  };

  return (
    <>
      <SettingsGroup title={t("generalSettings.interface")}>
        <SettingsRow title={t("language.label")} description={t("language.description")}>
          <SettingsSegmented<LanguagePreference>
            label={t("language.label")}
            options={[
              { value: "system", label: t("language.system") },
              { value: "en", label: t("language.en") },
              { value: "zh-CN", label: t("language.zh-CN") },
            ]}
            value={language}
            onChange={onSetLanguage}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("generalSettings.agent")}>
        <SettingsRow
          title={t("generalSettings.modelScope")}
          description={t("generalSettings.modelScopeDescription")}
        >
          <SettingsSegmented
            label={t("generalSettings.modelScope")}
            options={[
              { value: "app-global", label: t("generalSettings.appGlobal") },
              { value: "per-repo", label: t("generalSettings.perRepo") },
            ]}
            value={modelSettingsScopeMode}
            onChange={onSetModelSettingsScopeMode}
          />
        </SettingsRow>
        <SettingsRow
          title={t("generalSettings.skillCommands")}
          description={t("generalSettings.skillCommandsDescription")}
        >
          <SettingsSwitch
            checked={runtime?.settings.enableSkillCommands ?? true}
            label={t("generalSettings.enableSkillCommands")}
            onChange={onToggleSkillCommands}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("generalSettings.localControl")}>
        <SettingsRow
          title={t("generalSettings.allowLocalControl")}
          description={t("generalSettings.localControlDescription")}
        >
          <SettingsSwitch
            checked={localControlEnabled}
            label={t("generalSettings.allowLocalControl")}
            onChange={onSetLocalControlEnabled}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("generalSettings.terminal")}>
        <SettingsRow
          title={t("generalSettings.shell")}
          description={t("generalSettings.shellDescription")}
        >
          <input
            aria-label={t("generalSettings.shellAriaLabel")}
            className="settings-text-input"
            placeholder={defaultTerminalShell(window.piApp?.platform ?? "linux")}
            spellCheck={false}
            type="text"
            value={terminalShellDraft}
            onBlur={commitTerminalShellDraft}
            onChange={(event) => setTerminalShellDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
