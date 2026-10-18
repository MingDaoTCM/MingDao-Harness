// 模型与服务商预设目录（MingDao 内置）。
// 所有字段都可以通过 ~/.mingdao/config.json 或环境变量覆盖，
// 也可以在 <mingdao-home>/providers/<name>.mjs 中注册完全自定义的 Provider 模块。
//
// v0.6.19（§3.67）：**模型名称以 API 实时返回的官方名为唯一事实来源**。
//
// 背景：此前 MODELS 表把 `deepseek-v4-pro` / `deepseek-flash` / `deepseek-v4-flash` /
// `deepseek-v4-flash-vision-exp` 写死成键，默认值也写成这些字面量。厂家每次改名/升版本
// （`deepseek-v4-flash` → `deepseek-flash` → `DeepSeek-V4.1-Flash 1017` …）都要回来改代码，
// 否则新装用户会被给一个 API 已经不提供的名字，或者界面能拉到、一点就报「未知模型」。
//
// 现在的分工：
//   1. **家族模式表**（MODEL_FAMILIES）：能力/定价/是否视觉挂在正则模式上（pro / flash / vision），
//      官方升版本、改大小写、把版本号写进名字（`DeepSeek-V4.1-Flash 1017`）都自动命中；
//   2. **精确 id 只作为已知别名**（MODELS_KNOWN 里的兼容条目）：老配置/旧会话里的名字仍然可用；
//   3. **默认值运行时解析**（由 model-discovery.resolveDefaultModel 完成）：优先 config.routing.*，
//      否则从当前 API 列表按家族挑官方名；解析不到才退回家族代表名并提示「兜底」。
//      这里导出的 DEFAULT_* 只是**家族代表名/兼容兜底**，不是「当前官方版本」。

// ---------- 家族模式表（能力与定价的唯一来源） ----------
// match 必须兼容官方可能出现的写法：大小写、空格/下划线/连字符、版本号（v4 / v4.1 / V5）。
// vision 必须排在 flash 前面：`...-flash-vision-...` 同时命中 flash 的词根。
/**
 * @typedef {{ id: string, match: RegExp, representative: string, label: string,
 *   verifiedThrough: string, caps: any }} ModelFamily
 */

/** @type {ModelFamily[]} */
export const MODEL_FAMILIES = [
  {
    id: 'vision',
    // `deepseek-v4-flash-vision-exp` / `DeepSeek-V4.1-Flash-Vision 1017` / 未来的 V5 视觉版
    match: /^deepseek(?:[\s_-]*v?\d+(?:[.\s_-]*\d+)?)?[\s_-]*flash[\s_-]*vision/i,
    representative: 'deepseek-v4-flash-vision-exp',
    label: '多模态视觉 · 图片描述/截图识别/图表分析',
    // 已核对过规格的版本上限；更新的版本仍可选用，但会标「能力未知（新版本）」
    verifiedThrough: '4.1',
    caps: {
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
  },
  {
    id: 'pro',
    // `deepseek-v4-pro` / `DeepSeek-V4.1-Pro 1017` / 未来的 V5-Pro
    match: /^deepseek(?:[\s_-]*v?\d+(?:[.\s_-]*\d+)?)?[\s_-]*pro(?:[\s_-]|$)/i,
    representative: 'deepseek-v4-pro',
    label: '旗舰推理 · 复杂架构、排障、规划',
    verifiedThrough: '4.1',
    caps: {
      contextWindow: 1000000, // 官方上下文 1M（384K 实为单次最大输出，字段语义见 maxOutputCeiling）
      maxOutputCeiling: 384000,
      budgetTokens: 200000,
      maxOutputTokens: 65536,
      temperature: 0.4,
      supportsReasoning: true,
      // 思考强度三档（官方 thinking_mode：low/high/max）——输出按 completion 计费。
      reasoningEffort: { default: 'high', options: ['low', 'high', 'max'] },
      pricing: {
        offpeak: { input: 4.5, output: 13.5, cacheHit: 0.15 },
        peak: { input: 9, output: 27, cacheHit: 0.3 },
      },
    },
  },
  {
    id: 'flash',
    // `deepseek-flash` / `deepseek-v4-flash` / `DeepSeek-V4.1-Flash 1017` / 未来的 V5-Flash
    match: /^deepseek(?:[\s_-]*v?\d+(?:[.\s_-]*\d+)?)?[\s_-]*flash(?:[\s_-]|$)/i,
    representative: 'deepseek-flash',
    label: '极速响应 · 日常问答与轻量任务',
    verifiedThrough: '4.1',
    caps: {
      contextWindow: 1000000,
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
  },
];

/** @type {Record<string, ModelFamily>} */
const FAMILY_BY_ID = {};
for (const fam of MODEL_FAMILIES) FAMILY_BY_ID[fam.id] = fam;

/** 解析名字里的 DeepSeek 版本号：`DeepSeek-V4.1-Flash 1017` → [4,1]；`deepseek-flash` → null。 */
function parseModelVersion(/** @type {any} */ name) {
  const m = /^deepseek[\s_-]*v?(\d+)(?:\.(\d+))?/i.exec(String(name || '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0)];
}

function versionAtMost(/** @type {number[]} */ v, /** @type {string} */ cap) {
  const [cmaj, cmin] = String(cap).split('.').map(Number);
  return v[0] < cmaj || (v[0] === cmaj && v[1] <= (cmin || 0));
}

/**
 * 按家族模式匹配模型名（大小写/空格/连字符/版本号无关）。
 * @param {any} name
 * @returns {ModelFamily|null}
 */
export function matchModelFamily(/** @type {any} */ name) {
  const n = String(name || '').trim();
  if (!n) return null;
  for (const fam of MODEL_FAMILIES) {
    if (fam.match.test(n)) return fam;
  }
  return null;
}

/**
 * 家族代表名（**兜底**用，不声称是最新官方版本）。官方名的唯一来源是 API 列表。
 * @param {any} familyId
 */
export function familyRepresentative(/** @type {any} */ familyId) {
  const fam = FAMILY_BY_ID[String(familyId || '')];
  return fam ? fam.representative : '';
}

/**
 * 从 API 返回的名单里按家族挑一个默认模型：优先版本号最高的官方名。
 * 视觉变体不会被当成 flash 执行模型（vision 家族单独匹配）。
 * @param {any} names
 * @param {any} familyId
 * @returns {string|null}
 */
export function pickFamilyModel(/** @type {any} */ names, /** @type {any} */ familyId) {
  const id = String(familyId || '');
  let best = null;
  let bestScore = -1;
  for (const raw of Array.isArray(names) ? names : []) {
    const n = String(raw || '').trim();
    if (!n) continue;
    const fam = matchModelFamily(n);
    if (!fam || fam.id !== id) continue;
    const v = parseModelVersion(n);
    const score = v ? v[0] * 1000 + v[1] : 0; // 无版本号的名字排在有版本的后面
    if (score > bestScore) {
      best = n;
      bestScore = score;
    }
  }
  return best;
}

/** 由家族模式 + 具体名字生成能力预设（同一家族共享上下文/定价/视觉能力）。 */
function familyPreset(/** @type {any} */ name, /** @type {ModelFamily} */ fam) {
  const n = String(name || '');
  const v = parseModelVersion(n);
  const unknown = Boolean(v && !versionAtMost(v, fam.verifiedThrough));
  return {
    ...fam.caps,
    label: unknown ? `${fam.label}（能力未知（新版本），仍可选用；按 ${fam.id} 家族规格保守估算）` : fam.label,
    provider: 'deepseek',
    family: fam.id,
    pattern: true, // 来自家族模式，而不是精确内置条目
    capabilityUnknown: unknown,
  };
}

export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek 官方 API',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    // 离线兜底名单：家族代表名（**不是**当前官方版本）。在线时以 GET /v1/models 为准。
    models: [familyRepresentative('flash'), familyRepresentative('pro')],
    note: '模型名称与版本以 GET /v1/models 实时返回的官方名为准；仓库只维护 pro / flash / vision 家族的能力与定价模式，官方改名或升版本无需改代码。',
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
  // —— v0.6.0 C4：信创 / 国产推理栈与内网部署预设 ——
  // 这些栈绝大多数提供 OpenAI 兼容层（vLLM 系、Ollama、OneAPI/NewAPI 聚合网关、
  // 以及昇腾 MindIE / 海光 DCU / 寒武纪等以 vLLM 为后端的国产加速栈）。
  // baseUrl 指向本机/内网，`isLocalBaseUrl` 会自动套用本地模型的分层超时。
  // **这些预设不需要 API Key**（内网端点通常不校验；CLI 已对本地端点免除「必须有 Key」的硬校验）。
  vllm: {
    label: 'vLLM（自建 / 国产加速栈，OpenAI 兼容）',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8000/v1',
    envKey: 'VLLM_API_KEY',
    models: [],
    note: '昇腾 MindIE、海光 DCU、寒武纪等以 vLLM 为后端的国产推理栈同样走这个预设——只要它暴露 OpenAI 兼容端点。默认不需 Key；如网关要求，用 mingdao key set vllm 存入。',
  },
  ollama: {
    label: 'Ollama（本机模型，OpenAI 兼容）',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    envKey: 'OLLAMA_API_KEY',
    models: [],
    note: '默认不需 Key。模型名用 ollama 里的名字（如 qwen3:32b）。',
  },
  oneapi: {
    label: 'OneAPI / NewAPI 聚合网关（内网统一入口）',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:3000/v1',
    envKey: 'ONEAPI_API_KEY',
    models: [],
    note: '内网常见做法：一个网关聚合多家上游（含国产模型），客户端只认这一处。Key 由网关注册后发放。',
  },
  custom: {
    label: '自定义 OpenAI 兼容端点（任意模型网关/本地部署）',
    kind: 'openai-compatible',
    baseUrl: 'https://your-gateway.example.com/v1',
    envKey: 'MINGDAO_API_KEY',
    models: [],
  },
};

// ---------- 已知精确 id（兼容别名表） ----------
// 这些条目只为「老配置 / 历史会话 / 离线兜底」保留；能力仍来自上面的家族模式。
// 注意：doc-lint 用 `  '<id>': {` 扫描本文件来校验 README 里提到的模型 id，故保留字面键。
const MODELS_KNOWN = {
  'deepseek-v4-pro': {
    ...familyPreset('deepseek-v4-pro', FAMILY_BY_ID.pro),
  },
  'deepseek-flash': {
    ...familyPreset('deepseek-flash', FAMILY_BY_ID.flash),
  },
  // 旧名保留：厂家改名后老配置里仍是这个字符串，删掉会让它们直接 404。
  // 标签里的「旧名」是给用户看的兼容说明（不写死具体版本号——官方名称以 API 为准）。
  'deepseek-v4-flash': {
    ...familyPreset('deepseek-v4-flash', FAMILY_BY_ID.flash),
    label: '极速响应 · 日常问答与轻量任务（旧名别名；官方名称以 API 为准）',
  },
  'deepseek-v4-flash-vision-exp': {
    ...familyPreset('deepseek-v4-flash-vision-exp', FAMILY_BY_ID.vision),
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

/**
 * 模型表：精确条目之外，**任何家族模式命中的名字**（如 API 刚返回的
 * `DeepSeek-V4.1-Flash 1017`）也按家族能力解析——不必等内核发版。
 * 用 Proxy 而不是在启动时枚举，是因为官方名只存在于 API 返回值里，无法预先写进源码。
 * @type {Record<string, any>}
 */
export const MODELS = /** @type {Record<string, any>} */ (
  new Proxy(MODELS_KNOWN, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop);
      if (Object.prototype.hasOwnProperty.call(target, prop)) return /** @type {any} */ (target)[prop];
      const fam = matchModelFamily(prop);
      return fam ? familyPreset(prop, fam) : undefined;
    },
    has(target, prop) {
      if (typeof prop === 'string' && matchModelFamily(prop)) return true;
      return Reflect.has(target, prop);
    },
    getOwnPropertyDescriptor(target, prop) {
      const own = Reflect.getOwnPropertyDescriptor(target, prop);
      if (own) return own;
      if (typeof prop === 'string') {
        const fam = matchModelFamily(prop);
        if (fam) return { configurable: true, enumerable: false, writable: false, value: familyPreset(prop, fam) };
      }
      return undefined;
    },
  })
);

// ---------- 默认值：家族代表名（兼容兜底），运行时再解析官方名 ----------
// 导出这些常量的原因：routing / agent / CLI / worker 等既有调用点仍需要一个同步兜底值；
// **新建配置 / WebUI 默认值 / 向导** 走 model-discovery.resolveDefaultModel（API 优先）。
// 它们的值由家族模式派生（见下），不在这里维护「当前版本号」。
export const DEFAULT_MODEL = familyRepresentative('flash');
export const DEFAULT_PLANNER_MODEL = familyRepresentative('pro');
export const DEFAULT_EXECUTOR_MODEL = DEFAULT_MODEL;

// 旧名 → 兼容名的别名表（doc-lint 用它识别 README 里的旧名；厂家再改名时只需追加一行）。
/** @type {Record<string, string>} */
const MODEL_ALIASES = { 'deepseek-v4-flash': 'deepseek-flash' };

/**
 * 归一化模型名：把同一家族的不同版本/旧名归一到**家族代表名**。
 *
 * 为什么必须有：路由判断「当前模型是否在池内」用字符串比较。API 现在返回的是
 * `DeepSeek-V4.1-Flash 1017`，而老配置/路由默认可能写 `deepseek-flash` 或
 * `deepseek-v4-flash`——不归一就会把老用户判成「池外模型（用户手动指定）」，
 * 自动路由从此静默失效。
 *
 * 只用于「是不是同一个模型」的比较；真正发给 API 的模型名仍用配置原值。
 * @param {any} name
 */
export function canonicalModel(/** @type {any} */ name) {
  const n = String(name || '');
  if (!n) return n;
  if (MODEL_ALIASES[n]) return MODEL_ALIASES[n];
  const fam = matchModelFamily(n);
  if (!fam) return n;
  if (fam.id === 'flash') return DEFAULT_MODEL;
  if (fam.id === 'pro') return DEFAULT_PLANNER_MODEL;
  return familyRepresentative(fam.id);
}

export function modelPreset(/** @type {any} */ name) {
  const n = String(name || '').trim();
  if (!n) return null;
  return /** @type {any} */ (MODELS)[n] || null;
}

// ---------- 模型显示别名（v0.6.20 §3.69）：只影响界面，绝不参与出网请求 ----------
//
// 为什么要有：厂家的「官方宣传名 / 构建名」与 API 实际 id 可能不是一回事。实测（2026-10）：
//   GET  https://api.deepseek.com/v1/models  → ["deepseek-flash", "deepseek-v4-pro"]
//   POST chat {model:"deepseek-flash"}       → 200
//   POST chat {model:"DeepSeek-V4.1-Flash 1017"} → 400
//     {"message":"The supported API model names are deepseek-flash, deepseek-v4-pro,
//                 but you passed DeepSeek-V4.1-Flash 1017."}
// 也就是说宣传名**既不会出现在 /models 里，也不能用于请求**。想让它显示在界面上，只能用
// 「显示别名」：`config.modelLabels = { "<API id>": "<显示名>" }`，出网 model 字段一律仍是 id。
//
// 约束：非法项**忽略并 warn**，绝不抛错/阻断启动（配置写坏一个字不应让整个应用起不来）。
/** 显示名长度上限（字符）：够放「DeepSeek-V4.1-Flash 1017（官方宣传名）」，又不撑破下拉。 */
export const MODEL_LABEL_MAX_LENGTH = 80;

/** 已经告警过的非法项（同一进程只提醒一次，避免每次 loadConfig 都刷屏）。 */
const warnedModelLabels = new Set();

/** @param {string} detail */
function warnModelLabel(detail) {
  if (warnedModelLabels.has(detail)) return;
  warnedModelLabels.add(detail);
  console.warn(
    `[MingDao] ⚠ config.modelLabels 已忽略非法项：${detail}（显示别名只影响界面，不影响请求；非法项不会阻断启动）`
  );
}

/**
 * 校验并归一化 `config.modelLabels`。
 *
 * 规则：
 *  - key（API 实际 id）必须是非空字符串（去空白后）；
 *  - value（显示名）必须是字符串、去空白后非空、长度 ≤ maxLength；
 *  - 非法项**忽略并 warn**（同一项只提醒一次），不抛错、不阻断启动。
 *
 * 注意：这里只做「显示名」的清洗，**绝不**把结果写回 `config.model` /
 * `config.routing.*`，也绝不被拼进请求体的 `model` 字段。
 *
 * @param {any} raw 用户配置里的原始值（任意类型都安全）
 * @param {{maxLength?: number, warn?: boolean}} [opts]
 * @returns {Record<string, string>} 干净的 `{ "<API id>": "<显示名>" }`
 */
export function normalizeModelLabels(raw, { maxLength = MODEL_LABEL_MAX_LENGTH, warn = true } = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  if (raw == null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    if (warn) warnModelLabel('modelLabels 必须是对象（形如 { "deepseek-flash": "显示名" }）');
    return out;
  }
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = String(rawKey).trim();
    if (!key) {
      if (warn) warnModelLabel(`键为空（原值 ${JSON.stringify(rawKey)}）`);
      continue;
    }
    // 原型污染防线：JSON.parse 出来的 `__proto__` 是 own property，直接写进普通对象会改原型。
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      if (warn) warnModelLabel(`键名 "${key}" 不安全`);
      continue;
    }
    if (typeof rawValue !== 'string') {
      if (warn) warnModelLabel(`"${key}" 的显示名必须是字符串（实际是 ${typeof rawValue}）`);
      continue;
    }
    const value = rawValue.trim();
    if (!value) {
      if (warn) warnModelLabel(`"${key}" 的显示名为空`);
      continue;
    }
    if (value.length > maxLength) {
      if (warn) warnModelLabel(`"${key}" 的显示名过长（${value.length} > ${maxLength} 字符）`);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * 取某个 API id 的显示名：命中 `config.modelLabels` 用别名，否则**回退到 id 本身**。
 * 只用于展示；出网请求的 `model` 字段一律用 id（见 availableModels 的 id/label 分离）。
 * @param {any} modelLabels 原始或已归一化的 modelLabels（非法值自动回退 id）
 * @param {any} id API 实际模型 id
 * @returns {string}
 */
export function modelDisplayLabel(/** @type {any} */ modelLabels, /** @type {any} */ id) {
  const key = String(id ?? '');
  if (!key) return key;
  // 归一化一次（warn=false）：既防 `{id: 123}` 之类原始值漏进界面，又不会在此处重复告警
  const clean = normalizeModelLabels(modelLabels, { warn: false });
  return Object.prototype.hasOwnProperty.call(clean, key) ? clean[key] : key;
}

/** 该名字的能力是否**未经验证**（家族能匹配但版本比已核对规格新，或完全不属于任何家族）。 */
export function modelCapabilityUnknown(/** @type {any} */ name) {
  const preset = modelPreset(name);
  return !preset || preset.capabilityUnknown === true;
}

export function providerPreset(/** @type {any} */ name) {
  return /** @type {any} */ (PROVIDERS)[name] || null;
}
