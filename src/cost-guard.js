// 费用护栏（四报告共识 A2/Kimi P-1：把峰谷定价从「展示」升级为「主动约束」）：
// config.costGuard = { dailyLimitYuan: 10, warnAtYuan: 8, action: 'warn'|'block' }
// 按北京时间自然日累计 cache-stats 实际费用（含 batch 半价与缓存折扣后的真实口径）。
// Agent 每轮开始前检查：超 warn 线提醒、超 limit 且 action=block 时暂停执行。

import { listCacheStats } from './cachestats.js';
import { beijingDayStart } from './pricing.js';
import { loadConfig } from './config.js';

export function costGuardConfig() {
  return loadConfig()?.costGuard || null;
}

// 今日（北京时间 0 点起）累计实际费用
export function todayCost() {
  const start = beijingDayStart().getTime();
  let sum = 0;
  for (const e of listCacheStats(100000)) {
    if (e.at >= start) sum += Number(e.cost) || 0;
  }
  return sum;
}

export function costGuardStatus() {
  const g = costGuardConfig();
  if (!g) return null;
  const cost = todayCost();
  const limit = Number(g.dailyLimitYuan) || 0;
  const warnAt = Number(g.warnAtYuan) || (limit > 0 ? limit * 0.8 : 0);
  const action = g.action === 'block' ? 'block' : 'warn';
  return {
    cost,
    limit,
    warnAt,
    action,
    overWarn: limit > 0 && cost >= warnAt,
    overLimit: limit > 0 && cost >= limit,
  };
}

// Agent 每轮开始前调用：返回 null 放行；blocked=true 表示应暂停本轮
export function checkCostGuard() {
  const st = costGuardStatus();
  if (!st) return null;
  if (st.overLimit && st.action === 'block') {
    return {
      blocked: true,
      message: `今日费用已达上限 ¥${st.limit.toFixed(2)}（实际 ¥${st.cost.toFixed(4)}），已暂停执行——调整 config.costGuard 或明天自动恢复。`,
    };
  }
  if (st.overWarn) {
    return {
      blocked: false,
      message: `⚠ 费用护栏：今日已用 ¥${st.cost.toFixed(4)} / 上限 ¥${st.limit.toFixed(2)}${st.action === 'block' ? '（到达即暂停）' : '（仅提醒）'}。`,
    };
  }
  return null;
}
