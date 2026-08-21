// 自动模型路由：规划类任务 → planner（如 deepseek-v4-pro），执行类 → executor（如 deepseek-v4-flash）。
// 两级判定：
//   1. 启发式：长文本 + 规划关键词 → planner；极短指令 → executor（零成本）
//   2. 分类器：用 executor 模型做一次极简分类（成本约几十 token）
// 子代理（task）固定走 executor（子任务以执行/调研为主，便宜又够用）。

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

export function heuristicRoute(text, rc) {
  const s = String(text ?? '');
  if (s.length >= 40 && PLAN_HINTS.test(s)) return rc.planner;
  if (s.length <= 60) return rc.executor;
  return null; // 需要分类器
}

export async function routeTask({ cfg, provider, currentModel, text }) {
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

  // 分类器：用 executor 分类（最便宜）
  try {
    const res = await provider.chat({
      model: rc.executor,
      messages: [
        {
          role: 'system',
          content:
            '你是任务分类器。判断用户请求属于哪类，只输出一个词：plan（需要设计、规划、分析、审查、多步推理）或 execute（直接执行、简单问答、小改动）。',
        },
        { role: 'user', content: String(text).slice(0, 4000) },
      ],
      tools: [],
      temperature: 0,
      maxTokens: 80, // 推理内容会占用 max_tokens，留足余量
    });
    // 正文为空时用推理内容兜底（flash 可能先输出 reasoning 再输出正文）
    const t = String(res.text || res.reasoning || '').trim().toLowerCase();
    if (t.includes('plan')) return rc.planner === currentModel ? { model: currentModel, reason: null } : { model: rc.planner, reason: '分类器判定：规划类' };
    if (t.includes('exec')) return rc.executor === currentModel ? { model: currentModel, reason: null } : { model: rc.executor, reason: '分类器判定：执行类' };
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
