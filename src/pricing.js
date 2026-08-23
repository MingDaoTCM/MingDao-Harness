// 费用估算：统一计价逻辑（cli /status、/cost 与 ui/web 状态行共用）。
// DeepSeek V4 缓存感知计价：usage 提供 prompt_cache_hit_tokens / prompt_cache_miss_tokens 时，
// 命中部分按 cacheHit 价（约为未命中的 1/30），未命中按 input 价；否则按全未命中（保守上界）。
// 价格覆盖（P3-10）：config.json 的 pricing.overrides.<模型名> 可覆盖内置价格表，
//   结构 { input, output, cacheHit, peak?: { input, output, cacheHit } }（单位：元/百万 tokens）。

import fs from 'node:fs';
import path from 'node:path';
import { modelPreset } from './models.js';
import { loadConfig, mingdaoHome } from './config.js';

// 内置价格表的数据时点（定价可能调整，配置覆盖可随时更新）
export const PRICE_DATA_AS_OF = '2026-08';

// 峰谷判断锚定北京时间（评估 P0-4：DeepSeek 按北京时间 9:00–14:00 高峰计价，
// 用本机时区判断会让海外用户计费错位）。config.pricing.timezone 可覆盖，mtime 缓存避免每次读盘。
let tzCache = { mtime: 0, timezone: 'Asia/Shanghai' };
function peakTimezone() {
  try {
    const file = path.join(mingdaoHome(), 'config.json');
    const st = fs.statSync(file);
    if (st.mtimeMs !== tzCache.mtime) {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      tzCache = { mtime: st.mtimeMs, timezone: String(cfg?.pricing?.timezone || 'Asia/Shanghai') };
    }
  } catch {}
  return tzCache.timezone;
}

export function isPeakHour(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: peakTimezone(),
      weekday: 'short',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(date);
    const weekday = parts.find((p) => p.type === 'weekday')?.value;
    // 周末全天按闲时计价（DeepSeek 官方邮件确认：周六/周日全天闲时低价，批量任务周末更划算）
    if (weekday === 'Sat' || weekday === 'Sun') return false;
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    return hour >= 9 && hour < 14;
  } catch {
    return date.getHours() >= 9 && date.getHours() < 14; // 非法时区回退本机
  }
}

// —— 北京时间墙钟工具（避峰调度/费用护栏按天统计用，零依赖 Intl） ——
export function beijingParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: peakTimezone(),
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

// 避峰：当前处于高峰（9:00–14:00）→ 顺延到当天 14:00；否则原时刻
export function deferToOffpeak(date = new Date()) {
  if (!isPeakHour(date)) return date;
  const p = beijingParts(date);
  return beijingToDate({ ...p, hour: 14, minute: 0, second: 0 });
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
function effectivePricing(modelName) {
  const preset = modelPreset(modelName);
  if (!preset?.pricing) return null;
  const over = loadConfig()?.pricing?.overrides?.[modelName] || {};
  const merge = (base, o = {}) => ({
    input: Number(o.input ?? base?.input ?? 0),
    output: Number(o.output ?? base?.output ?? 0),
    cacheHit: Number(o.cacheHit ?? base?.cacheHit ?? 0),
  });
  return {
    offpeak: merge(preset.pricing.offpeak, over),
    peak: merge(preset.pricing.peak || preset.pricing.offpeak, over.peak),
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
  return ` ≈¥${yuan}（${isPeakHour() ? '高峰' : '闲时'}${hitPart}）`;
}
