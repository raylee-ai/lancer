import { LANCER_SESSION_ZONES, conversationZoneId, type LancerSessionZone } from "./lancer-zones";
import { decodeLancerWorkflow, type LancerWorkflow } from "./lancer-workflows";

export interface LancerModule {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly description: string;
  readonly workflow?: LancerWorkflow;
  readonly deleted?: boolean;
}
export const DEFAULT_LANCER_MODULES: readonly LancerModule[] = LANCER_SESSION_ZONES.filter(
  (zone) => zone.id !== "chat",
).map(({ id, label, color }) => ({
  id,
  label: id === "lancer" ? "Lancer 自举" : label,
  color,
  description: "",
}));

export function moduleZones(
  modules: readonly LancerModule[] = DEFAULT_LANCER_MODULES,
): readonly LancerSessionZone[] {
  return [
    LANCER_SESSION_ZONES[0]!,
    ...modules
      .filter((module) => !module.deleted)
      .map((module) => {
        const preset = LANCER_SESSION_ZONES.find((zone) => zone.id === module.id);
        return {
          ...module,
          relay: [],
          // A module still carrying its preset name follows the interface
          // language; a renamed module is user data and stays verbatim.
          ...(preset && preset.label === module.label ? { labelKey: preset.labelKey } : {}),
        };
      }),
  ];
}
export function decodeLancerModule(value: unknown): LancerModule {
  const module = value as LancerModule;
  if (
    !module ||
    typeof module.id !== "string" ||
    !/^[a-z0-9_-]{1,60}$/.test(module.id) ||
    module.id === "chat"
  )
    throw new Error("无效模块标识。");
  if (typeof module.label !== "string" || !module.label.trim() || module.label.length > 40)
    throw new Error("模块名称需要 1–40 字。");
  if (typeof module.color !== "string" || !/^#[0-9a-f]{6}$/i.test(module.color))
    throw new Error("请选择模块颜色。");
  if (typeof module.description !== "string" || module.description.length > 1000)
    throw new Error("模块说明最多 1000 字。");
  if (module.deleted !== undefined && typeof module.deleted !== "boolean")
    throw new Error("无效模块状态。");
  return {
    id: module.id,
    label: module.label.trim(),
    color: module.color,
    description: module.description.trim(),
    ...(module.workflow
      ? { workflow: { steps: decodeLancerWorkflow(module.workflow).steps } }
      : {}),
    ...(module.deleted ? { deleted: true } : {}),
  };
}

export function conversationModule(
  title: string,
  state?: { readonly modules?: readonly LancerModule[] },
): LancerSessionZone {
  return (
    moduleZones(state?.modules).find(
      (zone) => zone.id === conversationZoneId(title, state?.modules),
    ) ?? LANCER_SESSION_ZONES[0]!
  );
}
