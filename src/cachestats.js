// 缓存命中统计：记录每次用量的缓存命中/未命中，支撑「缓存命中率仪表盘」。
// 落盘 <home>/cache-stats.jsonl，每行：{at, model, prompt, completion, hit, miss, cost, saved}

import fs from 'node:fs';
import path from 'node:path';
import { mingdaoHome, ensureHome } from './config.js';
import { estimateCost, cacheSplit, beijingDayStart, beijingParts } from './pricing.js';
import { modelPreset } from './models.js';

export function cacheStatsFile() {
  return path.join(mingdaoHome(), 'cache-stats.jsonl');
}

// 内存计数 + 低频轮转（评估 P3-3：此前无限增长且每次全量解析）
const MAX_LINES = 20000;
const KEEP_LINES = 10000;
let cacheStatsCount = 0;

export function recordCacheStats(/** @type {any} */ entry) {
  try {
    ensureHome(); // 审计 B10：与 audit/journal 一致，目录缺失不静默丢统计
    const line = JSON.stringify({
      at: Date.now(),
      model: entry.model || '',
      prompt: entry.prompt || 0,
      completion: entry.completion || 0,
      hit: entry.hit ?? null,
      miss: entry.miss ?? null,
      cost: entry.cost ?? null,
      saved: entry.saved ?? null,
      batch: entry.batch === true ? true : undefined, // Batch API 半价任务标记（/cost 分账展示）
      steps: entry.steps ?? undefined, // 本回合步数（状态栏 步数统计）
      llmMs: entry.llmMs ?? undefined, // 模型调用总耗时（状态栏 LLM 时长/tok-s）
      toolMs: entry.toolMs ?? undefined, // 工具执行总耗时（状态栏 工具调用时长）
      firstTokenMs: entry.firstTokenMs ?? undefined, // 首 token 延迟（状态栏平均首 token）
      reasoning: entry.reasoning ?? undefined, // 省钱 B3：推理 token 估算（费用二级分账维度）
      byTool: Array.isArray(entry.byTool) ? entry.byTool : undefined, // 省钱 B3：逐工具 {tool,calls,ms}
    });
    fs.appendFileSync(cacheStatsFile(), line + '\n');
    cacheStatsCount += 1;
  } catch {}
  if (cacheStatsCount > MAX_LINES && cacheStatsCount % 200 === 0) {
    try {
      const raw = fs.readFileSync(cacheStatsFile(), 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      if (lines.length > MAX_LINES) {
        fs.writeFileSync(cacheStatsFile(), lines.slice(-KEEP_LINES).join('\n') + '\n');
        cacheStatsCount = KEEP_LINES;
      }
    } catch {}
  }
}

// listCacheStats 读取缓存（审计：costGuard 每步 / WebUI 每 15s / /cost 命令都调用——
// 四报告共识 P2-2/§3.3-A：全文件读+逐行 parse 会随 JSONL 增长线性放大 IO。
// 按 mtimeMs+size 双键缓存；写入追加会改两者，轮转重写同样改，缓存自动失效）
let /** @type {any} */ _statsCache = null;

export function listCacheStats(limit = 2000) {
  try {
    const file = cacheStatsFile();
    const st = fs.statSync(file);
    if (!/** @type {any} */ _statsCache || _statsCache.mtimeMs !== st.mtimeMs || _statsCache.size !== st.size || _statsCache.limit < limit) {
      const raw = fs.readFileSync(file, 'utf8');
      const out = [];
      for (const l of raw.split('\n')) {
        if (!l.trim()) continue;
        try {
          out.push(JSON.parse(l));
        } catch {}
      }
      _statsCache = { mtimeMs: st.mtimeMs, size: st.size, limit, lines: out };
    }
    return _statsCache.lines.slice(-limit);
  } catch {
    return [];
  }
}

export function summarizeCacheStats(/** @type {any} */ entries) {
  const sum = /** @type {any} */ ({ turns: entries.length, prompt: 0, completion: 0, hit: 0, miss: 0, cost: 0, saved: 0, steps: 0, llmMs: 0, toolMs: 0, firstTokenCount: 0, firstTokenSumMs: 0 });
  for (const e of entries) {
    sum.prompt += e.prompt || 0;
    sum.completion += e.completion || 0;
    sum.hit += e.hit || 0;
    sum.miss += e.miss || 0;
    sum.cost += e.cost || 0;
    sum.saved += e.saved || 0;
    sum.steps += e.steps || 0;
    sum.llmMs += e.llmMs || 0;
    sum.toolMs += e.toolMs || 0;
    if (e.firstTokenMs != null) {
      sum.firstTokenCount += 1;
      sum.firstTokenSumMs += e.firstTokenMs;
    }
  }
  sum.rate = sum.hit + sum.miss > 0 ? sum.hit / (sum.hit + sum.miss) : null;
  sum.firstTokenAvgMs = sum.firstTokenCount > 0 ? sum.firstTokenSumMs / sum.firstTokenCount : null;
  sum.tokensPerSec = sum.llmMs > 0 ? (sum.completion / (sum.llmMs / 1000)) : null;
  return sum;
}

// 记录一次用量（agent 侧调用）：自动计算命中拆分与节省额
// 记录一次用量（agent 侧调用）：自动计算命中拆分与节省额；perf 为回合性能指标（状态栏）
export function recordUsage(/** @type {any} */ modelName, /** @type {any} */ usage, /** @type {any} */ perf = null) {
  const split = cacheSplit(usage);
  const prompt = usage?.prompt_tokens || 0;
  const completion = usage?.completion_tokens || 0;
  let cost = null;
  let saved = null;
  if (split) {
    cost = estimateCost(modelName, prompt, completion, split);
    saved = estimateCost(modelName, prompt, completion, null) - cost;
  } else if (modelPreset(modelName)?.pricing) {
    // 审计 B10：无缓存字段时按全未命中估算（不再计 0 元，费用护栏口径更真实）
    cost = estimateCost(modelName, prompt, completion, null);
  }
  recordCacheStats({
    model: modelName,
    prompt,
    completion,
    hit: split?.hit ?? null,
    miss: split?.miss ?? null,
    cost,
    saved,
    steps: perf?.steps ?? undefined,
    llmMs: perf?.llmMs ?? undefined,
    toolMs: perf?.toolMs ?? undefined,
    firstTokenMs: perf?.firstTokenMs ?? undefined,
    reasoning: perf?.reasoningTokens ?? undefined, // 省钱 B3
    byTool: perf?.toolStats ?? undefined, // 省钱 B3
  });
}

export function formatCacheSummary(/** @type {any} */ sum) {
  const fmt = (/** @type {any} */ n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  const lines = [
    `轮次  ${sum.turns} · ↑${fmt(sum.prompt)} ↓${fmt(sum.completion)} tokens`,
    `缓存命中率  ${sum.rate != null ? (sum.rate * 100).toFixed(0) + '%' : '暂无缓存数据'}`,
    `实际费用  ≈¥${sum.cost.toFixed(5)} · 相比全未命中节省 ≈¥${sum.saved.toFixed(5)}`,
  ];
  return lines;
}

// 分账统计（评估 /cost 升级）：按模型分账、今日费用、batch 半价任务、节省归因
// 省钱 B3：新增 reasoning 维度、byTool 逐工具累加、byDay 近 14 天按日折线数据
export function costBreakdown() {
  const entries = listCacheStats(100000);
  const byModel = new Map();
  const byTool = /** @type {Map<string, {calls: number, ms: number}>} */ (new Map());
  const byDay = /** @type {Map<string, number>} */ (new Map()); // 'MM-DD' → cost（近 14 个北京日，含 0 值日）
  const start = beijingDayStart().getTime();
  let totalCost = 0;
  let totalSaved = 0;
  let today = 0;
  let batchCost = 0;
  let hit = 0;
  let miss = 0;
  let reasoning = 0;
  for (const e of entries) {
    totalCost += e.cost || 0;
    totalSaved += e.saved || 0;
    hit += e.hit || 0;
    miss += e.miss || 0;
    reasoning += e.reasoning || 0;
    if (e.batch) batchCost += e.cost || 0;
    if (e.at >= start) today += e.cost || 0;
    const m = byModel.get(e.model) || { prompt: 0, completion: 0, cost: 0, saved: 0, turns: 0, batchTurns: 0, reasoning: 0 };
    m.prompt += e.prompt || 0;
    m.completion += e.completion || 0;
    m.cost += e.cost || 0;
    m.saved += e.saved || 0;
    m.turns += 1;
    m.reasoning += e.reasoning || 0;
    if (e.batch) m.batchTurns += 1;
    byModel.set(e.model, m);
    if (Array.isArray(e.byTool)) {
      for (const t of e.byTool) {
        const tt = byTool.get(t.tool) || { calls: 0, ms: 0 };
        tt.calls += t.calls || 0;
        tt.ms += t.ms || 0;
        byTool.set(t.tool, tt);
      }
    }
    if (e.at) {
      const p = beijingParts(new Date(e.at));
      const key = `${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
      byDay.set(key, (byDay.get(key) || 0) + (e.cost || 0));
    }
  }
  // 补全近 14 天（含无记录的 0 值日），保证折线 x 轴连续
  const days = /** @type {Array<{day: string, cost: number}>} */ ([]);
  for (let i = 13; i >= 0; i--) {
    const d = new Date(start - i * 86400000);
    const p = beijingParts(d);
    const key = `${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    days.push({ day: key, cost: byDay.get(key) || 0 });
  }
  return {
    totalCost,
    totalSaved,
    today,
    batchCost,
    hit,
    miss,
    rate: hit + miss > 0 ? hit / (hit + miss) : null,
    reasoning,
    byModel: [...byModel.entries()].map(([model, m]) => ({ model, ...m })).sort((a, b) => b.cost - a.cost),
    byTool: [...byTool.entries()].map(([tool, t]) => ({ tool, ...t })).sort((a, b) => b.ms - a.ms),
    byDay: days,
  };
}

// 月度费用报告（/cost 导出）：按北京时间月份聚合，month 形如 'YYYY-MM'，缺省返回全部月份
// 省钱 B3：月度聚合增加 reasoning 与 byTool 维度
export function costMonthlyReport(/** @type {any} */ month) {
  const entries = listCacheStats(100000);
  const want = String(month || '').trim();
  const months = new Map();
  for (const e of entries) {
    const p = beijingParts(new Date(e.at));
    const key = `${p.year}-${String(p.month).padStart(2, '0')}`;
    if (want && key !== want) continue;
    let m = months.get(key);
    if (!m) {
      m = { month: key, cost: 0, saved: 0, prompt: 0, completion: 0, hit: 0, miss: 0, batchCost: 0, reasoning: 0, days: new Map(), models: new Map(), tools: new Map() };
      months.set(key, m);
    }
    m.cost += e.cost || 0;
    m.saved += e.saved || 0;
    m.prompt += e.prompt || 0;
    m.completion += e.completion || 0;
    m.hit += e.hit || 0;
    m.miss += e.miss || 0;
    m.reasoning += e.reasoning || 0;
    if (e.batch) m.batchCost += e.cost || 0;
    const day = String(p.day).padStart(2, '0');
    m.days.set(day, (m.days.get(day) || 0) + (e.cost || 0));
    const mm = m.models.get(e.model) || { prompt: 0, completion: 0, cost: 0, turns: 0 };
    mm.prompt += e.prompt || 0;
    mm.completion += e.completion || 0;
    mm.cost += e.cost || 0;
    mm.turns += 1;
    m.models.set(e.model, mm);
    if (Array.isArray(e.byTool)) {
      for (const t of e.byTool) {
        const tt = m.tools.get(t.tool) || { calls: 0, ms: 0 };
        tt.calls += t.calls || 0;
        tt.ms += t.ms || 0;
        m.tools.set(t.tool, tt);
      }
    }
  }
  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({
      month: m.month,
      cost: m.cost,
      saved: m.saved,
      prompt: m.prompt,
      completion: m.completion,
      hit: m.hit,
      miss: m.miss,
      rate: m.hit + m.miss > 0 ? m.hit / (m.hit + m.miss) : null,
      batchCost: m.batchCost,
      reasoning: m.reasoning,
      days: [...m.days.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, cost]) => ({ day, cost })),
      models: [...m.models.entries()].map(([model, x]) => ({ model, ...x })).sort((a, b) => b.cost - a.cost),
      tools: [...m.tools.entries()].map(([tool, t]) => ({ tool, ...t })).sort((a, b) => b.ms - a.ms),
    }));
}
