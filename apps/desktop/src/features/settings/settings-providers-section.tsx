import { useEffect, useMemo, useState } from "react";
import type { RuntimeProviderRecord, RuntimeSnapshot } from "@lancer/session-driver/runtime-types";
import { SearchIcon } from "../../ui/icons";
import type { CustomProviderConfig } from "../../../contracts/ipc";
import { SettingsCustomEndpointsSection } from "./settings-custom-endpoints-section";
import { filterProviders, ProviderRow, SettingsGroup } from "./settings-utils";
import { hasMessage, t } from "../../../contracts/i18n";

interface SettingsProvidersSectionProps {
  readonly runtime?: RuntimeSnapshot;
  readonly onLoginProvider: (providerId: string) => void;
  readonly onLogoutProvider: (providerId: string) => void;
  readonly onSetProviderApiKey: (providerId: string, apiKey: string) => Promise<string | undefined>;
  readonly onRemoveProviderApiKey: (providerId: string) => Promise<string | undefined>;
  readonly onSaveCustomProvider: (config: CustomProviderConfig) => Promise<string | undefined>;
  readonly onDeleteCustomProvider: (providerId: string) => Promise<string | undefined>;
}

const COLLAPSED_AVAILABLE_COUNT = 8;

/** Subscription sign-ins and API-key vendors surfaced first, in display order. */
const QUICK_SUBSCRIPTION_PROVIDER_IDS = [
  "openai-codex",
  "xai",
  "anthropic",
  "github-copilot",
  "kimi-coding",
] as const;
const QUICK_API_KEY_PROVIDER_IDS = [
  "deepseek",
  "moonshotai-cn",
  "moonshotai",
  "openrouter",
  "openai",
  "google",
  "zai-coding-cn",
  "qwen-token-plan-cn",
] as const;

export function providerHint(providerId: string): string | undefined {
  const key = `providers.hint.${providerId}`;
  return hasMessage(key) ? t(key) : undefined;
}

/** Sign-in providers first, then API key providers, then the rest, each alphabetical. */
function compareAvailableProviders(left: RuntimeProviderRecord, right: RuntimeProviderRecord) {
  const rank = (provider: RuntimeProviderRecord) =>
    provider.oauthSupported ? 0 : provider.apiKeySetupSupported ? 1 : 2;
  return rank(left) - rank(right) || left.name.localeCompare(right.name);
}

export function SettingsProvidersSection({
  runtime,
  onLoginProvider,
  onLogoutProvider,
  onSetProviderApiKey,
  onRemoveProviderApiKey,
  onSaveCustomProvider,
  onDeleteCustomProvider,
}: SettingsProvidersSectionProps) {
  const [providerQuery, setProviderQuery] = useState("");
  const [showAllAvailable, setShowAllAvailable] = useState(false);
  const [apiKeyProviderId, setApiKeyProviderId] = useState<string | undefined>();
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyError, setApiKeyError] = useState<string | undefined>();
  const [apiKeyPending, setApiKeyPending] = useState(false);

  const providers = runtime?.providers ?? [];
  const connectedProviders = providers.filter((provider) => provider.hasAuth);
  const defaultProviderId = runtime?.settings.defaultProvider;
  const attentionProviders = providers.filter(
    (provider) => provider.id === defaultProviderId && !provider.hasAuth,
  );
  const availableProviders = providers
    .filter((provider) => !provider.hasAuth && provider.id !== defaultProviderId)
    .sort(compareAvailableProviders);
  const filteredAvailable = filterProviders(availableProviders, providerQuery);
  const expandAvailable = showAllAvailable || providerQuery.trim().length > 0;
  const shownAvailable = expandAvailable
    ? filteredAvailable
    : filteredAvailable.slice(0, COLLAPSED_AVAILABLE_COUNT);
  const hiddenAvailableCount = filteredAvailable.length - shownAvailable.length;
  const pickProviders = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const provider = providers.find((entry) => entry.id === id);
      return provider ? [provider] : [];
    });
  const quickSubscriptions = pickProviders(QUICK_SUBSCRIPTION_PROVIDER_IDS);
  const quickApiKeys = pickProviders(QUICK_API_KEY_PROVIDER_IDS);
  const rowHandlers = {
    onLoginProvider,
    onLogoutProvider,
    onConfigureApiKey: (entry: RuntimeProviderRecord) => setApiKeyProviderId(entry.id),
  };
  const apiKeyProvider = apiKeyProviderId
    ? providers.find((provider) => provider.id === apiKeyProviderId)
    : undefined;
  const existingProviderIds = useMemo(() => providers.map((provider) => provider.id), [providers]);

  useEffect(() => {
    setApiKeyDraft("");
    setApiKeyError(undefined);
    setApiKeyPending(false);
  }, [apiKeyProviderId]);

  const closeApiKeyDialog = () => {
    if (apiKeyPending) {
      return;
    }
    setApiKeyProviderId(undefined);
  };

  const handleSaveApiKey = async () => {
    if (!apiKeyProvider) {
      return;
    }
    setApiKeyPending(true);
    setApiKeyError(undefined);
    const nextError = await onSetProviderApiKey(apiKeyProvider.id, apiKeyDraft.trim());
    if (nextError) {
      setApiKeyPending(false);
      setApiKeyError(nextError);
      return;
    }
    setApiKeyProviderId(undefined);
  };

  const handleRemoveApiKey = async () => {
    if (!apiKeyProvider) {
      return;
    }
    setApiKeyPending(true);
    setApiKeyError(undefined);
    const nextError = await onRemoveProviderApiKey(apiKeyProvider.id);
    if (nextError) {
      setApiKeyPending(false);
      setApiKeyError(nextError);
      return;
    }
    setApiKeyProviderId(undefined);
  };

  return (
    <>
      {attentionProviders.length > 0 ? (
        <SettingsGroup
          title={t("providers.attentionTitle")}
          description={t("providers.attentionDescription")}
        >
          {attentionProviders.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} {...rowHandlers} />
          ))}
        </SettingsGroup>
      ) : null}

      <section className="settings-section">
        <h3 className="settings-section__title">
          {t("providers.connected")}{" "}
          <span className="resource-list__count">{connectedProviders.length}</span>
        </h3>
        <p className="settings-section__description">{t("providers.connectedDescription")}</p>
        <div className="settings-group">
          {connectedProviders.length > 0 ? (
            connectedProviders.map((provider) => (
              <ProviderRow key={provider.id} provider={provider} {...rowHandlers} />
            ))
          ) : (
            <div className="settings-row">
              <span className="settings-row__description">{t("providers.noneConnected")}</span>
            </div>
          )}
        </div>
      </section>

      {quickSubscriptions.length > 0 || quickApiKeys.length > 0 ? (
        <section className="settings-section" data-testid="settings-quick-providers">
          <h3 className="settings-section__title">{t("providers.quickTitle")}</h3>
          <p className="settings-section__description">{t("providers.quickDescription")}</p>
          {quickSubscriptions.length > 0 ? (
            <>
              <h4 className="settings-section__subtitle">{t("providers.quickSubscriptions")}</h4>
              <div className="settings-group">
                {quickSubscriptions.map((provider) => (
                  <ProviderRow
                    key={provider.id}
                    provider={provider}
                    description={providerHint(provider.id)}
                    {...rowHandlers}
                  />
                ))}
              </div>
            </>
          ) : null}
          {quickApiKeys.length > 0 ? (
            <>
              <h4 className="settings-section__subtitle">{t("providers.quickApiKeys")}</h4>
              <div className="settings-group">
                {quickApiKeys.map((provider) => (
                  <ProviderRow
                    key={provider.id}
                    provider={provider}
                    description={providerHint(provider.id)}
                    {...rowHandlers}
                  />
                ))}
              </div>
            </>
          ) : null}
          <p className="settings-section__description">{t("providers.quickCustomDescription")}</p>
        </section>
      ) : null}

      <SettingsCustomEndpointsSection
        existingProviderIds={existingProviderIds}
        onConfigureNativeProvider={setApiKeyProviderId}
        onSaveCustomProvider={onSaveCustomProvider}
        onDeleteCustomProvider={onDeleteCustomProvider}
      />

      <section className="settings-section">
        <div className="settings-section__header">
          <h3 className="settings-section__title">
            {t("providers.available")}{" "}
            <span className="resource-list__count">{availableProviders.length}</span>
          </h3>
          <label className="resource-search">
            <SearchIcon />
            <input
              aria-label={t("providers.search")}
              placeholder={t("providers.search")}
              spellCheck={false}
              type="search"
              value={providerQuery}
              onChange={(event) => setProviderQuery(event.currentTarget.value)}
            />
          </label>
        </div>
        <p className="settings-section__description">{t("providers.availableDescription")}</p>
        <div className="settings-group" data-testid="settings-available-providers">
          {shownAvailable.length > 0 ? (
            shownAvailable.map((provider) => (
              <ProviderRow key={provider.id} provider={provider} {...rowHandlers} />
            ))
          ) : (
            <div className="settings-row">
              <span className="settings-row__description">
                {providerQuery.trim()
                  ? t("providers.noMatch", { query: providerQuery.trim() })
                  : t("providers.allConnected")}
              </span>
            </div>
          )}
        </div>
        {hiddenAvailableCount > 0 ? (
          <button
            className="resource-list__more"
            type="button"
            onClick={() => setShowAllAvailable(true)}
          >
            {t("providers.showMore", { count: hiddenAvailableCount })}
          </button>
        ) : null}
      </section>

      {apiKeyProvider ? (
        <ProviderApiKeyDialog
          provider={apiKeyProvider}
          draft={apiKeyDraft}
          error={apiKeyError}
          pending={apiKeyPending}
          onChangeDraft={setApiKeyDraft}
          onClose={closeApiKeyDialog}
          onRemove={apiKeyProvider.authSource === "auth_file" ? handleRemoveApiKey : undefined}
          onSave={handleSaveApiKey}
        />
      ) : null}
    </>
  );
}

function ProviderApiKeyDialog({
  provider,
  draft,
  error,
  pending,
  onChangeDraft,
  onClose,
  onRemove,
  onSave,
}: {
  readonly provider: RuntimeSnapshot["providers"][number];
  readonly draft: string;
  readonly error?: string;
  readonly pending: boolean;
  readonly onChangeDraft: (value: string) => void;
  readonly onClose: () => void;
  readonly onRemove?: () => Promise<void>;
  readonly onSave: () => Promise<void>;
}) {
  const title =
    provider.authSource === "auth_file"
      ? t("providers.dialog.manageTitle")
      : t("providers.dialog.setTitle");
  const body =
    provider.authSource === "auth_file"
      ? t("providers.dialog.manageBody", { name: provider.name })
      : t("providers.dialog.setBody", { name: provider.name });

  return (
    <div className="extension-dialog-backdrop">
      <div className="extension-dialog" data-testid="provider-api-key-dialog">
        <div className="extension-dialog__title">{title}</div>
        <p className="extension-dialog__body">{body}</p>
        <p className="extension-dialog__body settings-row__hint">
          {t("providers.dialog.storageNote")}
        </p>
        <input
          aria-label={t("providers.dialog.inputLabel", { name: provider.name })}
          autoFocus
          className="settings-search"
          disabled={pending}
          placeholder={t("providers.dialog.placeholder")}
          type="password"
          value={draft}
          onChange={(event) => onChangeDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key === "Enter" && draft.trim()) {
              event.preventDefault();
              void onSave().catch((error: unknown) => {
                console.error("[renderer] onSave failed", error);
              });
            }
          }}
        />
        {error ? <p className="extension-dialog__body settings-warning">{error}</p> : null}
        <div className="extension-dialog__actions">
          <button
            className="button button--secondary"
            disabled={pending}
            type="button"
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          {onRemove ? (
            <button
              className="button button--secondary"
              disabled={pending}
              type="button"
              onClick={() =>
                void onRemove().catch((error: unknown) => {
                  console.error("[renderer] onRemove failed", error);
                })
              }
            >
              {t("providers.dialog.remove")}
            </button>
          ) : null}
          <button
            className="button"
            disabled={pending || draft.trim().length === 0}
            type="button"
            onClick={() =>
              void onSave().catch((error: unknown) => {
                console.error("[renderer] onSave failed", error);
              })
            }
          >
            {provider.authSource === "auth_file"
              ? t("providers.dialog.saveKey")
              : t("providers.action.setApiKey")}
          </button>
        </div>
      </div>
    </div>
  );
}
