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
  let hour = -1;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: peakTimezone(), hour: 'numeric', hourCycle: 'h23' }).formatToParts(date);
    hour = Number(parts.find((p) => p.type === 'hour')?.value);
  } catch {
    hour = date.getHours(); // 非法时区回退本机
  }
  return hour >= 9 && hour < 14;
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
