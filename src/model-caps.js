// 模型能力解析（v0.3.2 本地模型自适应）：
// 把「模型能装多少上下文、单次最多输出多少、是否本地部署」收敛成单一来源，
// 供预算推导、超时、工具截断统一引用——避免各层各自猜一份 128000 默认，
// 本地小模型（窗口小/内存少）自动收紧预算与超时，不撑爆、不误杀。
import { modelPreset } from './models.js';

// 兜底：未知模型默认上下文窗口。本地小模型宁可保守（不撑爆）也不乐观。
export const UNKNOWN_LOCAL_WINDOW = 32768;
export const UNKNOWN_REMOTE_WINDOW = 128000;
export const DEFAULT_MAX_OUTPUT = 8192;
// 输出余量：prompt 预算必须给模型输出留足空间，否则 prompt+output 越过窗口 → 服务端截断/拒绝。
export const OUTPUT_HEADROOM = 2048;
// 舒适区：prompt 预算最多占窗口 75%——逼近 75% 以上时 prefill 时间陡增（长上下文 dequant 开销），
// 留 25% 给输出 + 抗抖缓冲，从根上避免「prompt 到窗口边缘 → 首 token 等 200s+ 被客户端掐断」。
export const COMFORT_RATIO = 0.75;
// 边缘比：模型上报的真实 prompt_tokens 逼近窗口 85% 即视为「边缘」，本回合结束强制激进压缩。
export const EDGE_RATIO = 0.85;

/** 判断 baseUrl 是否指向本机/内网（本地推理框架部署）。 */
export function isLocalBaseUrl(/** @type {any} */ baseUrl) {
  try {
    const u = new URL(String(baseUrl || ''));
    const h = u.hostname.toLowerCase();
    if (!h) return false;
    if (h === 'localhost' || h === '::1') return true;
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  } catch {
    return false;
  }
}

/**
 * 解析模型能力。优先级：customModels.<name>.contextWindow/maxOutputTokens > 内置 preset > 兜底。
 * @param {any} cfg
 * @param {string} modelName
 * @returns {{ contextWindow: number, maxOutputTokens: number, isLocal: boolean, budgetTokens: number|null, preset: any }}
 */
export function resolveModelCaps(/** @type {any} */ cfg, /** @type {any} */ modelName) {
  const preset = modelPreset(modelName);
  const cm = (cfg?.customModels || {})[modelName] || {};
  const baseUrl = cm.baseUrl || cfg?.baseUrl || '';
  const isLocal = isLocalBaseUrl(baseUrl);
  const contextWindow =
    Number(cm.contextWindow) > 0
      ? Number(cm.contextWindow)
      : preset?.contextWindow || (isLocal ? UNKNOWN_LOCAL_WINDOW : UNKNOWN_REMOTE_WINDOW);
  const maxOutputTokens =
    Number(cm.maxOutputTokens) > 0
      ? Number(cm.maxOutputTokens)
      : preset?.maxOutputTokens || Math.min(DEFAULT_MAX_OUTPUT, Math.max(1024, Math.floor(contextWindow / 8)));
  const budgetTokens = preset?.budgetTokens || null;
  return { contextWindow, maxOutputTokens, isLocal, budgetTokens, preset };
}

/**
 * 安全 prompt 预算：min(用户配置/预设, 窗口×75% 舒适区, 窗口−输出−余量)。
 * 保证 prompt + maxOutput + 余量 ≤ contextWindow，且 prompt 不越舒适区（prefill 不爆炸）。
 */
export function safeBudget(/** @type {any} */ cfg, /** @type {any} */ caps) {
  const ceiling = Math.max(1024, caps.contextWindow - caps.maxOutputTokens - OUTPUT_HEADROOM);
  const comfort = Math.max(1024, Math.floor(caps.contextWindow * COMFORT_RATIO));
  const configured = Number(cfg?.contextBudget) > 0 ? Number(cfg.contextBudget) : null;
  const base = configured ?? caps.budgetTokens ?? comfort;
  return Math.max(1024, Math.min(base, ceiling, comfort));
}
