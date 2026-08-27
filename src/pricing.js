// 费用估算：统一计价逻辑（cli /status、/cost 与 ui/web 状态行共用）。
// DeepSeek V4 缓存感知计价：usage 提供 prompt_cache_hit_tokens / prompt_cache_miss_tokens 时，
// 命中部分按 cacheHit 价（约为未命中的 1/30），未命中按 input 价；否则按全未命中（保守上界）。
// 价格覆盖（P3-10）：config.json 的 pricing.overrides.<模型名> 可覆盖内置价格表，
//   结构 { input, output, cacheHit, peak?: { input, output, cacheHit } }（单位：元/百万 tokens）。

import fs from 'node:fs';
import path from 'node:path';
import { modelPreset } from './models.js';
import { mingdaoHome } from './config.js';

// 内置价格表的数据时点（定价可能调整，配置覆盖可随时更新）
export const PRICE_DATA_AS_OF = '2026-08';

// 价格表外置（Hermes C1）：~/.mingdao/pricing.json 由「mingdao update --pricing」从
// cfg.pricing.source 拉取（TTL 默认 7 天，cfg.pricing.ttlDays 可调）；TTL 内覆盖内置表，
// 过期自动回退内置并置 stale 标记（/cost 与费用标签会提示）。
function pricingFilePath() { return path.join(mingdaoHome(), 'pricing.json'); }
let extCache = { mtime: -1, data: null, stale: false };
function externalPricing() {
  try {
    const f = pricingFilePath();
    const st = fs.statSync(f);
    if (st.mtimeMs !== extCache.mtime) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const ttlDays = Number(tzCache.ttlDays ?? 7);
      const age = Date.now() - Number(d?.fetchedAt || 0);
      extCache = { mtime: st.mtimeMs, data: d, stale: !Number.isFinite(age) || age > ttlDays * 86400000 };
    }
  } catch {
    extCache = { mtime: -1, data: null, stale: false };
  }
  return extCache;
}
export function pricingDataStale() { return externalPricing().stale; }

// 拉取官方价格表（零依赖 fetch）：cfg.pricing.source 为 JSON 地址，返回 { models: { <模型名>: { input, output, cacheHit, peak? } } }
export async function refreshPricingFromSource(cfg) {
  const src = String(cfg?.pricing?.source || '').trim();
  if (!src) return { ok: false, lines: ['未配置 pricing.source（config.json 的 pricing.source 填官方价格 JSON 地址后重试）'] };
  const res = await fetch(src, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { ok: false, lines: ['价格源请求失败：HTTP ' + res.status] };
  const d = await res.json();
  const models = d && typeof d === 'object' && !Array.isArray(d) ? /** @type {any} */ (d).models : null;
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    return { ok: false, lines: ['价格源格式不符：应为 {"models": {"模型名": {"input":…,"output":…,"cacheHit":…,"peak":{…}}}}'] };
  }
  const file = pricingFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), source: src, models }, null, 2));
  extCache = { mtime: -1, data: null, stale: false };
  const names = Object.keys(models).join('、');
  return { ok: true, lines: ['✓ 价格表已刷新（' + names + '），TTL 内费用估算/护栏/避峰自动跟随'] };
}

// 峰谷判断锚定北京时间（DeepSeek 官方定价页：高峰时段 = 北京时间周一至周五
// 9:00–12:00、14:00–18:00 两段；其余（含午间 12:00–14:00 与周末全天）为闲时，闲时价 = 高峰一半）。
// 用本机时区判断会让海外用户计费错位。config.pricing.timezone 可覆盖时区、
// config.pricing.peakWindows 可覆盖高峰窗口（[[起,止],...] 北京时间整点），mtime 缓存避免每次读盘。
const DEFAULT_PEAK_WINDOWS = [[9, 12], [14, 18]];
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

// —— 北京时间墙钟工具（避峰调度/费用护栏按天统计用，零依赖 Intl） ——
export function beijingParts(date = new Date()) {
  let tz = 'Asia/Shanghai';
  try {
    tz = peakCfg().timezone;
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(); // 非法时区在此抛错
  } catch {
    tz = 'Asia/Shanghai'; // 审计 B1：坏时区配置回退北京时间，绝不让计费/护栏崩溃
  }
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
  const g = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { year: g('year'), month: g('month'), day: g('day'), hour: g('hour'), minute: g('minute'), second: g('second') };
}

// 北京时间墙钟 → Date（UTC+8）
export function beijingToDate(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - 8 * 3600 * 1000);
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
export function estimateBatchCost(modelName, promptTokens, completionTokens) {
  const pricing = effectivePricing(modelName);
  if (!pricing) return 0;
  return ((promptTokens * pricing.offpeak.input + completionTokens * pricing.offpeak.output) / 1e6) * BATCH_DISCOUNT;
}

// usage 中的缓存拆分（DeepSeek 返回字段）
export function cacheSplit(usage) {
  const hit = usage?.prompt_cache_hit_tokens;
  const miss = usage?.prompt_cache_miss_tokens;
  if (Number.isFinite(hit) && Number.isFinite(miss)) {
    return { hit, miss, rate: hit + miss > 0 ? hit / (hit + miss) : 0 };
  }
  return null;
}

// 合并内置价与用户覆盖：offpeak 字段覆盖 offpeak，over.peak 覆盖 peak（缺省沿用 offpeak）
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
function effectivePricing(modelName) {
  const preset = modelPreset(modelName);
  const ext = externalPricing().data?.models?.[modelName] || null;
  if (!preset?.pricing && !ext) return null;
  const base = ext || preset?.pricing || null;
  if (!base) return null;
  const over = pricingOverrides()[modelName] || {}; // 审计 Q3：mtime 缓存替代每轮读盘
  const merge = (b, o = {}) => ({
    input: Number(o.input ?? b?.input ?? 0),
    output: Number(o.output ?? b?.output ?? 0),
    cacheHit: Number(o.cacheHit ?? b?.cacheHit ?? 0),
  });
  return {
    offpeak: merge(base.offpeak || base, over),
    peak: merge(base.peak || base.offpeak || base, over.peak),
  };
}

export function estimateCost(modelName, promptTokens, completionTokens, cache = null, date = new Date()) {
  const pricing = effectivePricing(modelName);
  if (!pricing) return 0;
  const price = isPeakHour(date) ? pricing.peak : pricing.offpeak;
  if (cache && Number.isFinite(cache.hit) && Number.isFinite(cache.miss)) {
    const hitPrice = price.cacheHit ?? 0;
    // 网关 hit+miss 与 prompt_tokens 口径不一致时，余量按未命中计价，避免漏计
    const miss = cache.miss + Math.max(0, promptTokens - cache.hit - cache.miss);
    return (cache.hit * hitPrice + miss * price.input + completionTokens * price.output) / 1e6;
  }
  return (promptTokens * price.input + completionTokens * price.output) / 1e6;
}

export function estimateCostLabel(modelName, promptTokens, completionTokens, usage = null) {
  const pricing = effectivePricing(modelName);
  if (!pricing) return '';
  const cache = cacheSplit(usage);
  const yuan = estimateCost(modelName, promptTokens, completionTokens, cache).toFixed(5);
  const hitPart =
    cache && cache.hit + cache.miss > 0 ? ` · 缓存命中 ${(cache.rate * 100).toFixed(0)}%` : ' · 未计缓存折扣';
  return ` ≈¥${yuan}（${isPeakHour() ? '高峰' : '闲时'}${hitPart}）${pricingDataStale() ? ' · ⚠ 价格表过期，运行 mingdao update --pricing 刷新' : ''}`;
}
