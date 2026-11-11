import { useId, useRef, useState } from "react";
import { getLocale, t } from "../../../contracts/i18n";
import { filterProviderPresets } from "../../../contracts/provider-presets";
import type { ProviderPreset } from "../../../contracts/provider-presets";
import { trapDialogFocus } from "../../ui/dialog-focus";

interface SettingsProviderPresetDialogProps {
  readonly onChoose: (preset: ProviderPreset) => void;
  readonly onClose: () => void;
}

export function SettingsProviderPresetDialog({
  onChoose,
  onClose,
}: SettingsProviderPresetDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const locale = getLocale();
  const presets = filterProviderPresets(query);

  return (
    <div className="extension-dialog-backdrop">
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="extension-dialog provider-preset-dialog"
        data-testid="provider-preset-dialog"
        ref={dialogRef}
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "Tab") {
            trapDialogFocus(event, dialogRef.current);
          }
        }}
      >
        <div className="extension-dialog__title" id={titleId}>
          {t("settings.customEndpoints.presetTitle")}
        </div>
        <input
          aria-label={t("settings.customEndpoints.presetSearch")}
          autoFocus
          className="settings-search"
          placeholder={t("settings.customEndpoints.presetSearch")}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul className="provider-preset-dialog__list">
          {presets.length === 0 ? (
            <li className="extension-dialog__body" role="status">
              {t("settings.customEndpoints.presetEmpty")}
            </li>
          ) : (
            presets.map((preset) => (
              <li key={preset.id}>
                <button
                  aria-label={preset.name[locale]}
                  className="extension-dialog__option provider-preset-dialog__option"
                  type="button"
                  onClick={() => onChoose(preset)}
                >
                  <span className="settings-row__title">{preset.name[locale]}</span>
                  <span className="settings-row__description">{preset.description[locale]}</span>
                  {preset.modelHint ? (
                    <span className="settings-row__description">{preset.modelHint[locale]}</span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="extension-dialog__actions">
          <button className="button button--secondary" type="button" onClick={onClose}>
            {t("settings.customEndpoints.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
