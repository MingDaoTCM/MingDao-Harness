// 费用护栏（四报告共识 A2/Kimi P-1：把峰谷定价从「展示」升级为「主动约束」）：
// config.costGuard = { dailyLimitYuan: 10, warnAtYuan: 8, action: 'warn'|'block'|'downgrade', downgradeModel?: DEFAULT_MODEL }
// 按北京时间自然日累计 cache-stats 实际费用（含 batch 半价与缓存折扣后的真实口径）。
// Agent 每轮开始前检查：超 warn 线提醒；超 limit 时按 action 处理——
//   block：暂停执行；downgrade（省钱 B4）：自动切换便宜模型继续跑（默认 DEFAULT_MODEL）。

import fs from 'node:fs';
import { DEFAULT_MODEL } from './models.js';
import { listCacheStatsStrict, cacheStatsFile } from './cachestats.js';
import { beijingDayStart, hasPricing } from './pricing.js';
import { loadConfig } from './config.js';

export function costGuardConfig() {
  return loadConfig()?.costGuard || null;
}

// 今日（北京时间 0 点起）累计实际费用。
// 质检 M10：按 cache-stats 文件 mtime 缓存统计结果——文件未变直接复用，
// 避免 Agent 每步对整文件（可能数千行）重复解析与累加。
let todayCache = { mtime: -1, size: -1, start: 0, sum: 0, unknown: 0 };
// v0.4.1 P2 修复（TDZ）：todayCostWarned 提到 todayCost 使用点之前声明——
// 此前在第 44 行才 let 声明、第 36 行已使用（模块加载顺序碰巧掩盖了风险，循环依赖场景会抛 ReferenceError）。
let todayCostWarned = false;
let unknownUsageWarned = false; // 用量未知的告警也只需一次（否则每步刷屏）
/**
 * 今日累计费用（北京时间自然日）。
 *
 * v0.6.7（报告一 H-3）：读失败路径改为**严格判定**——此前走 `listCacheStats()`，它内部 `catch → []`，
 * 于是"statSync 能过、readFileSync 失败"（Windows 杀软锁文件、权限竞态、盘符瞬断）被当成
 * **今日 ¥0**：护栏据此判定未超支并放行，且没有告警。护栏要的是"能不能读到"，不是"读到几条"。
 * @returns {number|null} null = 读不到（护栏降级为"无法判断"，绝不静默当 0）
 */
export function todayCost() {
  const start = beijingDayStart().getTime();
  let st;
  try {
    st = fs.statSync(cacheStatsFile());
  } catch (/** @type {any} */ err) {
    // 区分「文件还不存在」与「真的读不了」：全新安装的第一个回合必然没有该文件——
    // 那是「今天还没花钱」（0），不是「统计损坏」。
    if (err?.code === 'ENOENT') {
      todayCache = { mtime: 0, size: 0, start, sum: 0, unknown: 0 };
      return 0;
    }
    warnTodayCostDegraded(String(err?.message ?? err));
    return null;
  }
  if (st.mtimeMs === todayCache.mtime && st.size === todayCache.size && todayCache.start === start) {
    return todayCache.sum;
  }
  const r = listCacheStatsStrict(100000);
  if (!r.ok) {
    if (r.code === 'ENOENT') {
      todayCache = { mtime: 0, size: 0, start, sum: 0, unknown: 0 };
      return 0;
    }
    warnTodayCostDegraded(r.error);
    return null;
  }
  let sum = 0;
  let unknown = 0;
  for (const e of r.entries) {
    if (!(e.at >= start)) continue;
    if (e.usageUnknown === true) unknown += 1; // 这次消费金额未知：金额不计，但事实要看得见
    sum += Number(e.cost) || 0;
  }
  todayCache = { mtime: st.mtimeMs, size: st.size, start, sum, unknown };
  return sum;
}

/** 读失败只告警一次（避免每步刷屏），但每次都让调用方拿到 null。 */
function warnTodayCostDegraded(/** @type {string} */ reason) {
  if (todayCostWarned) return;
  todayCostWarned = true;
  console.warn(`[MingDao] 费用统计读取失败：今日费用护栏暂时无法判断（${reason}）——修复 cache-stats.jsonl 的权限/占用后自动恢复。`);
}

/** 今日「用量未知」的调用次数（护栏据此给出可见信号：金额算不出，但少计这件事必须说出来）。 */
export function todayCostUnknownCount() {
  todayCost(); // 触发一次统计（含缓存失效判定）
  return Number(todayCache.unknown) || 0;
}

/**
 * @param {any} [modelName] 实际使用模型；缺省回退 config.model（仪表盘/无会话上下文）
 */
export function costGuardStatus(modelName) {
  const g = costGuardConfig();
  if (!g) return null;
  const cost = todayCost();
  const limit = Number(g.dailyLimitYuan) || 0;
  const warnAt = Number(g.warnAtYuan) || (limit > 0 ? limit * 0.8 : 0);
  const action = g.action === 'block' || g.action === 'downgrade' ? g.action : 'warn';
  // P0-4（v0.4.5）：当前模型无价格数据时费用护栏静默失效（estimateCost 恒 0、overLimit 恒 false）。
  // 显式标记 noPricing，调用方据此告警而非静默放行。modelName 优先取「实际使用模型」（agent 传 activeModel），
  // 缺省回退 config.model（仪表盘/无会话上下文）；两者都无则无法判断，不误标 noPricing。
  const cfg = loadConfig();
  const model = modelName ?? cfg?.model ?? null;
  const noPricing = limit > 0 && model != null && !hasPricing(model);
  return {
    cost,
    limit,
    warnAt,
    action,
    downgradeModel: String(g.downgradeModel || DEFAULT_MODEL),
    degraded: cost === null, // 统计不可读：护栏降级为「无法判断」
    noPricing, // 无价格数据：费用护栏无法累计，需显式告警
    // v0.6.7（H-4）：今日有几次调用的用量未知（服务端没回 usage）——金额算不出，
    // 但"少计"这件事必须能被告警出来，否则"没花钱"与"没记账"无法区分。
    unknownUsageCount: todayCostUnknownCount(),
    overWarn: cost !== null && !noPricing && limit > 0 && cost >= warnAt,
    overLimit: cost !== null && !noPricing && limit > 0 && cost >= limit,
  };
}

// Agent 每轮开始前调用：返回 null 放行；blocked=true 应暂停本轮；downgrade=true 应切换便宜模型
/**
 * @param {any} [modelName] 实际使用模型；缺省回退 config.model
 */
export function checkCostGuard(modelName) {
  const st = costGuardStatus(modelName);
  if (!st) return null;
  if (st.degraded) return null; // 统计不可读：不误拦也不放水（已告警），按无法判断处理
  if (st.noPricing) {
    // P0-4（v0.4.5）：无价格数据时护栏无法累计——显式告警而非静默放行（绝不当「没花钱」）
    return {
      blocked: false,
      message: '⚠ 费用护栏：当前模型无价格数据，今日费用无法累计、dailyLimitYuan 不生效——请在 config.pricing.overrides 为模型补充定价，或改用有价的 DeepSeek 模型（deepseek-v4-pro/flash）。',
    };
  }
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
  // v0.6.7（报告二 S-2）：任何会让 todayCost 少计的路径都必须产生**可见信号**——
  // 但只能放在**所有硬判定之后**：block/降级/告警线都比它优先（否则"有未知消费"会把
  // 真正的超限拦截顶掉。这是本批实证的一处顺序缺陷：batch 的护栏断言当场抓到）。
  if (st.unknownUsageCount > 0 && !unknownUsageWarned) {
    unknownUsageWarned = true;
    return {
      blocked: false,
      message: `⚠ 费用护栏：今日有 ${st.unknownUsageCount} 次调用的**用量未知**（服务端未返回 usage）——金额无法估算，护栏可能少计这部分消费。若使用自建网关，请让其透传 usage 字段。`,
    };
  }
  return null;
}
