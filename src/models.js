// 模型与服务商预设目录（MingDao 内置）。
// 所有字段都可以通过 ~/.mingdao/config.json 或环境变量覆盖，
// 也可以在 <mingdao-home>/providers/<name>.mjs 中注册完全自定义的 Provider 模块。

export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek 官方 API',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'],
    note: 'DeepSeek-V4 正式版（2026-08-17 起商用）：1M 上下文（单次最大输出 384K），峰谷定价（高峰＝北京工作日 9:00–12:00、14:00–18:00，闲时价＝高峰一半），支持工具调用 / Responses API / Anthropic 兼容接口。',
  },
  openai: {
    label: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano'],
  },
  qwen: {
    label: '阿里云百炼（通义千问）',
    kind: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envKey: 'DASHSCOPE_API_KEY',
    models: ['qwen3.7-max', 'qwen-plus'],
  },
  glm: {
    label: '智谱 GLM',
    kind: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    envKey: 'ZHIPUAI_API_KEY',
    models: ['glm-5', 'glm-4.5-air'],
  },
  moonshot: {
    label: '月之暗面 Kimi',
    kind: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    envKey: 'MOONSHOT_API_KEY',
    models: ['kimi-latest', 'kimi-k2'],
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
    contextWindow: 1000000, // 官方上下文 1M（审计 Kimi P1-C：384K 实为单次最大输出，字段语义修正）
    maxOutputCeiling: 384000, // 单次最大输出上限（官方规格）
    budgetTokens: 200000, // 默认注入预算（省钱省时，可调高）
    maxOutputTokens: 65536, // 生成类任务少续写、少重复计费（Kimi P1-C）
    temperature: 0.4,
    supportsReasoning: true,
    // 思考强度三档（官方 thinking_mode：low/high/max）——输出按 completion 计费（输入 3 倍价），
    // 简单任务用 low 可砍掉大部分推理 token；辅助调用（标题/记忆/分类器）固定 low
    reasoningEffort: { default: 'high', options: ['low', 'high', 'max'] },
    // 峰谷定价（元/百万 tokens；input=缓存未命中，cacheHit=缓存命中约为未命中的 1/30）
    pricing: {
      offpeak: { input: 4.5, output: 13.5, cacheHit: 0.15 },
      peak: { input: 9, output: 27, cacheHit: 0.3 },
    },
  },
  'deepseek-v4-flash': {
    label: '极速响应 · 日常问答与轻量任务',
    provider: 'deepseek',
    contextWindow: 1000000, // 官方上下文 1M
    maxOutputCeiling: 384000,
    budgetTokens: 128000,
    maxOutputTokens: 8192,
    temperature: 0.6,
    supportsReasoning: false,
    pricing: {
      offpeak: { input: 1.5, output: 4.5, cacheHit: 0.05 },
      peak: { input: 3, output: 9, cacheHit: 0.1 },
    },
  },
  // 多模态视觉模型（2026-08-21 上线，实验版）：文本 + 图片输入（JPEG/PNG/GIF/WebP），
  // 图片转 token 计费（≤384 tokens/张），价格与 V4-Flash 完全一致。
  'deepseek-v4-flash-vision-exp': {
    label: '多模态视觉 · 图片描述/截图识别/图表分析（实验版）',
    provider: 'deepseek',
    contextWindow: 1000000,
    maxOutputCeiling: 384000,
    budgetTokens: 128000,
    maxOutputTokens: 8192,
    temperature: 0.6,
    supportsReasoning: false,
    supportsVision: true,
    pricing: {
      offpeak: { input: 1.5, output: 4.5, cacheHit: 0.05 },
      peak: { input: 3, output: 9, cacheHit: 0.1 },
    },
  },
  // —— 其他主流模型（OpenAI 兼容接入，按 2026-08 官方当前型号）——
  'gpt-5': {
    label: 'OpenAI 旗舰（官方别名，随最新版本）',
    provider: 'openai',
    contextWindow: 400000,
    budgetTokens: 128000,
    maxOutputTokens: 16384,
    temperature: 0.6,
    supportsReasoning: false,
  },
  'gpt-5-mini': {
    label: 'OpenAI 性价比',
    provider: 'openai',
    contextWindow: 272000,
    budgetTokens: 128000,
    maxOutputTokens: 16384,
    temperature: 0.7,
    supportsReasoning: false,
  },
  'gpt-5-nano': {
    label: 'OpenAI 最便宜',
    provider: 'openai',
    contextWindow: 272000,
    budgetTokens: 96000,
    maxOutputTokens: 16384,
    temperature: 0.7,
    supportsReasoning: false,
  },
  'qwen3.7-max': {
    label: '通义千问旗舰',
    provider: 'qwen',
    contextWindow: 262144,
    budgetTokens: 128000,
    maxOutputTokens: 8192,
    temperature: 0.6,
    supportsReasoning: false,
  },
  'qwen-plus': {
    label: '通义千问通用（官方别名，随最新版本）',
    provider: 'qwen',
    contextWindow: 131072,
    budgetTokens: 96000,
    maxOutputTokens: 8192,
    temperature: 0.6,
    supportsReasoning: false,
  },
  'glm-5': {
    label: '智谱旗舰',
    provider: 'glm',
    contextWindow: 200000,
    budgetTokens: 128000,
    maxOutputTokens: 8192,
    temperature: 0.6,
    supportsReasoning: false,
  },
  'glm-4.5-air': {
    label: '智谱免费轻量',
    provider: 'glm',
    contextWindow: 131072,
    budgetTokens: 96000,
    maxOutputTokens: 4096,
    temperature: 0.7,
    supportsReasoning: false,
  },
  'kimi-latest': {
    label: 'Kimi 最新（官方别名，随最新版本）',
    provider: 'moonshot',
    contextWindow: 262144,
    budgetTokens: 128000,
    maxOutputTokens: 8192,
    temperature: 0.7,
    supportsReasoning: false,
  },
  'kimi-k2': {
    label: 'Kimi K2 长文本',
    provider: 'moonshot',
    contextWindow: 262144,
    budgetTokens: 128000,
    maxOutputTokens: 8192,
    temperature: 0.7,
    supportsReasoning: false,
  },
};

export function modelPreset(/** @type {any} */ name) {
  return /** @type {any} */ (MODELS)[name] || null;
}

export function providerPreset(/** @type {any} */ name) {
  return /** @type {any} */ (PROVIDERS)[name] || null;
}
