// 模型能力解析（v0.3.2 本地模型自适应）：
// 把「模型能装多少上下文、单次最多输出多少、是否本地部署」收敛成单一来源，
// 供预算推导、超时、工具截断统一引用——避免各层各自猜一份 128000 默认，
// 本地小模型（窗口小/内存少）自动收紧预算与超时，不撑爆、不误杀。
import { modelPreset } from './models.js';
// 审计 P3-3（v0.4.2）：本地判定复用 fetch.js 的 isPrivateHost（IPv4 私网/回环/CGNAT/多播 + IPv6
// fc00::/7、fe80::/10、::、::1、IPv4-mapped）——此前只查 IPv4 与 ::1，IPv6 本地模型被误判远程
// （超时档位错），且与 fetch 工具/SSRF 判定各维护一份、口径漂移。
import { isPrivateHost } from './tools/fetch.js';
import fs from 'node:fs';
import path from 'node:path';

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
// MacBook 本地 507 根因（v0.4.5）：自定义主机名（如 mtplx.server.openai 经 /etc/hosts 指向 127.0.0.1）
// 的字面量判定抓不到——isPrivateHost(hostname) 对非 IP/非 localhost 恒 false，导致本地模型被误判远程：
// 只读子代理不串行（9 路大 prefill 并发击穿内存）、压缩触发线用远程档（0.8 而非 0.6）、超时档位错。
// 同步查 /etc/hosts（含 Windows）复检「主机名 → 私网/回环 IP」的映射，命中即视为本地。
const hostsCache = /** @type {Map<string, boolean>} */ (new Map()); // hostname → 是否 /etc/hosts 映射私网
function hostsMapsToPrivate(/** @type {string} */ hostname) {
  if (hostsCache.has(hostname)) return Boolean(hostsCache.get(hostname));
  let mapped = false;
  try {
    const file = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
      : '/etc/hosts';
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const clean = line.replace(/#.*/, '').trim();
      if (!clean) continue;
      const parts = clean.split(/\s+/);
      const ip = parts[0];
      if (!ip || !isPrivateHost(ip)) continue;
      if (parts.slice(1).some((h) => h.toLowerCase() === hostname)) {
        mapped = true;
        break;
      }
    }
  } catch {
    mapped = false; // 无 /etc/hosts 或不可读：维持字面量判定
  }
  hostsCache.set(hostname, mapped);
  return mapped;
}

export function isLocalBaseUrl(/** @type {any} */ baseUrl) {
  try {
    const u = new URL(String(baseUrl || ''));
    if (!u.hostname) return false;
    const host = u.hostname.toLowerCase();
    if (isPrivateHost(host)) return true;
    // 自定义主机名（经 /etc/hosts 指向 127.0.0.1 等私网地址）复检；否则维持「远程」
    return hostsMapsToPrivate(host);
  } catch {
    return false;
  }
}

/**
 * 解析模型能力。优先级：customModels.<name>.contextWindow/maxOutputTokens > 内置 preset > 兜底。
 * @param {any} cfg
 * @param {string} modelName
 * @returns {{ contextWindow: number, maxOutputTokens: number, maxOutputCeiling: number, isLocal: boolean, budgetTokens: number|null, preset: any }}
 */
export function resolveModelCaps(/** @type {any} */ cfg, /** @type {any} */ modelName) {
  const preset = modelPreset(modelName);
  const cm = (cfg?.customModels || {})[modelName] || {};
  const baseUrl = cm.baseUrl || cfg?.baseUrl || '';
  // 显式声明优先：customModels.<name>.local=true/isLocal=true 强制按本地模型处理（压缩/串行/超时走本地档），
  // 覆盖 baseUrl 字面量/hosts 判定不到的场景（如经公网反代回本机、特殊主机名）。
  const explicitLocal = cm.local === true || cm.isLocal === true;
  const isLocal = explicitLocal || isLocalBaseUrl(baseUrl);
  const contextWindow =
    Number(cm.contextWindow) > 0
      ? Number(cm.contextWindow)
      : preset?.contextWindow || (isLocal ? UNKNOWN_LOCAL_WINDOW : UNKNOWN_REMOTE_WINDOW);
  const maxOutputTokens =
    Number(cm.maxOutputTokens) > 0
      ? Number(cm.maxOutputTokens)
      : preset?.maxOutputTokens || Math.min(DEFAULT_MAX_OUTPUT, Math.max(1024, Math.floor(contextWindow / 8)));
  const budgetTokens = preset?.budgetTokens || null;
  // v0.4.6：把 models.js 的 maxOutputCeiling（官方单次最大输出规格，如 DeepSeek 384K）纳入能力面。
  // 此前该字段只定义、源码零引用——README 宣称「单次输出上限 384K」在框架里拿不到
  // （pro 实际被 maxOutputTokens=65536 封顶，用户显式调大也无处生效）。现在它作为
  // 「用户显式配置 maxOutputTokens 时的硬上限」，让文档承诺可用且仍受窗口约束。
  const maxOutputCeiling = Number(cm.maxOutputCeiling) > 0 ? Number(cm.maxOutputCeiling) : preset?.maxOutputCeiling || maxOutputTokens;
  return { contextWindow, maxOutputTokens, maxOutputCeiling, isLocal, budgetTokens, preset };
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
