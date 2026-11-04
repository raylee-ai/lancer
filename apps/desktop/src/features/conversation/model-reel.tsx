import { useId, useMemo, useRef, useState } from "react";
import { ModelBrandIcon } from "../../ui/model-brand-icon";
import { MODEL_FAMILIES, modelFamily } from "../../ui/model-families";
import type { RuntimeSnapshot, RuntimeModelRecord } from "@lancer/session-driver/runtime-types";
import { buildModelOptions } from "./composer-commands";
import { t } from "../../../contracts/i18n";
import "./model-catalog.css";

export function ModelReel({
  onSelectDoubaoApp,
  doubaoActive,
  runtime,
  provider,
  modelId,
  disabled,
  onSelectModel,
}: {
  readonly onSelectDoubaoApp?: () => void;
  readonly doubaoActive?: boolean;
  readonly runtime?: RuntimeSnapshot;
  readonly provider?: string;
  readonly modelId?: string;
  readonly disabled?: boolean;
  readonly onSelectModel: (provider: string, modelId: string) => void;
}) {
  const id = useId();
  const popover = useRef<HTMLDivElement>(null);
  const [familyId, setFamilyId] = useState<string>(modelFamily(provider, modelId)?.id ?? "openai");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const available = useMemo(
    () => new Set(buildModelOptions(runtime).map((m) => `${m.providerId}/${m.modelId}`)),
    [runtime],
  );
  const families = MODEL_FAMILIES;
  const catalog = useMemo(() => {
    const groups = new Map<string, RuntimeModelRecord[]>();
    const counts = new Map<string, number>();
    for (const model of runtime?.models ?? []) {
      const family = modelFamily(model.providerId, model.modelId, model.label)?.id;
      if (!family) continue;
      const group = groups.get(family) ?? [];
      group.push(model);
      groups.set(family, group);
      if (available.has(`${model.providerId}/${model.modelId}`))
        counts.set(family, (counts.get(family) ?? 0) + 1);
    }
    return { groups, counts };
  }, [runtime?.models, available]);
  const models = catalog.groups.get(familyId) ?? [];
  const hasAppEntry = familyId === "doubao" && Boolean(onSelectDoubaoApp);
  const matches = (open ? models : [])
    .filter((m) =>
      `${m.label} ${m.providerId} ${m.modelId}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(available.has(`${b.providerId}/${b.modelId}`)) -
        Number(available.has(`${a.providerId}/${a.modelId}`)),
    );
  const activeModel = runtime?.models.find(
    (model) => model.providerId === provider && model.modelId === modelId,
  );
  const activeFamily = doubaoActive
    ? "doubao"
    : modelFamily(provider, modelId, activeModel?.label)?.id;
  return (
    <div className="model-catalog" data-testid="model-reel">
      <div className="model-catalog__families" aria-label="模型图标预览">
        {families.map((family) => {
          const count = catalog.counts.get(family.id) ?? 0;
          return (
            <button
              type="button"
              key={family.id}
              popoverTarget={id}
              popoverTargetAction="show"
              disabled={disabled}
              aria-pressed={activeFamily === family.id}
              data-anchor-key={`family:${family.id}`}
              title={
                family.id === "doubao" && onSelectDoubaoApp
                  ? `${family.label} · App 直连${count ? ` · ${count} 个可用 API 模型` : ""}`
                  : `${family.label} · ${count} 个可用模型`
              }
              className={
                count || (family.id === "doubao" && onSelectDoubaoApp) ? "" : "unconfigured"
              }
              onClick={(e) => {
                setFamilyId(family.id);
                setQuery("");
                const bounds = e.currentTarget.getBoundingClientRect();
                popover.current?.style.setProperty(
                  "--catalog-x",
                  `${Math.max(8, Math.min(bounds.left, innerWidth - 340))}px`,
                );
              }}
            >
              <ModelBrandIcon provider={family.id} />
              <span>{family.label}</span>
            </button>
          );
        })}
      </div>
      <span
        className="model-catalog__current"
        title={doubaoActive ? "豆包 App" : `${provider} · ${modelId}`}
      >
        {doubaoActive ? "豆包 App" : (modelId ?? t("lancer.modelReel.aria"))}
      </span>
      <div
        ref={popover}
        id={id}
        popover="auto"
        className="model-catalog__popover"
        aria-label={t("lancer.modelReel.aria")}
        onToggle={(event) => setOpen(event.currentTarget.matches(":popover-open"))}
      >
        <header>
          {families.find((f) => f.id === familyId)?.label}
          <span>
            {hasAppEntry
              ? models.length
                ? t("lancer.modelReel.appModels", { count: models.length })
                : t("lancer.modelReel.appDirect")
              : t("lancer.modelReel.modelCount", { count: models.length })}
          </span>
        </header>
        {models.length > 6 ? (
          <input
            type="search"
            aria-label={t("lancer.modelReel.search")}
            placeholder={t("lancer.modelReel.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : null}
        {hasAppEntry ? (
          <button
            type="button"
            aria-label="打开豆包 App"
            aria-pressed={Boolean(doubaoActive)}
            disabled={disabled}
            data-testid="catalog-doubao-app"
            onClick={() => {
              popover.current?.hidePopover();
              onSelectDoubaoApp?.();
            }}
          >
            <ModelBrandIcon provider="doubao" />
            <span>
              打开豆包 App<small>GUI 对话直连{doubaoActive ? " · 当前会话" : ""}</small>
            </span>
          </button>
        ) : null}
        {matches.map((model) => {
          const enabled = available.has(`${model.providerId}/${model.modelId}`);
          return (
            <button
              type="button"
              key={`${model.providerId}/${model.modelId}`}
              disabled={!enabled || disabled}
              aria-pressed={provider === model.providerId && modelId === model.modelId}
              onClick={() => {
                popover.current?.hidePopover();
                onSelectModel(model.providerId, model.modelId);
              }}
            >
              <ModelBrandIcon provider={model.providerId} modelId={model.modelId} />
              <span>
                {model.label}
                <small>
                  {model.providerId} · {model.modelId}
                </small>
              </span>
              {!enabled ? <small>{model.available ? "未启用" : "未配置"}</small> : null}
            </button>
          );
        })}
        {!models.length && !hasAppEntry ? <p>尚未配置此模型家族，可在工作区设置中连接。</p> : null}
        {models.length > 0 && !matches.length ? <p>没有匹配的模型。</p> : null}
      </div>
    </div>
  );
}
