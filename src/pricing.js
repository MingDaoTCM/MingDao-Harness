// 费用估算：统一计价逻辑（cli /status、/cost 与 ui/web 状态行共用）。
// DeepSeek V4 缓存感知计价：usage 提供 prompt_cache_hit_tokens / prompt_cache_miss_tokens 时，
// 命中部分按 cacheHit 价（约为未命中的 1/30），未命中按 input 价；否则按全未命中（保守上界）。
// 价格覆盖（P3-10）：config.json 的 pricing.overrides.<模型名> 可覆盖内置价格表，
//   结构 { input, output, cacheHit, peak?: { input, output, cacheHit } }（单位：元/百万 tokens）。

import fs from 'node:fs';
import path from 'node:path';
import { modelPreset } from './models.js';
import { atomicWriteFileSync } from './atomic-write.js';
import { mingdaoHome } from './config.js';

// 内置价格表的数据时点（定价可能调整，配置覆盖可随时更新）
export const PRICE_DATA_AS_OF = '2026-08';

// 价格表外置（Hermes C1）：~/.mingdao/pricing.json 由「mingdao update --pricing」从
// cfg.pricing.source 拉取（TTL 默认 7 天，cfg.pricing.ttlDays 可调）；TTL 内覆盖内置表，
// 过期自动回退内置并置 stale 标记（/cost 与费用标签会提示）。
function pricingFilePath() { return path.join(mingdaoHome(), 'pricing.json'); }
/** @type {{ mtime: number, ttlDays: number, data: any, stale: boolean }} */
let extCache = { mtime: -1, ttlDays: 7, data: null, stale: false };
function externalPricing() {
  try {
    // 审计 P2-2（v0.4.2）：此前直接读 tzCache.ttlDays——首次调用若早于 peakCfg()（isPeakHour），
    // tzCache 还是初值（无 ttlDays），用户配的 pricing.ttlDays 被忽略按 7 天判过期且缓存整个进程寿命。
    // 改走 peakCfg()（mtime 缓存，代价极低）；ttlDays 变化也触发重算（不依赖 pricing.json mtime 变化）。
    const ttlDays = Number(peakCfg().ttlDays || 7);
    const f = pricingFilePath();
    const st = fs.statSync(f);
    if (st.mtimeMs !== extCache.mtime || ttlDays !== extCache.ttlDays) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const age = Date.now() - Number(d?.fetchedAt || 0);
      extCache = { mtime: st.mtimeMs, ttlDays, data: d, stale: !Number.isFinite(age) || age > ttlDays * 86400000 };
    }
  } catch {
    extCache = { mtime: -1, ttlDays: 7, data: null, stale: false };
  }
  return extCache;
}
export function pricingDataStale() { return externalPricing().stale; }

// 拉取官方价格表（零依赖 fetch）：cfg.pricing.source 为 JSON 地址，返回 { models: { <模型名>: { input, output, cacheHit, peak? } } }
/**
 * @param {any} cfg
 */
export async function refreshPricingFromSource(cfg) {
  const src = String(cfg?.pricing?.source || '').trim();
  if (!src) return { ok: false, lines: ['未配置 pricing.source（config.json 的 pricing.source 填官方价格 JSON 地址后重试）'] };
  // 自查 #4：与 sync/自定义模型同类的第三外联入口——协议白名单 + 响应大小上限（防误配/恶意源灌内存）
  try {
    const u = new URL(src);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, lines: ['价格源仅支持 http/https 地址'] };
  } catch {
    return { ok: false, lines: ['价格源必须是合法的 http(s) URL'] };
  }
  const res = await fetch(src, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { ok: false, lines: ['价格源请求失败：HTTP ' + res.status] };
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 512 * 1024) return { ok: false, lines: ['价格源响应超过 512KB 上限，已拒绝'] };
  const d = JSON.parse(Buffer.from(buf).toString('utf8'));
  const models = d && typeof d === 'object' && !Array.isArray(d) ? /** @type {any} */ (d).models : null;
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    return { ok: false, lines: ['价格源格式不符：应为 {"models": {"模型名": {"input":…,"output":…,"cacheHit":…,"peak":{…}}}}'] };
  }
  const file = pricingFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, JSON.stringify({ fetchedAt: Date.now(), source: src, models }, null, 2));
  extCache = { mtime: -1, ttlDays: 7, data: null, stale: false };
  const names = Object.keys(models).join('、');
  return { ok: true, lines: ['✓ 价格表已刷新（' + names + '），TTL 内费用估算/护栏/避峰自动跟随'] };
}

// 峰谷判断锚定北京时间（DeepSeek 官方定价页：高峰时段 = 北京时间周一至周五
// 9:00–12:00、14:00–18:00 两段；其余（含午间 12:00–14:00 与周末全天）为闲时，闲时价 = 高峰一半）。
// 用本机时区判断会让海外用户计费错位。config.pricing.timezone 可覆盖时区、
// config.pricing.peakWindows 可覆盖高峰窗口（[[起,止],...] 北京时间整点），mtime 缓存避免每次读盘。
const DEFAULT_PEAK_WINDOWS = [[9, 12], [14, 18]];
/** @type {{ mtime: number, timezone: string, peakWindows: number[][], ttlDays?: number }} */
let tzCache = { mtime: 0, timezone: 'Asia/Shanghai', peakWindows: DEFAULT_PEAK_WINDOWS };
function peakCfg() {
  try {
    const file = path.join(mingdaoHome(), 'config.json');
    const st = fs.statSync(file);
    if (st.mtimeMs !== tzCache.mtime) {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const pw = cfg?.pricing?.peakWindows;
      tzCache = {
        mtime: st.mtimeMs,
        timezone: String(cfg?.pricing?.timezone || 'Asia/Shanghai'),
        peakWindows: Array.isArray(pw) && pw.length ? pw : DEFAULT_PEAK_WINDOWS,
        ttlDays: Number(cfg?.pricing?.ttlDays || 7),
      };
    }
  } catch {}
  return tzCache;
}

export function isPeakHour(date = new Date()) {
  const { timezone, peakWindows } = peakCfg();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(date);
    const weekday = parts.find((p) => p.type === 'weekday')?.value;
    // 周末全天按闲时计价
    if (weekday === 'Sat' || weekday === 'Sun') return false;
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    return peakWindows.some(([s, e]) => hour >= s && hour < e);
  } catch {
    const h = date.getHours();
    return peakWindows.some(([s, e]) => h >= s && h < e); // 非法时区回退本机
  }
}

// —— 计价时区墙钟工具（避峰调度/费用护栏按天统计用，零依赖 Intl） ——
// v0.4.6：抽出「生效时区」解析（坏配置回退 Asia/Shanghai，绝不让计费/护栏崩溃）。
function activeTimezone() {
  try {
    const tz = peakCfg().timezone;
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(); // 非法时区在此抛错
    return tz;
  } catch {
    return 'Asia/Shanghai';
  }
}

/** @param {Date} date @param {string} tz 该时刻在 tz 的墙钟与 UTC 的偏移（毫秒） */
function tzOffsetMs(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const g = (/** @type {any} */ t) => Number(parts.find((/** @type {any} */ p) => p.type === t)?.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function beijingParts(date = new Date()) {
  const tz = activeTimezone();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const g = /** @type {(t: any) => number} */ ((t) => Number(parts.find((p) => p.type === t)?.value));
  return { year: g('year'), month: g('month'), day: g('day'), hour: g('hour'), minute: g('minute'), second: g('second') };
}

// 时区墙钟 → Date。
// v0.4.6 P3 修复：此前硬编码 `- 8h`（只管 Asia/Shanghai），而 beijingParts() 用的是可配置的
// `pricing.timezone`——用户按文档覆盖时区后，日界（费用护栏按自然日累计）与 --offpeak 顺延
// 会同时算错（美东实测错 12 小时：日界落在当地中午、避峰时刻整体偏移）。
// 现按目标时区真实偏移换算，用「两遍法」处理含夏令时的时区。
/**
 * @param {any} parts
 */
export function beijingToDate(parts) {
  const tz = activeTimezone();
  const guessMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let ts = guessMs;
  for (let i = 0; i < 3; i++) {
    const next = guessMs - tzOffsetMs(new Date(ts), tz);
    if (next === ts) break;
    ts = next;
  }
  return new Date(ts);
}

// 避峰顺延：当前处于高峰 → 顺延到该高峰段的结束整点（即最近一个闲时起点）
//   · 9:00–12:00 高峰 → 12:00（午间闲时）
//   · 14:00–18:00 高峰 → 18:00（晚间闲时）
// 其余（午间/晚间/清晨/周末）原时刻执行。窗口可经 pricing.peakWindows 覆盖。
export function deferToOffpeak(date = new Date()) {
  if (!isPeakHour(date)) return date;
  const p = beijingParts(date);
  const w = peakCfg().peakWindows.find(([s, e]) => p.hour >= s && p.hour < e);
  const targetHour = w ? w[1] : 18;
  return beijingToDate({ ...p, hour: targetHour, minute: 0, second: 0 });
}

// 当前时段的人类可读描述（设置面板/调度备注共用）
export function peakStatusLabel(date = new Date()) {
  if (!isPeakHour(date)) return '闲时';
  const p = beijingParts(date);
  const w = peakCfg().peakWindows.find(([s, e]) => p.hour >= s && p.hour < e);
  return `高峰（至 ${String(w ? w[1] : 18).padStart(2, '0')}:00）`;
}

// 北京时间当日 0 点（费用护栏按自然日累计）
export function beijingDayStart(date = new Date()) {
  const p = beijingParts(date);
  return beijingToDate({ ...p, hour: 0, minute: 0, second: 0 });
}

// —— Batch API 半价计价：批量任务无缓存语义，按闲时全未命中 × 0.5 ——
export const BATCH_DISCOUNT = 0.5;
/**
 * @param {any} modelName
 * @param {any} promptTokens
 * @param {any} completionTokens
 */
export function estimateBatchCost(modelName, promptTokens, completionTokens) {
  const pricing = effectivePricing(modelName);
  // P0-4 同口径（v0.4.6）：无价模型返 null 而非 0。Batch 路径此前恒返 0，导致
  // ① `--max-cost` 预算拦截对「无内置/外部/覆盖价格」的模型静默失效（0 > maxCost 恒 false），
  // ② /cost 把未知费用显示成 ≈¥0.00000 冒充免费。与 estimateCost 的语义保持一致。
  if (!pricing) return null;
  return ((promptTokens * pricing.offpeak.input + completionTokens * pricing.offpeak.output) / 1e6) * BATCH_DISCOUNT;
}

// usage 中的缓存拆分（DeepSeek 返回字段）
/**
 * @param {any} usage
 */
export function cacheSplit(usage) {
  const hit = usage?.prompt_cache_hit_tokens;
  const miss = usage?.prompt_cache_miss_tokens;
  if (Number.isFinite(hit) && Number.isFinite(miss)) {
    return { hit, miss, rate: hit + miss > 0 ? hit / (hit + miss) : 0 };
  }
  return null;
}

// 合并内置价与用户覆盖：offpeak 字段覆盖 offpeak，over.peak 覆盖 peak（缺省沿用 offpeak）
/** @type {{ mtime: number, overrides: Record<string, any> }} */
let overridesCache = { mtime: 0, overrides: {} };
function pricingOverrides() {
  try {
    const file = path.join(mingdaoHome(), 'config.json');
    const st = fs.statSync(file);
    if (st.mtimeMs !== overridesCache.mtime) {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      overridesCache = { mtime: st.mtimeMs, overrides: cfg?.pricing?.overrides || {} };
    }
  } catch {}
  return overridesCache.overrides;
}
/**
 * @param {any} modelName
 */
// P0-4（v0.4.5）：判断模型是否有价格数据（内置定价或外部定价或 overrides）——
// 无价模型 estimateCost 恒 0，费用护栏/仪表盘/分账静默失真，必须显式暴露给调用方告警。
export function hasPricing(/** @type {any} */ modelName) {
  return Boolean(modelName && effectivePricing(modelName));
}

/** @param {any} modelName */
function effectivePricing(modelName) {
  const preset = modelPreset(modelName);
  const ext = externalPricing().data?.models?.[modelName] || null;
  const over = pricingOverrides()[modelName] || {}; // 审计 Q3：mtime 缓存替代每轮读盘
  const base = ext || preset?.pricing || null;
  // P0 修复（v0.4.6）：overrides 本身就是一条价格来源，必须与 ext/preset 等价对待。
  // 此前「先判 base 是否存在」就 return null，导致用户按护栏提示给 gpt-5 / 本地模型配的
  // config.pricing.overrides 完全不生效：hasPricing=false → estimateCost=null →
  // cache-stats 记 cost=null（当 0 累计）→ todayCost 看不到这些消费 → 护栏永不拦截。
  // 内置 12 个模型里只有 3 个 DeepSeek 带 pricing，即「每日上限防超支」对另外 9 个
  // 以及全部动态发现/自定义模型形同虚设，而护栏给出的补救办法恰是这条不生效的路径。
  const hasOver = Object.keys(over).length > 0;
  if (!base && !hasOver) return null;
  // 仅靠 overrides 供价时，要求 input 与 output 都是有限正数：半张价格表会把缺失的一侧
  // 静默当成 0（输出免费 / 命中免费），比「未知（null）」更危险——宁可报无价并告警。
  if (!base) {
    const ok = (/** @type {any} */ v) => Number.isFinite(Number(v)) && Number(v) > 0;
    if (!ok(over.input) || !ok(over.output)) return null;
  }
  /** @type {(b: any, o?: any) => { input: number, output: number, cacheHit: number }} */
  const merge = (b, o = {}) => ({
    input: Number(o.input ?? b?.input ?? 0),
    output: Number(o.output ?? b?.output ?? 0),
    cacheHit: Number(o.cacheHit ?? b?.cacheHit ?? 0),
  });
  // 审计 H1（质检 0.1.68）：根级 overrides.{input,output,cacheHit} 是价格主体（offpeak 口径），
  // 必须同样传播到 peak——此前 peak 只吃 over.peak，高峰时段自定义价格被内置 peak 价替代，
  // 费用估算/护栏/前置预估全部失真且无任何信号。现在：peak 缺省沿用根级覆盖，over.peak 可再细分。
  const peakOver = {
    input: over.peak?.input ?? over.input,
    output: over.peak?.output ?? over.output,
    cacheHit: over.peak?.cacheHit ?? over.cacheHit,
  };
  return {
    offpeak: merge(base?.offpeak || base || {}, over),
    peak: merge(base?.peak || base?.offpeak || base || {}, peakOver),
  };
}

/**
 * @param {any} modelName
 * @param {any} promptTokens
 * @param {any} completionTokens
 * @param {{ hit: number, miss: number, rate?: number } | null} [cache]
 * @param {Date} [date]
 */
export function estimateCost(modelName, promptTokens, completionTokens, cache = null, date = new Date()) {
  const pricing = effectivePricing(modelName);
  // P0-4（v0.4.5）：无价返 null 而非 0——0 与「未知」语义完全混淆（0 被当作「免费/没花钱」），
  // 下游护栏/分账/仪表盘据此静默失真。返回 null 强制调用方显式区分「未知」与「免费（0）」（技术评估 P0-4）。
  if (!pricing) return null;
  const price = isPeakHour(date) ? pricing.peak : pricing.offpeak;
  if (cache && Number.isFinite(cache.hit) && Number.isFinite(cache.miss)) {
    const hitPrice = price.cacheHit ?? 0;
    // 网关 hit+miss 与 prompt_tokens 口径不一致时，余量按未命中计价，避免漏计
    const miss = cache.miss + Math.max(0, promptTokens - cache.hit - cache.miss);
    return (cache.hit * hitPrice + miss * price.input + completionTokens * price.output) / 1e6;
  }
  return (promptTokens * price.input + completionTokens * price.output) / 1e6;
}

/**
 * @param {any} modelName
 * @param {any} promptTokens
 * @param {any} completionTokens
 * @param {any} [usage]
 */
export function estimateCostLabel(modelName, promptTokens, completionTokens, usage = null) {
  const cache = cacheSplit(usage);
  const c = estimateCost(modelName, promptTokens, completionTokens, cache);
  // P0-4（v0.4.5）：无价返 null → 标签置空（不显示「≈¥0.0000」冒充免费）
  if (c == null) return '';
  const yuan = c.toFixed(5);
  const hitPart =
    cache && cache.hit + cache.miss > 0 ? ` · 缓存命中 ${(cache.rate * 100).toFixed(0)}%` : ' · 未计缓存折扣';
  return ` ≈¥${yuan}（${isPeakHour() ? '高峰' : '闲时'}${hitPart}）${pricingDataStale() ? ' · ⚠ 价格表过期，运行 mingdao update --pricing 刷新' : ''}`;
}
