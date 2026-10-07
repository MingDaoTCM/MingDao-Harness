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

/**
 * **发送前**的前置拦截判据（v0.6.11，审计 P1-1 拆分第一刀：从 `agent.js` 的 runTurn 循环里抽出）。
 *
 * 为什么值得单独抽出来：这段判断决定「这一发贵请求到底发不发得出去」，此前埋在 1000 行的
 * `runTurn` 里、依赖 6 个局部变量，只能靠端到端（造真实回合）间接验证。抽成纯函数后
 * 边界条件（统计不可读 / 无价格数据 / 恰好等于上限 / 上限未配置）可以逐条钉死。
 *
 * 语义（与抽取前**逐字一致**）：
 *   · 上限未配置或 ≤0 → 不拦（调用方通常已按此短路，这里再判一次是为了让函数自身可信）；
 *   · `used` 或 `worst` 为 null（统计不可读 / 无价格数据）→ **不拦也不算过**：
 *     返回 null，由主检查 `checkCostGuard` 去告警「无价格数据」，避免此处重复误拦或静默放行；
 *   · 「今日已用（含在途）+ 本轮最坏成本」达到或超过上限 → 返回可读的拦截文案。
 * @param {number} limitYuan 日上限（元）
 * @param {number|null} used 今日已用（含本回合在途）；null = 统计不可读
 * @param {number|null} worst 本轮最坏成本；null = 无价格数据
 * @returns {string|null} 拦截文案（应拦截），或 null（放行/无法判断）
 */
export function preflightBlockMessage(limitYuan, used, worst) {
  const limit = Number(limitYuan);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  if (used == null || worst == null) return null; // 无法判断：不误拦，也不静默放行（主检查会告警）
  if (used + worst < limit) return null;
  return `⛔ 护栏前置拦截：本轮最坏成本 ≈¥${worst.toFixed(4)}，今日已用 ≈¥${used.toFixed(4)}，合计将超过上限 ¥${limit.toFixed(2)}——请求未发出。可调高 config.costGuard.dailyLimitYuan 或改用更小模型。`;
}

/**
 * **每轮开始前**的护栏动作决策（v0.6.11，审计 P1-1 拆分第二刀：从 `agent.js` 的 runTurn 循环里抽出）。
 *
 * 抽取前的形态是一串嵌套 `if`，其中两处分支曾经出过**实测复现的计费缺陷**（见下），
 * 却因为埋在循环里而只能靠端到端验证。现在它是一个纯函数：输入全是普通值，输出只有四种动作。
 *
 * 四个动作与判据（与抽取前**逐字同源**）：
 *   · `block`      —— 已超限且不可降级（含"已在最便宜档"）：整轮暂停；
 *   · `try-downgrade` —— 该降级（含**在途触发**）：调用方负责校验目标模型是否同服务商；
 *   · `already-cheapest` —— 降级档但已经在该模型上：**必须拦**。
 *     v0.6.5（BUG-023/035，实测复现）：此前判据是 `downgrade && !downgraded`，于是"本回合刚降过一次"
 *     之后两个分支都不进 → 既不切换也不再拦，静默继续用便宜模型计费。这里的 `already` 判据
 *     把"一开局就是最便宜模型"与"本次刚降过去"两条路径**统一到同一结论**（此前两者结论相反）。
 *   · `warn`       —— 只提示（warn 档或降级不可用时的提示），继续执行。
 *
 * 在途触发（v0.6.7 / 登记 §3.39①(b)，报告一 §2.5）：downgrade 档若只看落账，贵模型会一直用到
 * 回合结束（实测单回合可超日限 9.1×）。所以「今日已用（含在途）已达上限」也要触发降级——
 * 但**只在还没降过的时候**（已经降过就不该反复触发）。
 *
 * @param {any} guard checkCostGuard() 的返回值（null 表示落账未超限）
 * @param {any} guardCfg costGuardConfig() 的结果
 * @param {number|null} usedWithInflight 今日已用（含本回合在途）；null = 统计不可读
 * @param {boolean} downgraded 本回合是否已经降过级
 * @param {string} activeModel 当前模型名
 * @param {string} defaultModel 兜底降级目标（DEFAULT_MODEL）
 * @returns {{action: 'proceed'|'warn'|'block'|'try-downgrade'|'already-cheapest', message: string, model?: string}}
 */
export function roundGuardAction(guard, guardCfg, usedWithInflight, downgraded, activeModel, defaultModel) {
  // ① 在途触发：落账未超限，但"今日已用 + 本回合在途"已越线，且还没降过 → 当场降级
  if (!guard && !downgraded) {
    const g0 = guardCfg;
    if (g0 && String(g0.action) === 'downgrade' && Number(g0.dailyLimitYuan) > 0) {
      if (usedWithInflight != null && usedWithInflight >= Number(g0.dailyLimitYuan)) {
        return {
          action: 'try-downgrade',
          model: String(g0.downgradeModel || defaultModel),
          message: `⚠ 费用护栏：今日已用（含本回合在途）≈¥${usedWithInflight.toFixed(4)} 已达上限 ¥${Number(g0.dailyLimitYuan).toFixed(2)}——已自动降级到便宜模型继续执行。`,
        };
      }
    }
    return { action: 'proceed', message: '' };
  }
  if (!guard) return { action: 'proceed', message: '' };
  // ② 明确要求暂停
  if (guard.blocked) return { action: 'block', message: String(guard.message ?? '') };
  if (!guard.downgrade) return { action: 'warn', message: String(guard.message ?? '') };
  // ③ 降级：已经在目标模型上（或本回合已降过）→ 无法再降，必须拦
  if (downgraded || guard.downgradeModel === activeModel) {
    return { action: 'already-cheapest', message: String(guard.message ?? '') };
  }
  return { action: 'try-downgrade', model: String(guard.downgradeModel), message: String(guard.message ?? '') };
}
