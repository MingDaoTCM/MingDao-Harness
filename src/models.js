// 模型与服务商预设目录（MingDao 内置）。
// 所有字段都可以通过 ~/.mingdao/config.json 或环境变量覆盖，
// 也可以在 <mingdao-home>/providers/<name>.mjs 中注册完全自定义的 Provider 模块。

export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek 官方 API',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    note: 'DeepSeek-V4 正式版（2026-08-17 起商用）：384K 上下文，峰谷定价（高峰 9:00–14:00 为闲时 2 倍），支持工具调用 / Responses API / Anthropic 兼容接口。',
  },
  openai: {
    label: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    models: ['gpt-4o', 'gpt-4o-mini'],
  },
  qwen: {
    label: '阿里云百炼（通义千问）',
    kind: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envKey: 'DASHSCOPE_API_KEY',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
  },
  glm: {
    label: '智谱 GLM',
    kind: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    envKey: 'ZHIPUAI_API_KEY',
    models: ['glm-4-plus', 'glm-4-flash', 'glm-4-air'],
  },
  moonshot: {
    label: '月之暗面 Kimi',
    kind: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    envKey: 'MOONSHOT_API_KEY',
    models: ['moonshot-v1-128k', 'moonshot-v1-32k'],
  },
  custom: {
    label: '自定义 OpenAI 兼容端点（任意模型网关/本地部署）',
    kind: 'openai-compatible',
    baseUrl: 'https://your-gateway.example.com/v1',
    envKey: 'MINGDAO_API_KEY',
    models: [],
  },
};

export const MODELS = {
  // —— DeepSeek-V4 系列（MingDao 首发优化目标）——
  'deepseek-v4-pro': {
    label: '旗舰推理 · 复杂架构、排障、规划',
    provider: 'deepseek',
    contextWindow: 384000, // 正式版规格：384K 上下文（2026-08-17 起商用）
    budgetTokens: 200000, // 默认注入预算（省钱省时，可调高）
    maxOutputTokens: 32768,
    temperature: 0.4,
    supportsReasoning: true,
    // 峰谷定价（元/百万 tokens，缓存未命中口径；高峰 9:00–14:00 为闲时 2 倍）
    pricing: {
      offpeak: { input: 4.5, output: 13.5 },
      peak: { input: 9, output: 27 },
    },
  },
  'deepseek-v4-flash': {
    label: '极速响应 · 日常问答与轻量任务',
    provider: 'deepseek',
    contextWindow: 384000, // 正式版规格：384K 上下文
    budgetTokens: 128000,
    maxOutputTokens: 8192,
    temperature: 0.6,
    supportsReasoning: false,
    pricing: {
      offpeak: { input: 1.5, output: 4.5 },
      peak: { input: 3, output: 9 },
    },
  },
  'deepseek-chat': {
    label: 'DeepSeek-V3 通用对话',
    provider: 'deepseek',
    contextWindow: 131072,
    budgetTokens: 96000,
    maxOutputTokens: 8192,
    temperature: 0.7,
    supportsReasoning: false,
  },
  'deepseek-reasoner': {
    label: 'DeepSeek-R1 深度推理',
    provider: 'deepseek',
    contextWindow: 131072,
    budgetTokens: 64000,
    maxOutputTokens: 32768,
    temperature: 0.7,
    supportsReasoning: true,
  },
  // —— 其他主流模型（OpenAI 兼容接入）——
  'gpt-4o': {
    label: 'OpenAI 旗舰',
    provider: 'openai',
    contextWindow: 131072,
    budgetTokens: 96000,
    maxOutputTokens: 16384,
    temperature: 0.6,
    supportsReasoning: false,
  },
  'gpt-4o-mini': {
    label: 'OpenAI 轻量',
    provider: 'openai',
    contextWindow: 131072,
    budgetTokens: 96000,
    maxOutputTokens: 16384,
    temperature: 0.7,
    supportsReasoning: false,
  },
  'qwen-max': {
    label: '通义千问旗舰',
    provider: 'qwen',
    contextWindow: 131072,
    budgetTokens: 96000,
    maxOutputTokens: 8192,
    temperature: 0.6,
    supportsReasoning: false,
  },
  'qwen-plus': {
    label: '通义千问增强',
    provider: 'qwen',
    contextWindow: 131072,
    budgetTokens: 96000,
    maxOutputTokens: 8192,
    temperature: 0.6,
    supportsReasoning: false,
  },
  'glm-4-plus': {
    label: '智谱旗舰',
    provider: 'glm',
    contextWindow: 131072,
    budgetTokens: 96000,
    maxOutputTokens: 8192,
    temperature: 0.6,
    supportsReasoning: false,
  },
  'glm-4-flash': {
    label: '智谱免费轻量',
    provider: 'glm',
    contextWindow: 131072,
    budgetTokens: 96000,
    maxOutputTokens: 4096,
    temperature: 0.7,
    supportsReasoning: false,
  },
  'moonshot-v1-128k': {
    label: 'Kimi 长文本',
    provider: 'moonshot',
    contextWindow: 131072,
    budgetTokens: 96000,
    maxOutputTokens: 8192,
    temperature: 0.7,
    supportsReasoning: false,
  },
};

export function modelPreset(name) {
  return MODELS[name] || null;
}

export function providerPreset(name) {
  return PROVIDERS[name] || null;
}
