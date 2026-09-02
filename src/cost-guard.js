// 费用护栏（四报告共识 A2/Kimi P-1：把峰谷定价从「展示」升级为「主动约束」）：
// config.costGuard = { dailyLimitYuan: 10, warnAtYuan: 8, action: 'warn'|'block'|'downgrade', downgradeModel?: 'deepseek-v4-flash' }
// 按北京时间自然日累计 cache-stats 实际费用（含 batch 半价与缓存折扣后的真实口径）。
// Agent 每轮开始前检查：超 warn 线提醒；超 limit 时按 action 处理——
//   block：暂停执行；downgrade（省钱 B4）：自动切换便宜模型继续跑（默认 deepseek-v4-flash）。

import fs from 'node:fs';
import { listCacheStats, cacheStatsFile } from './cachestats.js';
import { beijingDayStart } from './pricing.js';
import { loadConfig } from './config.js';

export function costGuardConfig() {
  return loadConfig()?.costGuard || null;
}

// 今日（北京时间 0 点起）累计实际费用。
// 质检 M10：按 cache-stats 文件 mtime 缓存统计结果——文件未变直接复用，
// 避免 Agent 每步对整文件（可能数千行）重复解析与累加。
let todayCache = { mtime: -1, size: -1, start: 0, sum: 0 };
export function todayCost() {
  const start = beijingDayStart().getTime();
  try {
    const file = cacheStatsFile();
    const st = fs.statSync(file);
    if (st.mtimeMs === todayCache.mtime && st.size === todayCache.size && todayCache.start === start) {
      return todayCache.sum;
    }
    let sum = 0;
    for (const e of listCacheStats(100000)) {
      if (e.at >= start) sum += Number(e.cost) || 0;
    }
    todayCache = { mtime: st.mtimeMs, size: st.size, start, sum };
    return sum;
  } catch {
    // MiniMax P0：统计文件损坏/不可读时返回 null（护栏全部失效）而不是静默 0——并一次性告警
    if (!todayCostWarned) {
      todayCostWarned = true;
      console.warn('[MingDao] 费用统计读取失败：今日费用护栏暂时无法判断（修复 cache-stats.jsonl 或重启后恢复）。');
    }
    return null;
  }
}
let todayCostWarned = false;

export function costGuardStatus() {
  const g = costGuardConfig();
  if (!g) return null;
  const cost = todayCost();
  const limit = Number(g.dailyLimitYuan) || 0;
  const warnAt = Number(g.warnAtYuan) || (limit > 0 ? limit * 0.8 : 0);
  const action = g.action === 'block' || g.action === 'downgrade' ? g.action : 'warn';
  return {
    cost,
    limit,
    warnAt,
    action,
    downgradeModel: String(g.downgradeModel || 'deepseek-v4-flash'),
    degraded: cost === null, // 统计不可读：护栏降级为「无法判断」
    overWarn: cost !== null && limit > 0 && cost >= warnAt,
    overLimit: cost !== null && limit > 0 && cost >= limit,
  };
}

// Agent 每轮开始前调用：返回 null 放行；blocked=true 应暂停本轮；downgrade=true 应切换便宜模型
export function checkCostGuard() {
  const st = costGuardStatus();
  if (!st) return null;
  if (st.degraded) return null; // 统计不可读：不误拦也不放水（已告警），按无法判断处理
  if (st.overLimit && st.action === 'block') {
    return {
      blocked: true,
      message: `今日费用已达上限 ¥${st.limit.toFixed(2)}（实际 ¥${(st.cost ?? 0).toFixed(4)}），已暂停执行——调整 config.costGuard 或明天自动恢复。`,
    };
  }
  if (st.overLimit && st.action === 'downgrade') {
    return {
      blocked: false,
      downgrade: true,
      downgradeModel: st.downgradeModel,
      message: `⚠ 费用护栏：今日已用 ¥${(st.cost ?? 0).toFixed(4)} 超上限 ¥${st.limit.toFixed(2)}——已自动降级到便宜模型 ${st.downgradeModel} 继续执行（config.costGuard.action 可改回 warn/block）。`,
    };
  }
  if (st.overWarn) {
    return {
      blocked: false,
      message: `⚠ 费用护栏：今日已用 ¥${(st.cost ?? 0).toFixed(4)} / 上限 ¥${st.limit.toFixed(2)}${st.action !== 'warn' ? `（${st.action === 'block' ? '到达即暂停' : '到达自动降级 ' + st.downgradeModel}）` : '（仅提醒）'}。`,
    };
  }
  return null;
}
