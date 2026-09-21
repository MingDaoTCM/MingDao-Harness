// 自动模型路由：规划类任务 → planner（如 deepseek-v4-pro），执行类 → executor（如 deepseek-v4-flash）。
// 两级判定：
//   1. 启发式：长文本 + 规划关键词 → planner；极短指令 → executor（零成本）
//   2. 分类器：用 executor 模型做一次极简分类（成本约几十 token；结果按文本哈希 LRU 缓存）
// 会话粘滞（评估 P2-1/B7）：执行类会话连续保持 executor，不再逐轮分类，也避免 pro⇄flash
// 抖动反复破坏上下文缓存前缀（除非出现生成类关键词——启发式已优先处理）。
// 子代理（task）固定走 executor（子任务以执行/调研为主，便宜又够用）。

import crypto from 'node:crypto';
import { DEFAULT_PLANNER_MODEL, DEFAULT_EXECUTOR_MODEL } from './models.js';
import { recordAuxUsage } from './cachestats.js';
import { modelPreset, canonicalModel } from './models.js';

export function routingConfig(/** @type {any} */ cfg) {
  const r = cfg?.routing;
  if (!r || r.enabled === false) return null;
  const planner = r.planner || DEFAULT_PLANNER_MODEL;
  const executor = r.executor || DEFAULT_EXECUTOR_MODEL;
  if (!planner || !executor || planner === executor) return null;
  return { planner, executor };
}

// 分类器失败的告警只打一次（避免每轮刷屏），但**不能不打**（审计 BUG-044）：
// 此前 `catch {}` 全吞，用户只看到「回退执行模型」，分不清「分类器说不确定」和「分类器 500 挂了」。
let routeWarned = false;
function routeWarn(/** @type {string} */ msg) {
  if (routeWarned) return;
  routeWarned = true;
  console.warn(`[MingDao] ⚠ ${msg}\n  路由仍可用（已回退执行模型），但这**不是**「分类器说不确定」——请检查分类器服务商的配置与额度。`);
}

const PLAN_HINTS =
  /设计|架构|重构|审查|规划|分析|方案|评估|优化|排查|疑难|报错|怎么修|修复|设计模式|选型|技术债|roadmap|review|design|refactor|plan|architecture|方案设计|评审|fix|analyze|analyse|evaluate|audit|optimize|bug|issue|error|performance/i;

// 生成类任务（游戏/网页/文档等）需要大输出（planner 32K vs executor 8K），即使短句也路由 planner
const GENERATION_HINTS =
  /(生成|制作|编写|创建|写|开发|实现|做|make|build|create|generate|write|implement|develop).{0,30}(游戏|网页|页面|网站|应用|程序|文档|报告|简历|PPT|演示|完整|详细|小工具|game|website|page|site|app|program|document|report|resume|ppt|tool)|网页版|游戏|webpage|website/i;

export function heuristicRoute(/** @type {any} */ text, /** @type {any} */ rc) {
  const s = String(text ?? '');
  if (GENERATION_HINTS.test(s)) return rc.planner; // 生成类：大输出优先
  if (PLAN_HINTS.test(s)) {
    // 规划类关键词优先（审计：此前要求 length>=40，导致「设计一个缓存方案」这类
    // 13 字短句被误路由到 flash 硬扛——关键词强度优先于文本长度）
    return s.length >= 40 || /设计|规划|分析|评估|审查|架构|重构|方案|优化|报错|修复|fix|analy|review|design|plan|optimiz|refactor|evaluat|audit|error|bug/i.test(s) ? rc.planner : null;
  }
  if (s.length <= 60) return rc.executor;
  return null; // 需要分类器
}

// 分类结果缓存：文本 sha256 → 结论（同一问题反复问/粘贴同一报错不再重复分类）
const ROUTE_CACHE_MAX = 100;
const routeCache = new Map();

export async function routeTask(/** @type {any} */ { cfg, provider, currentModel, text, sticky = null, sessionStats = null }) {
  const rc = routingConfig(cfg);
  if (!rc) return { model: currentModel, reason: null };
  // 当前模型已在路由池外（用户手动指定）：不干预。
  // 比较必须走 canonicalModel：老配置里是改名前旧名（deepseek-v4-flash），
  // 直接比字符串会把它判成「池外」→ 自动路由对老用户静默失效。
  const cur = canonicalModel(currentModel);
  if (cur !== canonicalModel(rc.planner) && cur !== canonicalModel(rc.executor)) {
    return { model: currentModel, reason: null };
  }

  const quick = heuristicRoute(text, rc);
  if (quick) {
    return canonicalModel(quick) === cur
      ? { model: currentModel, reason: null }
      : { model: quick, reason: quick === rc.planner ? '规划类任务' : '执行类任务' };
  }

  // 会话粘滞 + 升级检测（Hermes C2）：执行类会话不再逐轮分类（生成类关键词已在启发式拦截），
  // 但会话内复杂度信号累积（工具步数/截断次数）时允许升级 planner——「开头简单、中途复杂」不再被 flash 硬扛。
  if (sticky === rc.executor) {
    const stats = /** @type {any} */ (sessionStats || {});
    const steps = Number(stats.steps) || 0;
    const truncated = Number(stats.truncated) || 0;
    const UPGRADE_STEPS = Number(cfg?.routing?.upgradeSteps) || 10;
    const UPGRADE_TRUNCATED = Number(cfg?.routing?.upgradeTruncated) || 2;
    if (steps >= UPGRADE_STEPS || truncated >= UPGRADE_TRUNCATED) {
      return rc.planner === currentModel
        ? { model: currentModel, reason: null }
        : { model: rc.planner, reason: `会话升级：执行类已累计 ${steps} 步工具 / ${truncated} 次截断 → planner` };
    }
    return rc.executor === currentModel
      ? { model: currentModel, reason: null }
      : { model: rc.executor, reason: '会话粘滞：执行类' };
  }

  // 分类缓存（审计 BUG-043：**命中时要把它移到队尾**，否则这里是 FIFO——
  // 实测「先问过的那条」在填满 100 条后被淘汰、再次命中要重调分类器，
  // 而文件头注释一直自称 LRU；每次未命中都是一次真实的 LLM 调用）
  const key = crypto.createHash('sha256').update(String(text).slice(0, 4000)).digest('hex');
  const cached = routeCache.get(key);
  if (cached) {
    routeCache.delete(key);
    routeCache.set(key, cached); // LRU touch
    const m = cached === 'plan' ? rc.planner : rc.executor;
    return m === currentModel ? { model: currentModel, reason: null } : { model: m, reason: cached === 'plan' ? '分类器判定：规划类（缓存）' : '分类器判定：执行类（缓存）' };
  }

  // 分类器：用 executor 分类（最便宜）。executor 与当前模型可能分属不同服务商，
  // 需按 executor 解析其 provider（评估 P2-2：硬编码模型名在自定义网关上会 404 静默失败）
  const { resolveProviderConfig, createProvider } = await import('./providers/index.js');
  let classifierProvider = provider;
  try {
    const curPc = resolveProviderConfig(cfg, currentModel);
    const execPc = resolveProviderConfig(cfg, rc.executor);
    if (curPc.name !== execPc.name) classifierProvider = await createProvider(cfg, rc.executor);
  } catch (/** @type {any} */ e) {
    // 审计 BUG-044：此前是 `catch {}`，构建分类器 provider 失败时静默用当前 provider，
    // 用户只看得到「回退执行模型」，查不出是配置还是额度问题。
    routeWarn(`分类器 provider 构建失败（继续用当前 provider）：${String(e?.message ?? e).slice(0, 120)}`);
  }
  const classifyStartAt = Date.now(); // 审计 BUG-048：峰谷价锚点 = 请求发起时刻
  try {
    const res = await classifierProvider.chat({
      model: rc.executor,
      messages: [
        {
          role: 'system',
          content:
            '你是任务分类器。判断用户请求属于哪类：plan（需要设计、规划、分析、审查、多步推理，或需要生成大段代码/文档/页面等长输出）或 execute（直接执行、简单问答、小改动）。只输出 JSON：{"verdict":"plan"} 或 {"verdict":"execute"}。',
        },
        { role: 'user', content: String(text).slice(0, 4000) },
      ],
      tools: [],
      temperature: 0,
      maxTokens: 20, // 结构化输出（评估 4.2-4）：80→20
      reasoningEffort: 'low',
      responseFormat: { type: 'json_object' },
    });
    recordAuxUsage(rc.executor, res?.usage, 'route-classify', { requestStartAt: classifyStartAt }); // v0.4.7：分类器消耗入账
    let verdict = null;
    try {
      const j = JSON.parse(String(res.text || '').trim());
      if (j?.verdict === 'plan' || j?.verdict === 'execute') verdict = j.verdict;
    } catch {}
    if (!verdict) {
      // 正文为空/非 JSON 时用推理内容兜底（flash 可能先输出 reasoning 再输出正文）
      const t = String(res.text || res.reasoning || '').trim().toLowerCase();
      if (t.includes('plan')) verdict = 'plan';
      else if (t.includes('exec')) verdict = 'execute';
    }
    if (!verdict) {
      // 第三态（Kimi C2）：分类器给不出结论 → 保守走 planner，避免复杂任务被 flash 硬扛
      const m = rc.planner;
      return m === currentModel ? { model: currentModel, reason: null } : { model: m, reason: '分类器不确定：保守走 planner' };
    }
    if (verdict) {
      if (routeCache.size >= ROUTE_CACHE_MAX) {
        const first = routeCache.keys().next().value;
        routeCache.delete(first);
      }
      routeCache.set(key, verdict);
      const m = verdict === 'plan' ? rc.planner : rc.executor;
      return m === currentModel ? { model: currentModel, reason: null } : { model: m, reason: verdict === 'plan' ? '分类器判定：规划类' : '分类器判定：执行类' };
    }
  } catch (/** @type {any} */ err) {
    // 分类失败回退执行模型（审计 BUG-044）：把失败原因带进 `reason`，
    // 否则调用方无法区分「分类器不确定」与「分类器调用失败」（实测后者 console 输出 0 条）。
    const why = String(err?.message ?? err).slice(0, 120);
    routeWarn(`路由分类器调用失败，回退执行模型：${why}`);
    return rc.executor === currentModel
      ? { model: currentModel, reason: `分类器失败：${why}` }
      : { model: rc.executor, reason: `回退执行模型（分类器失败：${why}）` };
  }
  return rc.executor === currentModel ? { model: currentModel, reason: null } : { model: rc.executor, reason: '回退执行模型' };
}

// 子代理模型选择：路由开启时固定 executor——但当前模型不在路由池（如本地/自定义模型）时
// 必须跟随当前模型，否则子代理会把 executor 模型名（deepseek-v4-flash）发到当前模型的 baseUrl
// （本地 8081），服务端不认识 → 400 → 子代理全灭，表现为主线程「子代理无反馈」。
export function subagentModel(/** @type {any} */ cfg, /** @type {any} */ currentModel) {
  const rc = routingConfig(cfg);
  if (!rc) return currentModel;
  // v0.4.1 修复：与 routeTask 的池外检查一致——当前模型不在 planner/executor 池内时不干预。
  // v0.6.2：同样走 canonicalModel，否则旧名配置会被误判成池外（见 models.js#canonicalModel）。
  const cur = canonicalModel(currentModel);
  if (cur !== canonicalModel(rc.planner) && cur !== canonicalModel(rc.executor)) return currentModel;
  return modelPreset(rc.executor) ? rc.executor : currentModel;
}
