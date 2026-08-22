// 费用估算：统一计价逻辑（cli /status、/cost 与 ui/web 状态行共用）。
// DeepSeek V4 缓存感知计价：usage 提供 prompt_cache_hit_tokens / prompt_cache_miss_tokens 时，
// 命中部分按 cacheHit 价（约为未命中的 1/30），未命中按 input 价；否则按全未命中（保守上界）。
// 价格覆盖（P3-10）：config.json 的 pricing.overrides.<模型名> 可覆盖内置价格表，
//   结构 { input, output, cacheHit, peak?: { input, output, cacheHit } }（单位：元/百万 tokens）。

import { modelPreset } from './models.js';
import { loadConfig } from './config.js';

// 内置价格表的数据时点（定价可能调整，配置覆盖可随时更新）
export const PRICE_DATA_AS_OF = '2026-08';

export function isPeakHour(date = new Date()) {
  const hour = date.getHours();
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
