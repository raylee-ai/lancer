import type { CustomProviderApi } from "@lancer/pi-sdk-driver/custom-provider-types";
import type { Locale } from "./i18n/define";

export type ProviderPresetText = Readonly<Record<Locale, string>>;

interface ProviderPresetCommon {
  readonly id: string;
  readonly name: ProviderPresetText;
  readonly description: ProviderPresetText;
  readonly searchAliases: readonly string[];
  readonly group: "cloud" | "local" | "gateway";
  readonly region?: "cn" | "international" | "local";
  readonly plan?: "payg" | "agent-plan" | "coding-plan";
  readonly docsUrl: string;
  readonly modelHint?: ProviderPresetText;
}

export interface NativeProviderPreset extends ProviderPresetCommon {
  readonly kind: "native";
  readonly providerId: string;
}

export interface CustomProviderPreset extends ProviderPresetCommon {
  readonly kind: "custom";
  readonly providerId: string;
  readonly baseUrl: string;
  readonly api: CustomProviderApi;
}

export type ProviderPreset = NativeProviderPreset | CustomProviderPreset;

// Presets describe public connection settings only. Model availability and credentials
// belong to the user's account; choosing a preset must not make a network request.
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "ollama",
    kind: "custom",
    providerId: "ollama-local",
    name: { en: "Ollama", "zh-CN": "Ollama 本地模型" },
    description: {
      en: "Connect to your running Ollama server through its OpenAI-compatible API.",
      "zh-CN": "通过 OpenAI 兼容接口连接已启动的 Ollama 本地服务。",
    },
    searchAliases: ["local", "localhost", "本地", "离线"],
    group: "local",
    region: "local",
    baseUrl: "http://localhost:11434/v1",
    api: "openai-completions",
    docsUrl: "https://docs.ollama.com/api/openai-compatibility",
    modelHint: {
      en: "Use the exact name of a downloaded model. The default local server does not require an API key.",
      "zh-CN": "填写已下载模型的完整名称。默认本地服务不需要 API 密钥。",
    },
  },
  {
    id: "lm-studio",
    kind: "custom",
    providerId: "lmstudio-local",
    name: { en: "LM Studio", "zh-CN": "LM Studio 本地模型" },
    description: {
      en: "Connect to LM Studio after enabling its local API server.",
      "zh-CN": "启用 LM Studio 的本地 API 服务后连接。",
    },
    searchAliases: ["lmstudio", "local", "localhost", "本地", "离线"],
    group: "local",
    region: "local",
    baseUrl: "http://localhost:1234/v1",
    api: "openai-completions",
    docsUrl: "https://lmstudio.ai/docs/developer/openai-compat",
    modelHint: {
      en: "Detect or enter the model ID served by your local instance; use a key if server authentication is enabled.",
      "zh-CN": "检测或填写本地实例实际提供的模型 ID；如果启用了服务认证，还需填写密钥。",
    },
  },
  {
    id: "volcengine-payg",
    kind: "custom",
    providerId: "volcengine-payg",
    name: { en: "Volcengine Ark · Pay as you go", "zh-CN": "火山方舟 · 按量付费" },
    description: {
      en: "Use the standard Beijing Ark endpoint with pay-as-you-go billing.",
      "zh-CN": "使用北京地域的标准方舟接口，按量计费。",
    },
    searchAliases: ["volcengine", "ark", "doubao", "火山", "方舟", "豆包", "按量"],
    group: "cloud",
    region: "cn",
    plan: "payg",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    api: "openai-completions",
    docsUrl: "https://www.volcengine.com/docs/82379/1330310",
    modelHint: {
      en: "Copy a model or endpoint ID available to your account from the Ark console. This URL does not use subscription quota.",
      "zh-CN": "从方舟控制台复制账号可用的模型或接入点 ID。此地址不使用订阅套餐额度。",
    },
  },
  {
    id: "volcengine-agent-plan",
    kind: "custom",
    providerId: "volcengine-agent-plan",
    name: { en: "Volcengine Ark · Agent Plan", "zh-CN": "火山方舟 · Agent Plan" },
    description: {
      en: "Use the dedicated Agent Plan endpoint with the Anthropic Messages protocol.",
      "zh-CN": "使用 Agent Plan 专用地址和 Anthropic Messages 协议。",
    },
    searchAliases: ["volcengine", "ark", "doubao", "agentplan", "火山", "方舟", "豆包", "套餐"],
    group: "cloud",
    region: "cn",
    plan: "agent-plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan",
    api: "anthropic-messages",
    docsUrl: "https://www.volcengine.com/docs/ark/agent-plan-personal-get-started?lang=zh",
    modelHint: {
      en: "Use your Agent Plan key and a model name listed for that subscription. Keep the dedicated /api/plan URL.",
      "zh-CN": "使用 Agent Plan 密钥及该套餐提供的模型名称，并保留专用的 /api/plan 地址。",
    },
  },
  {
    id: "volcengine-coding-plan",
    kind: "custom",
    providerId: "volcengine-coding-plan",
    name: { en: "Volcengine Ark · Coding Plan", "zh-CN": "火山方舟 · Coding Plan" },
    description: {
      en: "Use the dedicated Coding Plan endpoint with the OpenAI Chat Completions protocol.",
      "zh-CN": "使用 Coding Plan 专用地址和 OpenAI Chat Completions 协议。",
    },
    searchAliases: ["volcengine", "ark", "doubao", "codingplan", "火山", "方舟", "豆包", "套餐"],
    group: "cloud",
    region: "cn",
    plan: "coding-plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    api: "openai-completions",
    docsUrl: "https://www.volcengine.com/docs/82379/1928261",
    modelHint: {
      en: "Use a model name and key from your Coding Plan. Switching to /api/v3 changes billing to pay as you go.",
      "zh-CN": "填写 Coding Plan 提供的模型名称和密钥。改用 /api/v3 会变为按量计费。",
    },
  },
  {
    id: "siliconflow-international",
    kind: "custom",
    providerId: "siliconflow-international",
    name: { en: "SiliconFlow · International", "zh-CN": "SiliconFlow 硅基流动 · 国际站" },
    description: {
      en: "Connect to SiliconFlow's international API. Region-specific accounts and keys are separate.",
      "zh-CN": "连接硅基流动国际站 API。国际站和中国站使用各自的账号与密钥。",
    },
    searchAliases: ["siliconflow", "硅基", "硅基流动"],
    group: "cloud",
    region: "international",
    baseUrl: "https://api.siliconflow.com/v1",
    api: "openai-completions",
    docsUrl: "https://docs.siliconflow.com/en/userguide/quickstart",
    modelHint: {
      en: "Detect or copy an available model ID from the international console, including any organization prefix.",
      "zh-CN": "检测或从国际站控制台复制可用模型 ID，保留模型名称中的组织前缀。",
    },
  },
  {
    id: "dashscope-cn",
    kind: "custom",
    providerId: "dashscope-cn",
    name: { en: "Alibaba Cloud Model Studio · Beijing", "zh-CN": "阿里云百炼 · 北京" },
    description: {
      en: "Use the Beijing OpenAI-compatible API with a key for the same region.",
      "zh-CN": "使用北京地域的 OpenAI 兼容 API，密钥需属于同一地域。",
    },
    searchAliases: ["dashscope", "qwen", "alibaba", "bailian", "通义", "千问", "阿里", "百炼"],
    group: "cloud",
    region: "cn",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    docsUrl:
      "https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope",
    modelHint: {
      en: "Use an available model name. The legacy domain remains supported; replace it with your workspace-specific URL if recommended by the console.",
      "zh-CN": "填写可用模型名称。旧域名仍受支持；控制台如推荐工作空间专属地址，可替换为对应地址。",
    },
  },
  {
    id: "dashscope-international",
    kind: "custom",
    providerId: "dashscope-international",
    name: { en: "Alibaba Cloud Model Studio · Singapore", "zh-CN": "阿里云百炼 · 新加坡" },
    description: {
      en: "Use the Singapore OpenAI-compatible API with a key for the same region.",
      "zh-CN": "使用新加坡地域的 OpenAI 兼容 API，密钥需属于同一地域。",
    },
    searchAliases: [
      "dashscope",
      "qwen",
      "alibaba",
      "bailian",
      "通义",
      "千问",
      "阿里",
      "百炼",
      "国际",
    ],
    group: "cloud",
    region: "international",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    docsUrl:
      "https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope",
    modelHint: {
      en: "Use a model name available in Singapore. Replace the legacy domain with your workspace-specific URL if recommended by the console.",
      "zh-CN": "填写新加坡地域可用的模型名称。控制台如推荐工作空间专属地址，可替换旧域名。",
    },
  },
  {
    id: "openrouter",
    kind: "native",
    providerId: "openrouter",
    name: { en: "OpenRouter", "zh-CN": "OpenRouter" },
    description: {
      en: "Connect through the built-in OpenRouter provider and its existing model catalog.",
      "zh-CN": "通过内置 OpenRouter 提供商连接，复用现有模型目录。",
    },
    searchAliases: ["openrouter", "router", "聚合"],
    group: "cloud",
    region: "international",
    docsUrl: "https://openrouter.ai/docs/quickstart",
  },
  {
    id: "openai-compatible",
    kind: "custom",
    providerId: "custom-openai",
    name: { en: "Custom · OpenAI Chat Completions", "zh-CN": "自定义 · OpenAI Chat Completions" },
    description: {
      en: "Enter the base URL of your own Chat Completions-compatible service.",
      "zh-CN": "填写你自己的 Chat Completions 兼容服务地址。",
    },
    searchAliases: ["gateway", "openai", "chat", "completions", "自定义", "网关", "中转"],
    group: "gateway",
    baseUrl: "",
    api: "openai-completions",
    docsUrl: "https://platform.openai.com/docs/api-reference/chat",
    modelHint: {
      en: "Use the service's API base URL and model IDs. Do not append /chat/completions to the base URL.",
      "zh-CN": "填写服务提供的 API 基础地址和模型 ID；基础地址不要包含 /chat/completions。",
    },
  },
  {
    id: "openai-responses-compatible",
    kind: "custom",
    providerId: "custom-responses",
    name: { en: "Custom · OpenAI Responses", "zh-CN": "自定义 · OpenAI Responses" },
    description: {
      en: "Enter the base URL of your own Responses-compatible service.",
      "zh-CN": "填写你自己的 Responses 兼容服务地址。",
    },
    searchAliases: ["gateway", "openai", "responses", "codex", "自定义", "网关", "中转"],
    group: "gateway",
    baseUrl: "",
    api: "openai-responses",
    docsUrl: "https://platform.openai.com/docs/api-reference/responses",
    modelHint: {
      en: "Confirm that your service supports Responses and its model IDs. Do not append /responses to the base URL.",
      "zh-CN": "确认服务支持 Responses 协议及所填模型 ID；基础地址不要包含 /responses。",
    },
  },
  {
    id: "anthropic-compatible",
    kind: "custom",
    providerId: "custom-anthropic",
    name: { en: "Custom · Anthropic Messages", "zh-CN": "自定义 · Anthropic Messages" },
    description: {
      en: "Enter the base URL of your own Anthropic Messages-compatible service.",
      "zh-CN": "填写你自己的 Anthropic Messages 兼容服务地址。",
    },
    searchAliases: ["gateway", "anthropic", "messages", "claude", "自定义", "网关", "中转"],
    group: "gateway",
    baseUrl: "",
    api: "anthropic-messages",
    docsUrl: "https://platform.claude.com/docs/en/api/messages",
    modelHint: {
      en: "Use the service's Anthropic API base URL. The client appends /v1/messages; model discovery may be unavailable, so model IDs can be entered manually.",
      "zh-CN":
        "填写服务的 Anthropic API 基础地址，客户端会追加 /v1/messages。服务可能不支持模型检测，可手动填写模型 ID。",
    },
  },
];

export function findProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function filterProviderPresets(query: string): readonly ProviderPreset[] {
  const search = query.trim().toLowerCase();
  if (!search) return PROVIDER_PRESETS;
  return PROVIDER_PRESETS.filter((preset) =>
    [
      preset.id,
      ...Object.values(preset.name),
      ...Object.values(preset.description),
      ...preset.searchAliases,
    ].some((value) => value.toLowerCase().includes(search)),
  );
}
