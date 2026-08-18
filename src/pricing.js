// 费用估算：统一计价逻辑（cli /status、/cost 与 ui 状态行共用）。
// 定价口径：元/百万 tokens，缓存未命中价（保守上界）；高峰 9:00–14:00 为闲时 2 倍。

import { modelPreset } from './models.js';

export function isPeakHour(date = new Date()) {
  const hour = date.getHours();
  return hour >= 9 && hour < 14;
}

export function estimateCost(modelName, promptTokens, completionTokens, date = new Date()) {
  const preset = modelPreset(modelName);
  if (!preset?.pricing) return 0;
  const price = isPeakHour(date) ? preset.pricing.peak : preset.pricing.offpeak;
  return (promptTokens * price.input + completionTokens * price.output) / 1e6;
}

export function estimateCostLabel(modelName, promptTokens, completionTokens) {
  const preset = modelPreset(modelName);
  if (!preset?.pricing) return '';
  return ` ≈¥${estimateCost(modelName, promptTokens, completionTokens).toFixed(5)}（${isPeakHour() ? '高峰' : '闲时'}·未计缓存折扣）`;
}
