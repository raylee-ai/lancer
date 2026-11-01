import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CUSTOM_PROVIDER_ID_PATTERN,
  CUSTOM_PROVIDER_APIS,
  isCustomProviderApi,
  isValidHttpBaseUrl,
} from "@lancer/pi-sdk-driver/custom-provider-types";
import { t, tPlural } from "../../../contracts/i18n";
import { trapDialogFocus } from "../../ui/dialog-focus";
import type { CustomProviderConfig, CustomProviderModelConfig } from "../../../contracts/ipc";
import { SettingsGroup } from "./settings-utils";

interface SettingsCustomEndpointsSectionProps {
  readonly existingProviderIds: readonly string[];
  readonly onSaveCustomProvider: (config: CustomProviderConfig) => Promise<string | undefined>;
  readonly onDeleteCustomProvider: (providerId: string) => Promise<string | undefined>;
}

type DialogMode =
  { kind: "closed" } | { kind: "create" } | { kind: "edit"; original: CustomProviderConfig };

export function SettingsCustomEndpointsSection({
  existingProviderIds,
  onSaveCustomProvider,
  onDeleteCustomProvider,
}: SettingsCustomEndpointsSectionProps) {
  const [entries, setEntries] = useState<readonly CustomProviderConfig[]>([]);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [dialog, setDialog] = useState<DialogMode>({ kind: "closed" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const api = window.piApp;
    if (!api) {
      return;
    }
    let cancelled = false;
    void api
      .listCustomProviders()
      .then((list) => {
        if (!cancelled) {
          setEntries(list);
          setLoadError(undefined);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const handleSave = useCallback(
    async (config: CustomProviderConfig): Promise<string | undefined> => {
      const error = await onSaveCustomProvider(config);
      if (!error) {
        reload();
      }
      return error;
    },
    [onSaveCustomProvider, reload],
  );

  const handleDelete = useCallback(
    async (providerId: string) => {
      const error = await onDeleteCustomProvider(providerId);
      if (error) {
        setLoadError(error);
        return;
      }
      reload();
    },
    [onDeleteCustomProvider, reload],
  );

  return (
    <>
      <SettingsGroup
        title={t("settings.customEndpoints.title")}
        description={t("settings.customEndpoints.description")}
      >
        {loadError ? (
          <div className="settings-row">
            <span className="settings-row__description settings-warning">{loadError}</span>
          </div>
        ) : null}
        {entries.length === 0 ? (
          <div className="settings-row">
            <span className="settings-row__description">{t("settings.customEndpoints.empty")}</span>
          </div>
        ) : (
          entries.map((entry) => (
            <div key={entry.providerId} className="settings-row">
              <div className="settings-row__label">
                <div className="settings-row__title">{entry.providerId}</div>
                <div className="settings-row__description">
                  {tPlural(
                    entry.models.length,
                    "settings.customEndpoints.entrySummaryOne",
                    "settings.customEndpoints.entrySummaryOther",
                    { baseUrl: entry.baseUrl },
                  )}
                </div>
              </div>
              <div className="settings-row__control">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setDialog({ kind: "edit", original: entry })}
                >
                  {t("settings.customEndpoints.edit")}
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() =>
                    void handleDelete(entry.providerId).catch((error: unknown) => {
                      setLoadError(error instanceof Error ? error.message : String(error));
                    })
                  }
                >
                  {t("settings.customEndpoints.remove")}
                </button>
              </div>
            </div>
          ))
        )}
        <div className="settings-row">
          <div className="settings-row__label">
            <div className="settings-row__title">{t("settings.customEndpoints.addEndpoint")}</div>
            <div className="settings-row__description">
              {t("settings.customEndpoints.addEndpointDescription")}
            </div>
          </div>
          <div className="settings-row__control">
            <button className="button" type="button" onClick={() => setDialog({ kind: "create" })}>
              {t("settings.customEndpoints.addEndpoint")}
            </button>
          </div>
        </div>
      </SettingsGroup>

      {dialog.kind !== "closed" ? (
        <CustomEndpointDialog
          mode={dialog}
          existingProviderIds={existingProviderIds}
          onClose={() => setDialog({ kind: "closed" })}
          onSave={handleSave}
        />
      ) : null}
    </>
  );
}

interface CustomEndpointDialogProps {
  readonly mode: Exclude<DialogMode, { kind: "closed" }>;
  readonly existingProviderIds: readonly string[];
  readonly onClose: () => void;
  readonly onSave: (config: CustomProviderConfig) => Promise<string | undefined>;
}

function CustomEndpointDialog({
  mode,
  existingProviderIds,
  onClose,
  onSave,
}: CustomEndpointDialogProps) {
  const titleId = useId();
  const initial = mode.kind === "edit" ? mode.original : undefined;
  const [providerId, setProviderId] = useState(initial?.providerId ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [protocol, setProtocol] = useState(initial ? (initial.api ?? "") : "openai-completions");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [models, setModels] = useState<CustomProviderModelConfig[]>(
    initial ? [...initial.models] : [],
  );
  const [probeCandidates, setProbeCandidates] = useState<readonly string[]>([]);
  const [probeError, setProbeError] = useState<string | undefined>();
  const [probePending, setProbePending] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();
  const [savePending, setSavePending] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const probeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreProbeFocusRef = useRef(false);

  const selectedModelIds = useMemo(() => new Set(models.map((model) => model.id)), [models]);
  const isEdit = mode.kind === "edit";

  const idValidationError = useMemo(
    () => validateProviderId(providerId, existingProviderIds, initial?.providerId),
    [providerId, existingProviderIds, initial?.providerId],
  );

  useEffect(() => {
    if (!probePending && restoreProbeFocusRef.current) {
      restoreProbeFocusRef.current = false;
      if (
        document.activeElement === document.body ||
        document.activeElement === probeButtonRef.current
      ) {
        probeButtonRef.current?.focus();
      }
    }
  }, [probePending]);

  const handleProbe = async () => {
    const api = window.piApp;
    if (!api) {
      setProbeError(t("settings.customEndpoints.bridgeUnavailable"));
      return;
    }
    if (!isValidHttpBaseUrl(baseUrl)) {
      setProbeError(t("settings.customEndpoints.baseUrlInvalid"));
      return;
    }
    restoreProbeFocusRef.current = document.activeElement === probeButtonRef.current;
    setProbePending(true);
    setProbeError(undefined);
    const result = await api.probeCustomProviderModels({
      baseUrl: baseUrl.trim(),
      ...(isCustomProviderApi(protocol) ? { api: protocol } : {}),
      apiKey: apiKey.trim() ? apiKey.trim() : undefined,
    });
    setProbePending(false);
    if (!result.ok) {
      setProbeError(result.error);
      setProbeCandidates([]);
      return;
    }
    setProbeCandidates(result.models);
  };

  const toggleModel = (id: string, contextWindow?: number) => {
    setModels((current) => {
      const existing = current.find((model) => model.id === id);
      if (existing) {
        return current.filter((model) => model.id !== id);
      }
      return [...current, contextWindow !== undefined ? { id, contextWindow } : { id }];
    });
  };

  const handleManualAdd = (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) {
      return;
    }
    if (selectedModelIds.has(trimmed)) {
      return;
    }
    setModels((current) => [...current, { id: trimmed }]);
  };

  const handleSave = async () => {
    if (idValidationError) {
      setFormError(idValidationError);
      return;
    }
    if (!isValidHttpBaseUrl(baseUrl)) {
      setFormError(t("settings.customEndpoints.baseUrlInvalid"));
      return;
    }
    if (models.length === 0) {
      setFormError(t("settings.customEndpoints.selectModel"));
      return;
    }
    setSavePending(true);
    setFormError(undefined);
    const error = await onSave({
      providerId: providerId.trim(),
      baseUrl: baseUrl.trim(),
      ...(isCustomProviderApi(protocol) ? { api: protocol } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      models,
    });
    if (error) {
      setSavePending(false);
      setFormError(error);
      return;
    }
    onClose();
  };

  return (
    <div className="extension-dialog-backdrop">
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="extension-dialog custom-endpoint-dialog"
        data-testid="custom-endpoint-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !savePending) {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "Tab") {
            trapDialogFocus(event, dialogRef.current);
          }
        }}
        ref={dialogRef}
        role="dialog"
      >
        <div
          className="custom-endpoint-dialog__content"
          data-testid="custom-endpoint-dialog-content"
        >
          <div className="extension-dialog__title" id={titleId}>
            {isEdit
              ? t("settings.customEndpoints.editTitle")
              : t("settings.customEndpoints.addTitle")}
          </div>
          <p className="extension-dialog__body">
            {withCode(t("settings.customEndpoints.dialogBody"), {
              path: "~/.pi/agent/models.json",
            })}
          </p>
          <label className="settings-field">
            <span>{t("settings.customEndpoints.providerId")}</span>
            <input
              aria-label={t("settings.customEndpoints.providerId")}
              autoFocus={!isEdit}
              className="settings-search"
              disabled={isEdit || savePending}
              placeholder="ollama-local"
              value={providerId}
              onChange={(event) => setProviderId(event.target.value.trim().toLowerCase())}
            />
            {idValidationError ? (
              <span className="settings-row__description settings-warning">
                {idValidationError}
              </span>
            ) : (
              <span className="settings-row__description">
                {t("settings.customEndpoints.providerIdHelp")}
              </span>
            )}
          </label>
          <label className="settings-field">
            <span>{t("settings.customEndpoints.protocol")}</span>
            <select
              aria-label={t("settings.customEndpoints.protocol")}
              className="settings-search"
              disabled={savePending || probePending}
              value={protocol}
              onChange={(event) => {
                setProtocol(event.target.value);
                setProbeCandidates([]);
                setProbeError(undefined);
              }}
            >
              {initial && !initial.api ? (
                <option value="">{t("settings.customEndpoints.keepProtocol")}</option>
              ) : null}
              {CUSTOM_PROVIDER_APIS.map((api) => (
                <option key={api} value={api}>
                  {api}
                </option>
              ))}
            </select>
            {isEdit ? (
              <span className="settings-row__description">
                {t("settings.customEndpoints.preserveAdvanced")}
              </span>
            ) : null}
          </label>
          <label className="settings-field">
            <span>{t("settings.customEndpoints.baseUrl")}</span>
            <input
              aria-label={t("settings.customEndpoints.baseUrl")}
              className="settings-search"
              disabled={savePending || probePending}
              placeholder="http://localhost:11434/v1"
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                setProbeCandidates([]);
                setProbeError(undefined);
              }}
            />
            <span className="settings-row__description">
              {withCode(
                t(
                  protocol === "anthropic-messages"
                    ? "settings.customEndpoints.anthropicBaseUrlHelp"
                    : "settings.customEndpoints.baseUrlHelp",
                ),
                {
                  suffix: "/v1",
                  ollama: "http://localhost:11434/v1",
                  vllm: "http://localhost:8000/v1",
                },
              )}
            </span>
          </label>
          <label className="settings-field">
            <span>{t("settings.customEndpoints.apiKey")}</span>
            <input
              aria-label={t("settings.customEndpoints.apiKey")}
              className="settings-search"
              disabled={savePending || probePending}
              placeholder={t("settings.customEndpoints.apiKeyPlaceholder")}
              type="password"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                setProbeCandidates([]);
                setProbeError(undefined);
              }}
            />
            <span className="settings-row__description">
              {withCode(t("settings.customEndpoints.apiKeyHelp"), { flag: "--api-key" })}
            </span>
          </label>

          <div className="settings-field">
            <div className="settings-field__header">
              <span>{t("settings.customEndpoints.models")}</span>
              <button
                className="button button--secondary"
                disabled={probePending || savePending || !protocol}
                ref={probeButtonRef}
                type="button"
                onClick={() =>
                  void handleProbe().catch((error: unknown) => {
                    setProbePending(false);
                    setProbeError(error instanceof Error ? error.message : String(error));
                  })
                }
              >
                {probePending
                  ? t("settings.customEndpoints.detecting")
                  : t("settings.customEndpoints.detectModels")}
              </button>
            </div>
            {probeError ? (
              <p className="settings-row__description settings-warning">{probeError}</p>
            ) : null}
            <ModelChecklist
              probed={probeCandidates}
              selected={models}
              onToggle={toggleModel}
              onManualAdd={handleManualAdd}
              disabled={savePending}
            />
            <p className="settings-row__description">
              {t("settings.customEndpoints.toolCallingHelp")}
            </p>
          </div>
        </div>

        <div className="custom-endpoint-dialog__footer" data-testid="custom-endpoint-dialog-footer">
          {formError ? (
            <p className="extension-dialog__body settings-warning">{formError}</p>
          ) : null}
          <div className="extension-dialog__actions">
            <button
              className="button button--secondary"
              disabled={savePending}
              type="button"
              onClick={onClose}
            >
              {t("settings.customEndpoints.cancel")}
            </button>
            <button
              className="button"
              disabled={
                savePending || Boolean(idValidationError) || models.length === 0 || !baseUrl.trim()
              }
              type="button"
              onClick={() =>
                void handleSave().catch((error: unknown) => {
                  setSavePending(false);
                  setFormError(error instanceof Error ? error.message : String(error));
                })
              }
            >
              {isEdit
                ? t("settings.customEndpoints.saveChanges")
                : t("settings.customEndpoints.addEndpoint")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ModelChecklistProps {
  readonly probed: readonly string[];
  readonly selected: readonly CustomProviderModelConfig[];
  readonly onToggle: (id: string, contextWindow?: number) => void;
  readonly onManualAdd: (id: string) => void;
  readonly disabled: boolean;
}

function ModelChecklist({
  probed,
  selected,
  onToggle,
  onManualAdd,
  disabled,
}: ModelChecklistProps) {
  const [manualDraft, setManualDraft] = useState("");
  const selectedIds = useMemo(() => new Set(selected.map((model) => model.id)), [selected]);
  const knownIds = useMemo(
    () => new Set([...probed, ...selected.map((model) => model.id)]),
    [probed, selected],
  );

  const submitManual = () => {
    onManualAdd(manualDraft);
    setManualDraft("");
  };

  return (
    <div className="settings-disclosure__body">
      {knownIds.size === 0 ? (
        <p className="settings-row__description">{t("settings.customEndpoints.checklistEmpty")}</p>
      ) : (
        <ul className="settings-list custom-endpoint-model-list">
          {[...knownIds]
            .sort((a, b) => a.localeCompare(b))
            .map((id) => (
              <li key={id} className="settings-row">
                <label className="custom-endpoint-model-list__item">
                  <input
                    aria-label={t("settings.customEndpoints.enableModel", { model: id })}
                    type="checkbox"
                    checked={selectedIds.has(id)}
                    disabled={disabled}
                    onChange={() => onToggle(id)}
                  />
                  <span className="settings-row__title">{id}</span>
                </label>
              </li>
            ))}
        </ul>
      )}
      <div className="settings-row">
        <input
          aria-label={t("settings.customEndpoints.addModelManually")}
          className="settings-search"
          disabled={disabled}
          placeholder={t("settings.customEndpoints.addModelManually")}
          value={manualDraft}
          onChange={(event) => setManualDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitManual();
            }
          }}
        />
        <button
          className="button button--secondary"
          disabled={disabled || manualDraft.trim().length === 0}
          type="button"
          onClick={submitManual}
        >
          {t("settings.customEndpoints.add")}
        </button>
      </div>
    </div>
  );
}

function validateProviderId(
  candidate: string,
  existing: readonly string[],
  editing?: string,
): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return t("settings.customEndpoints.providerIdRequired");
  }
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(trimmed)) {
    return t("settings.customEndpoints.providerIdPattern");
  }
  if (trimmed !== editing && existing.includes(trimmed)) {
    return t("settings.customEndpoints.providerIdInUse", { id: trimmed });
  }
  return undefined;
}

function withCode(template: string, values: Readonly<Record<string, string>>): ReactNode[] {
  return template
    .split(/\{(\w+)\}/)
    .map((part, index) =>
      index % 2 === 1 ? <code key={index}>{values[part] ?? part}</code> : part,
    );
}
