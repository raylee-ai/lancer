import { expect, test } from "@playwright/test";
import {
  BUILT_IN_PROVIDER_IDS,
  CUSTOM_PROVIDER_ID_PATTERN,
} from "@lancer/pi-sdk-driver/custom-provider-types";
import {
  PROVIDER_PRESETS,
  filterProviderPresets,
  findProviderPreset,
} from "../../contracts/provider-presets";

test("presets use distinct identities without overriding native providers", () => {
  const ids = new Set<string>();
  const providerIds = new Set<string>();
  for (const preset of PROVIDER_PRESETS) {
    expect(ids.has(preset.id)).toBe(false);
    expect(providerIds.has(preset.providerId)).toBe(false);
    ids.add(preset.id);
    providerIds.add(preset.providerId);
    expect(CUSTOM_PROVIDER_ID_PATTERN.test(preset.providerId)).toBe(true);
    expect(BUILT_IN_PROVIDER_IDS.has(preset.providerId)).toBe(preset.kind === "native");
  }
});

test("public presets contain no credentials or model selections", () => {
  for (const preset of PROVIDER_PRESETS) {
    expect(preset).not.toHaveProperty("apiKey");
    expect(preset).not.toHaveProperty("models");
    expect(preset).not.toHaveProperty("modelId");
    const docs = new URL(preset.docsUrl);
    expect(docs.protocol).toBe("https:");
    expect(docs.username).toBe("");
    expect(docs.password).toBe("");
    if (preset.kind === "custom" && preset.baseUrl) {
      const url = new URL(preset.baseUrl);
      expect(url.username).toBe("");
      expect(url.password).toBe("");
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      expect(url.protocol).toBe(preset.group === "local" ? "http:" : "https:");
      if (preset.group === "local") expect(url.hostname).toBe("localhost");
    }
  }
});

test("Volcengine subscriptions keep their billing endpoints and protocol distinct", () => {
  const payg = findProviderPreset("volcengine-payg");
  const agent = findProviderPreset("volcengine-agent-plan");
  const coding = findProviderPreset("volcengine-coding-plan");
  expect(payg).toMatchObject({
    plan: "payg",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    api: "openai-completions",
  });
  expect(agent).toMatchObject({
    plan: "agent-plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan",
    api: "anthropic-messages",
  });
  expect(coding).toMatchObject({
    plan: "coding-plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    api: "openai-completions",
  });
});

test("generic protocols require the user to choose a destination", () => {
  const gateways = PROVIDER_PRESETS.filter((preset) => preset.group === "gateway");
  expect(gateways).toHaveLength(3);
  expect(gateways.map((preset) => preset.kind === "custom" && preset.api).sort()).toEqual([
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
  ]);
  for (const preset of gateways) expect(preset).toMatchObject({ kind: "custom", baseUrl: "" });
});

test("preset search finds Chinese names, aliases and protocols without changing the catalog", () => {
  expect(filterProviderPresets("  方舟 ").map((preset) => preset.id)).toEqual([
    "volcengine-payg",
    "volcengine-agent-plan",
    "volcengine-coding-plan",
  ]);
  expect(filterProviderPresets("LmStUdIo").map((preset) => preset.id)).toEqual(["lm-studio"]);
  expect(filterProviderPresets("Responses").map((preset) => preset.id)).toEqual([
    "openai-responses-compatible",
  ]);
  expect(filterProviderPresets("网关")).toHaveLength(3);
  expect(filterProviderPresets("硅基").map((preset) => preset.id)).toEqual([
    "siliconflow-international",
  ]);
  expect(filterProviderPresets("not-a-provider")).toEqual([]);
  expect(filterProviderPresets("  ")).toBe(PROVIDER_PRESETS);
  expect(findProviderPreset("not-a-provider")).toBeUndefined();
  for (const preset of PROVIDER_PRESETS) {
    expect(preset.name.en.trim()).not.toBe("");
    expect(preset.name["zh-CN"].trim()).not.toBe("");
    expect(preset.description.en.trim()).not.toBe("");
    expect(preset.description["zh-CN"].trim()).not.toBe("");
  }
});
