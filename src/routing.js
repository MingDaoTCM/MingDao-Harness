// 自动模型路由：规划类任务 → planner（如 deepseek-v4-pro），执行类 → executor（如 deepseek-v4-flash）。
// 两级判定：
//   1. 启发式：长文本 + 规划关键词 → planner；极短指令 → executor（零成本）
//   2. 分类器：用 executor 模型做一次极简分类（成本约几十 token；结果按文本哈希 LRU 缓存）
// 会话粘滞（评估 P2-1/B7）：执行类会话连续保持 executor，不再逐轮分类，也避免 pro⇄flash
// 抖动反复破坏上下文缓存前缀（除非出现生成类关键词——启发式已优先处理）。
// 子代理（task）固定走 executor（子任务以执行/调研为主，便宜又够用）。

import crypto from 'node:crypto';
import { modelPreset } from './models.js';

export function routingConfig(cfg) {
  const r = cfg?.routing;
  if (!r || r.enabled === false) return null;
  const planner = r.planner || 'deepseek-v4-pro';
  const executor = r.executor || 'deepseek-v4-flash';
  if (!planner || !executor || planner === executor) return null;
  return { planner, executor };
}

const PLAN_HINTS =
  /设计|架构|重构|审查|规划|分析|方案|评估|优化|排查|疑难|设计模式|选型|技术债|roadmap|review|design|refactor|plan|architecture|方案设计|评审/;

// 生成类任务（游戏/网页/文档等）需要大输出（planner 32K vs executor 8K），即使短句也路由 planner
const GENERATION_HINTS =
  /(生成|制作|编写|创建|写|开发|实现|做).{0,30}(游戏|网页|页面|网站|应用|程序|文档|报告|简历|PPT|演示|完整|详细|小工具)|网页版|游戏/;

export function heuristicRoute(text, rc) {
  const s = String(text ?? '');
  if (GENERATION_HINTS.test(s)) return rc.planner; // 生成类：大输出优先
  if (s.length >= 40 && PLAN_HINTS.test(s)) return rc.planner;
  if (s.length <= 60) return rc.executor;
  return null; // 需要分类器
}

// 分类结果缓存：文本 sha256 → 结论（同一问题反复问/粘贴同一报错不再重复分类）
const ROUTE_CACHE_MAX = 100;
const routeCache = new Map();

export async function routeTask({ cfg, provider, currentModel, text, sticky = null }) {
  const rc = routingConfig(cfg);
  if (!rc) return { model: currentModel, reason: null };
  // 当前模型已在路由池外（用户手动指定）：不干预
  if (currentModel !== rc.planner && currentModel !== rc.executor) {
    return { model: currentModel, reason: null };
  }

  const quick = heuristicRoute(text, rc);
  if (quick) {
    return quick === currentModel
      ? { model: currentModel, reason: null }
      : { model: quick, reason: quick === rc.planner ? '规划类任务' : '执行类任务' };
  }

  // 会话粘滞：执行类会话不再逐轮分类（生成类关键词已在启发式拦截）
  if (sticky === rc.executor) {
    return rc.executor === currentModel
      ? { model: currentModel, reason: null }
      : { model: rc.executor, reason: '会话粘滞：执行类' };
  }

  // 分类缓存
  const key = crypto.createHash('sha256').update(String(text).slice(0, 4000)).digest('hex');
  const cached = routeCache.get(key);
  if (cached) {
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
  } catch {}
  try {
    const res = await classifierProvider.chat({
      model: rc.executor,
      messages: [
        {
          role: 'system',
          content:
            '你是任务分类器。判断用户请求属于哪类，只输出一个词：plan（需要设计、规划、分析、审查、多步推理，或需要生成大段代码/文档/页面等长输出）或 execute（直接执行、简单问答、小改动）。',
        },
        { role: 'user', content: String(text).slice(0, 4000) },
      ],
      tools: [],
      temperature: 0,
      maxTokens: 80, // 推理内容会占用 max_tokens，留足余量
    });
    // 正文为空时用推理内容兜底（flash 可能先输出 reasoning 再输出正文）
    const t = String(res.text || res.reasoning || '').trim().toLowerCase();
    let verdict = null;
    if (t.includes('plan')) verdict = 'plan';
    else if (t.includes('exec')) verdict = 'execute';
    if (verdict) {
      if (routeCache.size >= ROUTE_CACHE_MAX) {
        const first = routeCache.keys().next().value;
        routeCache.delete(first);
      }
      routeCache.set(key, verdict);
      const m = verdict === 'plan' ? rc.planner : rc.executor;
      return m === currentModel ? { model: currentModel, reason: null } : { model: m, reason: verdict === 'plan' ? '分类器判定：规划类' : '分类器判定：执行类' };
    }
  } catch {
    // 分类失败回退执行模型
  }
  return rc.executor === currentModel ? { model: currentModel, reason: null } : { model: rc.executor, reason: '回退执行模型' };
}

// 子代理模型选择：路由开启时固定 executor
export function subagentModel(cfg, currentModel) {
  const rc = routingConfig(cfg);
  if (!rc) return currentModel;
  return modelPreset(rc.executor) ? rc.executor : currentModel;
}
