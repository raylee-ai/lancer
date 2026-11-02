import type { LancerModule } from "./lancer-modules";
import { t, type MessageKey } from "./i18n";
/** Explicit conversation modes shared by sidebar, workflows and local control. */

export interface LancerSessionZone {
  readonly id: string;
  /** Stored/display fallback (user-defined modules own their label). */
  readonly label: string;
  /** Preset zones translate at render time; modules keep their saved label. */
  readonly labelKey?: MessageKey;
  readonly color: string;
  readonly relay: readonly LancerRelayModel[];
}

/** Translate a zone name at render time; modules without a key keep their saved label. */
export function lancerZoneLabel(zone: Pick<LancerSessionZone, "label" | "labelKey">): string {
  return zone.labelKey ? t(zone.labelKey) : zone.label;
}

export interface LancerRelayModel {
  readonly provider: string;
  readonly modelId: string;
  readonly label: string;
}

const CODEX = { provider: "openai", modelId: "gpt-5", label: "Codex" };
const OPUS = { provider: "anthropic", modelId: "claude-opus-4-5", label: "Claude Opus" };
const GROK = { provider: "xai", modelId: "grok-4.3", label: "Grok" };

/** Video processing runs locally; model analysis uses the configured gateway, not a preset chat relay. */
export const VIDEO_LEARN_ZONE_RELAY: readonly LancerRelayModel[] = [];

export const LANCER_SESSION_ZONES: readonly LancerSessionZone[] = [
  { id: "chat", label: "常态会话", labelKey: "lancer.zone.chat", color: "#64748B", relay: [] },
  {
    id: "video",
    label: "视频复刻",
    labelKey: "lancer.zone.video",
    color: "#3B82F6",
    relay: VIDEO_LEARN_ZONE_RELAY,
  },
  {
    id: "research",
    label: "竞品调研",
    labelKey: "lancer.zone.research",
    color: "#8B5CF6",
    relay: [{ provider: "xai", modelId: "grok-3-mini", label: "X 搜索" }, GROK, CODEX],
  },
  { id: "paper", label: "论文查询", labelKey: "lancer.zone.paper", color: "#0891B2", relay: [] },
  {
    id: "github",
    label: "GitHub 研究",
    labelKey: "lancer.zone.github",
    color: "#D97706",
    relay: [],
  },
  {
    id: "lancer",
    label: "Lancer",
    labelKey: "lancer.zone.lancer",
    color: "#10B981",
    relay: [CODEX, OPUS],
  },
  {
    id: "xhs",
    label: "小红书",
    labelKey: "lancer.zone.xhs",
    color: "#DB2777",
    relay: [{ provider: "moonshot", modelId: "kimi-k2", label: "Kimi" }, CODEX],
  },
];

const ZONE_PREFIX = /^lancer-zone:([a-z0-9_-]+)\|/i;

/** Only an explicit module tag makes a conversation modular. Discussing a video
 * or paper in ordinary chat must not silently change its mode. */
export function conversationZoneId(title: string, modules?: readonly LancerModule[]): string {
  const id = ZONE_PREFIX.exec(title.trim())?.[1]?.toLowerCase();
  if (modules) return modules.some((module) => module.id === id && !module.deleted) ? id! : "chat";
  return id &&
    (LANCER_SESSION_ZONES.some((zone) => zone.id === id) || /^module-[a-z0-9-]+$/.test(id))
    ? id
    : "chat";
}

export function stripLancerZonePrefix(title: string): string {
  return title.replace(ZONE_PREFIX, "").trim();
}

export function lancerZoneById(zoneId: string): LancerSessionZone {
  return (
    LANCER_SESSION_ZONES.find((zone) => zone.id === zoneId) ??
    LANCER_SESSION_ZONES.find((zone) => zone.id === "lancer")!
  );
}

export function formatSessionTitleForZone(zoneId: string, title: string): string {
  const stripped = stripLancerZonePrefix(title);
  return `lancer-zone:${zoneId}|${stripped}`;
}
