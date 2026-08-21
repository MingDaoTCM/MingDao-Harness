// 费用估算：统一计价逻辑（cli /status、/cost 与 ui/web 状态行共用）。
// DeepSeek V4 缓存感知计价：usage 提供 prompt_cache_hit_tokens / prompt_cache_miss_tokens 时，
// 命中部分按 cacheHit 价（约为未命中的 1/30），未命中按 input 价；否则按全未命中（保守上界）。

import { modelPreset } from './models.js';

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

export function estimateCost(modelName, promptTokens, completionTokens, cache = null, date = new Date()) {
  const preset = modelPreset(modelName);
  if (!preset?.pricing) return 0;
  const price = isPeakHour(date) ? preset.pricing.peak : preset.pricing.offpeak;
  if (cache && Number.isFinite(cache.hit) && Number.isFinite(cache.miss)) {
    const hitPrice = price.cacheHit ?? 0;
    return (cache.hit * hitPrice + cache.miss * price.input + completionTokens * price.output) / 1e6;
  }
  return (promptTokens * price.input + completionTokens * price.output) / 1e6;
}

export function estimateCostLabel(modelName, promptTokens, completionTokens, usage = null) {
  const preset = modelPreset(modelName);
  if (!preset?.pricing) return '';
  const cache = cacheSplit(usage);
  const yuan = estimateCost(modelName, promptTokens, completionTokens, cache).toFixed(5);
  const hitPart =
    cache && cache.hit + cache.miss > 0 ? ` · 缓存命中 ${(cache.rate * 100).toFixed(0)}%` : ' · 未计缓存折扣';
  return ` ≈¥${yuan}（${isPeakHour() ? '高峰' : '闲时'}${hitPart}）`;
}
