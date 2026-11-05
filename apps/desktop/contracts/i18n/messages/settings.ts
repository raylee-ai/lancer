import { defineMessages } from "../define";

export const settingsMessages = defineMessages(
  {
    "settings.group.app": "App",
    "settings.group.agent": "Agent",
    "settings.group.customize": "Customize",
    "settings.section.general": "General",
    "settings.section.generalDescription": "App and runtime defaults.",
    "settings.section.appearance": "Appearance",
    "settings.section.appearanceDescription":
      "Choose light, dark or system mode and a color preset.",
    "settings.section.notifications": "Notifications",
    "settings.section.notificationsDescription": "Choose which background events alert you.",
    "settings.section.shortcuts": "Keyboard shortcuts",
    "settings.section.shortcutsDescription": "Shortcuts available across the app.",
    "settings.section.providers": "Providers",
    "settings.section.providersDescription": "Connect providers and manage auth for {workspace}.",
    "settings.section.models": "Models",
    "settings.section.modelsDescription":
      "Choose the default model and which models appear in pickers.",
    "settings.section.customize": "Skills and extensions",

    "settings.view.thisWorkspace": "this workspace",
    "settings.view.selectWorkspace": "Select a workspace",
    "settings.view.selectWorkspaceDescription":
      "Providers and models are set per workspace. Choose one, or open a folder first.",

    "settings.controls.choose": "Choose…",

    "settings.appearance.theme": "Theme",
    "settings.appearance.modeSystem": "System",
    "settings.appearance.modeLight": "Light",
    "settings.appearance.modeDark": "Dark",
    "settings.appearance.colorPreset": "Color preset",
    "settings.appearance.transparency": "Window transparency",
    "settings.appearance.transparencyDescription":
      "Let desktop colors show through supported surfaces.",

    "settings.notifications.system": "System",
    "settings.notifications.systemDescription":
      "macOS decides whether Lancer can show desktop notifications at all.",
    "settings.notifications.access": "macOS notification access",
    "settings.notifications.turnOn": "Turn on notifications",
    "settings.notifications.turnOnAskDescription":
      "Lancer asks macOS when active work first moves into the background. You can also ask now.",
    "settings.notifications.turnOnDeniedDescription":
      "macOS notifications are already turned off for Lancer. Open System Settings to enable them again.",
    "settings.notifications.askMacOs": "Ask macOS",
    "settings.notifications.openSystemSettings": "Open System Settings",
    "settings.notifications.inApp": "In-app alerts",
    "settings.notifications.inAppDescription":
      "Choose which background events should try to notify once macOS access is enabled.",
    "settings.notifications.backgroundCompletion": "Background completion",
    "settings.notifications.backgroundCompletionDescription":
      "Notify when a background session finishes.",
    "settings.notifications.backgroundFailure": "Background failures",
    "settings.notifications.backgroundFailureDescription":
      "Notify when a background session fails.",
    "settings.notifications.attentionNeeded": "Needs input or approval",
    "settings.notifications.attentionNeededDescription": "Notify when input is needed to continue.",
    "settings.notifications.statusGranted": "Enabled",
    "settings.notifications.statusDenied": "Turned off",
    "settings.notifications.statusDefault": "Not enabled yet",
    "settings.notifications.statusUnsupported": "Unavailable",
    "settings.notifications.statusChecking": "Checking…",
    "settings.notifications.statusGrantedDescription":
      "macOS will allow Lancer to show desktop notifications for background thread updates.",
    "settings.notifications.statusDeniedDescription":
      "macOS notifications are turned off for Lancer. Enable them in System Settings to receive background completion alerts.",
    "settings.notifications.statusDefaultDescription":
      "Lancer has not asked macOS for desktop notification access yet.",
    "settings.notifications.statusUnsupportedDescription":
      "Desktop notifications are unavailable on this system.",
    "settings.notifications.statusCheckingDescription":
      "Checking whether macOS notifications are available for Lancer.",

    "settings.shortcuts.groupApp": "App",
    "settings.shortcuts.groupThreads": "Threads",
    "settings.shortcuts.groupComposer": "Composer",
    "settings.shortcuts.groupWorkbench": "Workbench",
    "settings.shortcuts.commandPalette": "Command palette",
    "settings.shortcuts.goToFile": "Go to file",
    "settings.shortcuts.openSettings": "Open settings",
    "settings.shortcuts.toggleSidebar": "Toggle sidebar",
    "settings.shortcuts.toggleSidePanel": "Toggle side panel",
    "settings.shortcuts.newWindow": "New window",
    "settings.shortcuts.newThread": "New thread",
    "settings.shortcuts.switchRecentThread": "Switch to recent thread",
    "settings.shortcuts.cycleThreads": "Cycle through threads",
    "settings.shortcuts.findInThread": "Find in thread",
    "settings.shortcuts.sendMessage": "Send message, or queue it during a run",
    "settings.shortcuts.steer": "Steer the running agent",
    "settings.shortcuts.newLine": "New line",
    "settings.shortcuts.toggleTerminal": "Toggle terminal",
    "settings.shortcuts.newTerminalTab": "New terminal tab",
    "settings.shortcuts.toggleReview": "Toggle review",
    "settings.shortcuts.switchSidePanelTab": "Switch to side panel tab",
    "settings.shortcuts.closeWorkbenchTab": "Close workbench tab",

    "settings.models.defaultModel": "Default model",
    "settings.models.defaultModelDescription": "Used for new threads.",
    "settings.models.reasoning": "Reasoning",
    "settings.models.reasoningDescription": "Default reasoning effort for new threads.",
    "settings.models.defaultUnavailableWarning":
      "Your default model ({model}) is turned off or its provider is not connected. Choose a new default.",
    "settings.models.enabledModels": "Enabled models",
    "settings.models.enabledCount": "{enabled} of {total}",
    "settings.models.search": "Search models",
    "settings.models.enabledOnlyDescription": "Only enabled models appear in model pickers.",
    "settings.models.noConnectedModels":
      "No connected models available yet. Connect a provider to add models.",
    "settings.models.noMatch": "No connected models match “{query}”.",
    "settings.models.enableModel": "Enable {model}",
    "settings.models.notConnected": "Not connected",
    "settings.models.connectProvider": "Connect a provider",
    "settings.models.notConnectedDescription": "Models from providers you have not signed in to.",
    "settings.models.showModels": "Show {count} models",
    "settings.models.badgeDefault": "Default",
    "settings.models.tagReasoning": "Reasoning",
    "settings.models.tagImages": "Images",

    "settings.customEndpoints.title": "Custom endpoints",
    "settings.customEndpoints.description":
      "Add OpenAI Chat Completions, Responses, or Anthropic Messages endpoints. Stored in ~/.pi/agent/models.json.",
    "settings.customEndpoints.empty": "No custom endpoints yet.",
    "settings.customEndpoints.templates": "Provider templates",
    "settings.customEndpoints.templatesDescription":
      "Start with a provider's public URL and protocol, then add your own key and models.",
    "settings.customEndpoints.chooseTemplate": "Choose template",
    "settings.customEndpoints.presetTitle": "Choose a provider template",
    "settings.customEndpoints.presetSearch": "Search templates",
    "settings.customEndpoints.presetEmpty": "No matching templates",
    "settings.customEndpoints.entrySummaryOne": "{baseUrl} · {count} model",
    "settings.customEndpoints.entrySummaryOther": "{baseUrl} · {count} models",
    "settings.customEndpoints.edit": "Edit",
    "settings.customEndpoints.remove": "Remove",
    "settings.customEndpoints.addEndpoint": "Add endpoint",
    "settings.customEndpoints.addEndpointDescription": "Register a local or custom model service.",
    "settings.customEndpoints.bridgeUnavailable": "Desktop bridge is not available.",
    "settings.customEndpoints.baseUrlInvalid": "Base URL must start with http:// or https://",
    "settings.customEndpoints.selectModel": "Select at least one model.",
    "settings.customEndpoints.editTitle": "Edit custom endpoint",
    "settings.customEndpoints.addTitle": "Add custom endpoint",
    "settings.customEndpoints.dialogBody":
      "Configure a model service and its API protocol. The endpoint and API key are stored in plaintext at {path}.",
    "settings.customEndpoints.providerId": "Provider ID",
    "settings.customEndpoints.providerIdHelp":
      "Lowercase letters, digits, and dashes. Cannot be changed later.",
    "settings.customEndpoints.protocol": "API protocol",
    "settings.customEndpoints.keepProtocol": "Keep existing protocol (advanced configuration)",
    "settings.customEndpoints.preserveAdvanced":
      "Advanced provider fields and model-specific protocol overrides are retained.",
    "settings.customEndpoints.anthropicBaseUrlHelp":
      "Use the Anthropic API root. The client appends /v1/messages; do not include that suffix. Model discovery may be unavailable.",
    "settings.customEndpoints.baseUrl": "Base URL",
    "settings.customEndpoints.baseUrlHelp":
      "Use the API base URL, including any version prefix (often {suffix}); do not append /chat/completions or /responses. Ollama: {ollama}. vLLM: {vllm}.",
    "settings.customEndpoints.apiKey": "API key",
    "settings.customEndpoints.apiKeyPlaceholder": "vLLM: pass through; Ollama: leave blank",
    "settings.customEndpoints.apiKeyHelp":
      "Required by the storage format. For vLLM started with {flag}, enter that key. For Ollama or other servers without auth, leave blank and a placeholder is saved.",
    "settings.customEndpoints.models": "Models",
    "settings.customEndpoints.detecting": "Detecting…",
    "settings.customEndpoints.detectModels": "Detect models",
    "settings.customEndpoints.toolCallingHelp":
      "Choose a model with reliable tool calling. Model discovery is optional; enter model IDs manually if the service does not offer a model list.",
    "settings.customEndpoints.cancel": "Cancel",
    "settings.customEndpoints.saveChanges": "Save changes",
    "settings.customEndpoints.checklistEmpty":
      "Click “Detect models” or type a model ID below to add one manually.",
    "settings.customEndpoints.enableModel": "Enable {model}",
    "settings.customEndpoints.addModelManually": "Add model ID manually",
    "settings.customEndpoints.add": "Add",
    "settings.customEndpoints.providerIdRequired": "Provider ID is required.",
    "settings.customEndpoints.providerIdPattern":
      "Use lowercase letters, digits, and dashes (max 64 chars).",
    "settings.customEndpoints.providerIdInUse": 'Provider ID "{id}" is already in use.',

    "settings.onboarding.noModels": "No models available",
    "settings.onboarding.openModelsToEnable": "Open Settings > Models to enable models.",
    "settings.onboarding.openProvidersToConnect":
      "Open Settings > Providers to connect a provider and make models available.",
    "settings.onboarding.allModelsDisabled":
      "All available models are currently disabled. Open Settings > Models to enable models.",
    "settings.onboarding.openModels": "Open Settings > Models",
    "settings.onboarding.connectProviderFirst":
      "Connect a provider in Settings > Providers before choosing a model or setting a default.",
    "settings.onboarding.openProviders": "Open Settings > Providers",
    "settings.onboarding.pickModel": "Pick a model",
    "settings.onboarding.pickModelDescription": "Pick a model.",
    "settings.onboarding.selectedUnavailable": "Selected model unavailable",
    "settings.onboarding.selectedUnavailableUpdateDefault":
      "The model selected for this thread is no longer available. Choose another model, then open Settings > Models to update the default.",
    "settings.onboarding.selectedUnavailableChooseDefault":
      "The model selected for this thread is no longer available. Choose another model, then open Settings > Models to choose the app default.",
    "settings.onboarding.noDefault": "No default model set",
    "settings.onboarding.setDefault": "Set a default model in Settings > Models.",
    "settings.onboarding.defaultUnavailable": "Default model unavailable",
    "settings.onboarding.defaultUnavailableUpdate":
      "Your saved default ({model}) is no longer available. Open Settings > Models to update it.",
    "settings.onboarding.defaultUnavailableChoose":
      "Your saved default ({model}) is no longer available. Choose a model for this thread, then open Settings > Models to update it.",
  },
  {
    "settings.group.app": "应用",
    "settings.group.agent": "智能体",
    "settings.group.customize": "自定义",
    "settings.section.general": "通用",
    "settings.section.generalDescription": "应用与运行时的默认设置。",
    "settings.section.appearance": "外观",
    "settings.section.appearanceDescription": "选择浅色、深色或跟随系统模式，以及配色方案。",
    "settings.section.notifications": "通知",
    "settings.section.notificationsDescription": "选择哪些后台事件需要提醒你。",
    "settings.section.shortcuts": "快捷键",
    "settings.section.shortcutsDescription": "应用内可用的快捷键。",
    "settings.section.providers": "模型与账号",
    "settings.section.providersDescription": "为 {workspace} 连接提供商并管理认证。",
    "settings.section.models": "模型",
    "settings.section.modelsDescription": "选择默认模型，以及哪些模型会出现在选择器中。",
    "settings.section.customize": "技能与扩展",

    "settings.view.thisWorkspace": "当前工作区",
    "settings.view.selectWorkspace": "选择工作区",
    "settings.view.selectWorkspaceDescription":
      "提供商和模型按工作区设置。请选择一个工作区，或先打开一个文件夹。",

    "settings.controls.choose": "请选择…",

    "settings.appearance.theme": "主题",
    "settings.appearance.modeSystem": "跟随系统",
    "settings.appearance.modeLight": "浅色",
    "settings.appearance.modeDark": "深色",
    "settings.appearance.colorPreset": "配色方案",
    "settings.appearance.transparency": "窗口透明",
    "settings.appearance.transparencyDescription": "在支持的界面上透出桌面颜色。",

    "settings.notifications.system": "系统",
    "settings.notifications.systemDescription": "由 macOS 决定 Lancer 是否可以显示桌面通知。",
    "settings.notifications.access": "macOS 通知权限",
    "settings.notifications.turnOn": "开启通知",
    "settings.notifications.turnOnAskDescription":
      "当进行中的任务首次转入后台时，Lancer 会向 macOS 请求权限。你也可以现在就请求。",
    "settings.notifications.turnOnDeniedDescription":
      "Lancer 的 macOS 通知已被关闭。请打开系统设置重新开启。",
    "settings.notifications.askMacOs": "向 macOS 请求",
    "settings.notifications.openSystemSettings": "打开系统设置",
    "settings.notifications.inApp": "应用内提醒",
    "settings.notifications.inAppDescription": "选择在 macOS 授权后，哪些后台事件需要发送通知。",
    "settings.notifications.backgroundCompletion": "后台完成",
    "settings.notifications.backgroundCompletionDescription": "后台会话完成时通知。",
    "settings.notifications.backgroundFailure": "后台失败",
    "settings.notifications.backgroundFailureDescription": "后台会话失败时通知。",
    "settings.notifications.attentionNeeded": "需要输入或批准",
    "settings.notifications.attentionNeededDescription": "需要你输入才能继续时通知。",
    "settings.notifications.statusGranted": "已开启",
    "settings.notifications.statusDenied": "已关闭",
    "settings.notifications.statusDefault": "尚未开启",
    "settings.notifications.statusUnsupported": "不可用",
    "settings.notifications.statusChecking": "正在检查…",
    "settings.notifications.statusGrantedDescription":
      "macOS 将允许 Lancer 为后台会话的更新显示桌面通知。",
    "settings.notifications.statusDeniedDescription":
      "Lancer 的 macOS 通知已关闭。请在系统设置中开启，以接收后台完成提醒。",
    "settings.notifications.statusDefaultDescription": "Lancer 尚未向 macOS 请求桌面通知权限。",
    "settings.notifications.statusUnsupportedDescription": "此系统不支持桌面通知。",
    "settings.notifications.statusCheckingDescription": "正在检查 Lancer 是否可以使用 macOS 通知。",

    "settings.shortcuts.groupApp": "应用",
    "settings.shortcuts.groupThreads": "会话",
    "settings.shortcuts.groupComposer": "输入框",
    "settings.shortcuts.groupWorkbench": "工作台",
    "settings.shortcuts.commandPalette": "命令面板",
    "settings.shortcuts.goToFile": "转到文件",
    "settings.shortcuts.openSettings": "打开设置",
    "settings.shortcuts.toggleSidebar": "显示/隐藏侧边栏",
    "settings.shortcuts.toggleSidePanel": "显示/隐藏侧边面板",
    "settings.shortcuts.newWindow": "新建窗口",
    "settings.shortcuts.newThread": "新建会话",
    "settings.shortcuts.switchRecentThread": "切换到最近的会话",
    "settings.shortcuts.cycleThreads": "循环切换会话",
    "settings.shortcuts.findInThread": "在会话中查找",
    "settings.shortcuts.sendMessage": "发送消息（运行中则加入队列）",
    "settings.shortcuts.steer": "引导正在运行的智能体",
    "settings.shortcuts.newLine": "换行",
    "settings.shortcuts.toggleTerminal": "显示/隐藏终端",
    "settings.shortcuts.newTerminalTab": "新建终端标签页",
    "settings.shortcuts.toggleReview": "显示/隐藏审阅",
    "settings.shortcuts.switchSidePanelTab": "切换侧边面板标签页",
    "settings.shortcuts.closeWorkbenchTab": "关闭工作台标签页",

    "settings.models.defaultModel": "默认模型",
    "settings.models.defaultModelDescription": "用于新会话。",
    "settings.models.reasoning": "推理",
    "settings.models.reasoningDescription": "新会话的默认推理强度。",
    "settings.models.defaultUnavailableWarning":
      "你的默认模型（{model}）已关闭，或其提供商未连接。请选择新的默认模型。",
    "settings.models.enabledModels": "已启用的模型",
    "settings.models.enabledCount": "{enabled} / {total}",
    "settings.models.search": "搜索模型",
    "settings.models.enabledOnlyDescription": "只有已启用的模型才会出现在模型选择器中。",
    "settings.models.noConnectedModels": "暂无已连接的模型。连接提供商即可添加模型。",
    "settings.models.noMatch": "没有与“{query}”匹配的已连接模型。",
    "settings.models.enableModel": "启用 {model}",
    "settings.models.notConnected": "未连接",
    "settings.models.connectProvider": "连接提供商",
    "settings.models.notConnectedDescription": "来自尚未登录的提供商的模型。",
    "settings.models.showModels": "显示 {count} 个模型",
    "settings.models.badgeDefault": "默认",
    "settings.models.tagReasoning": "推理",
    "settings.models.tagImages": "图像",

    "settings.customEndpoints.title": "自定义端点",
    "settings.customEndpoints.description":
      "添加 OpenAI Chat Completions、Responses 或 Anthropic Messages 端点。保存在 ~/.pi/agent/models.json 中。",
    "settings.customEndpoints.empty": "暂无自定义端点。",
    "settings.customEndpoints.templates": "供应商模板",
    "settings.customEndpoints.templatesDescription":
      "预填供应商的公开地址和协议，再添加自己的密钥和模型。",
    "settings.customEndpoints.chooseTemplate": "选择模板",
    "settings.customEndpoints.presetTitle": "选择供应商模板",
    "settings.customEndpoints.presetSearch": "搜索模板",
    "settings.customEndpoints.presetEmpty": "没有匹配的模板",
    "settings.customEndpoints.entrySummaryOne": "{baseUrl} · {count} 个模型",
    "settings.customEndpoints.entrySummaryOther": "{baseUrl} · {count} 个模型",
    "settings.customEndpoints.edit": "编辑",
    "settings.customEndpoints.remove": "移除",
    "settings.customEndpoints.addEndpoint": "添加端点",
    "settings.customEndpoints.addEndpointDescription": "连接本地或自定义的模型服务。",
    "settings.customEndpoints.bridgeUnavailable": "桌面桥接不可用。",
    "settings.customEndpoints.baseUrlInvalid": "Base URL 必须以 http:// 或 https:// 开头",
    "settings.customEndpoints.selectModel": "请至少选择一个模型。",
    "settings.customEndpoints.editTitle": "编辑自定义端点",
    "settings.customEndpoints.addTitle": "添加自定义端点",
    "settings.customEndpoints.dialogBody":
      "配置模型服务并选择 API 协议。端点和 API 密钥将以明文形式保存在 {path} 中。",
    "settings.customEndpoints.providerId": "提供商 ID",
    "settings.customEndpoints.providerIdHelp": "仅限小写字母、数字和短横线。创建后无法更改。",
    "settings.customEndpoints.protocol": "API 协议",
    "settings.customEndpoints.keepProtocol": "保留现有协议（高级配置）",
    "settings.customEndpoints.preserveAdvanced": "保留提供商高级字段及每个模型单独设置的协议。",
    "settings.customEndpoints.anthropicBaseUrlHelp":
      "填写 Anthropic API 根地址，客户端会追加 /v1/messages，请勿包含该后缀。服务可能不支持模型检测。",
    "settings.customEndpoints.baseUrl": "Base URL",
    "settings.customEndpoints.baseUrlHelp":
      "填写 API 基础地址，保留版本前缀（通常为 {suffix}），不要追加 /chat/completions 或 /responses。Ollama：{ollama}。vLLM：{vllm}。",
    "settings.customEndpoints.apiKey": "API 密钥",
    "settings.customEndpoints.apiKeyPlaceholder": "vLLM：填写其密钥；Ollama：留空",
    "settings.customEndpoints.apiKeyHelp":
      "存储格式要求填写此项。对于使用 {flag} 启动的 vLLM，请填写该密钥。对于 Ollama 或其他无需认证的服务器，请留空，系统会保存一个占位值。",
    "settings.customEndpoints.models": "模型",
    "settings.customEndpoints.detecting": "正在检测…",
    "settings.customEndpoints.detectModels": "检测模型",
    "settings.customEndpoints.toolCallingHelp":
      "请选择支持稳定工具调用的模型。模型检测是可选步骤；服务不提供模型列表时，可手动填写模型 ID。",
    "settings.customEndpoints.cancel": "取消",
    "settings.customEndpoints.saveChanges": "保存更改",
    "settings.customEndpoints.checklistEmpty": "点击“检测模型”，或在下方输入模型 ID 手动添加。",
    "settings.customEndpoints.enableModel": "启用 {model}",
    "settings.customEndpoints.addModelManually": "手动添加模型 ID",
    "settings.customEndpoints.add": "添加",
    "settings.customEndpoints.providerIdRequired": "请填写提供商 ID。",
    "settings.customEndpoints.providerIdPattern":
      "请使用小写字母、数字和短横线（最多 64 个字符）。",
    "settings.customEndpoints.providerIdInUse": "提供商 ID “{id}” 已被使用。",

    "settings.onboarding.noModels": "暂无可用模型",
    "settings.onboarding.openModelsToEnable": "打开“设置 > 模型”以启用模型。",
    "settings.onboarding.openProvidersToConnect":
      "打开“设置 > 模型与账号”连接提供商，即可使用模型。",
    "settings.onboarding.allModelsDisabled":
      "所有可用模型当前均已停用。打开“设置 > 模型”以启用模型。",
    "settings.onboarding.openModels": "打开设置 > 模型",
    "settings.onboarding.connectProviderFirst":
      "请先在“设置 > 模型与账号”中连接提供商，再选择模型或设置默认模型。",
    "settings.onboarding.openProviders": "打开设置 > 模型与账号",
    "settings.onboarding.pickModel": "选择模型",
    "settings.onboarding.pickModelDescription": "请选择一个模型。",
    "settings.onboarding.selectedUnavailable": "所选模型不可用",
    "settings.onboarding.selectedUnavailableUpdateDefault":
      "此会话所选的模型已不可用。请选择其他模型，然后打开“设置 > 模型”更新默认模型。",
    "settings.onboarding.selectedUnavailableChooseDefault":
      "此会话所选的模型已不可用。请选择其他模型，然后打开“设置 > 模型”选择应用的默认模型。",
    "settings.onboarding.noDefault": "未设置默认模型",
    "settings.onboarding.setDefault": "请在“设置 > 模型”中设置默认模型。",
    "settings.onboarding.defaultUnavailable": "默认模型不可用",
    "settings.onboarding.defaultUnavailableUpdate":
      "你保存的默认模型（{model}）已不可用。打开“设置 > 模型”进行更新。",
    "settings.onboarding.defaultUnavailableChoose":
      "你保存的默认模型（{model}）已不可用。请为此会话选择一个模型，然后打开“设置 > 模型”进行更新。",
  },
);
