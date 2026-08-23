// 缓存命中统计：记录每次用量的缓存命中/未命中，支撑「缓存命中率仪表盘」。
// 落盘 <home>/cache-stats.jsonl，每行：{at, model, prompt, completion, hit, miss, cost, saved}

import fs from 'node:fs';
import path from 'node:path';
import { mingdaoHome } from './config.js';
import { estimateCost, cacheSplit, beijingDayStart, beijingParts } from './pricing.js';

export function cacheStatsFile() {
  return path.join(mingdaoHome(), 'cache-stats.jsonl');
}

// 内存计数 + 低频轮转（评估 P3-3：此前无限增长且每次全量解析）
const MAX_LINES = 20000;
const KEEP_LINES = 10000;
let cacheStatsCount = 0;

export function recordCacheStats(entry) {
  try {
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

export function listCacheStats(limit = 2000) {
  try {
    const raw = fs.readFileSync(cacheStatsFile(), 'utf8');
    const out = [];
    for (const l of raw.split('\n')) {
      if (!l.trim()) continue;
      try {
        out.push(JSON.parse(l));
      } catch {}
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

export function summarizeCacheStats(entries) {
  const sum = { turns: entries.length, prompt: 0, completion: 0, hit: 0, miss: 0, cost: 0, saved: 0 };
  for (const e of entries) {
    sum.prompt += e.prompt || 0;
    sum.completion += e.completion || 0;
    sum.hit += e.hit || 0;
    sum.miss += e.miss || 0;
    sum.cost += e.cost || 0;
    sum.saved += e.saved || 0;
  }
  sum.rate = sum.hit + sum.miss > 0 ? sum.hit / (sum.hit + sum.miss) : null;
  return sum;
}

// 记录一次用量（agent 侧调用）：自动计算命中拆分与节省额
export function recordUsage(modelName, usage) {
  const split = cacheSplit(usage);
  const prompt = usage?.prompt_tokens || 0;
  const completion = usage?.completion_tokens || 0;
  let cost = null;
  let saved = null;
  if (split) {
    cost = estimateCost(modelName, prompt, completion, split);
    saved = estimateCost(modelName, prompt, completion, null) - cost;
  }
  recordCacheStats({ model: modelName, prompt, completion, hit: split?.hit ?? null, miss: split?.miss ?? null, cost, saved });
}

export function formatCacheSummary(sum) {
  const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  const lines = [
    `轮次  ${sum.turns} · ↑${fmt(sum.prompt)} ↓${fmt(sum.completion)} tokens`,
    `缓存命中率  ${sum.rate != null ? (sum.rate * 100).toFixed(0) + '%' : '暂无缓存数据'}`,
    `实际费用  ≈¥${sum.cost.toFixed(5)} · 相比全未命中节省 ≈¥${sum.saved.toFixed(5)}`,
  ];
  return lines;
}

// 分账统计（评估 /cost 升级）：按模型分账、今日费用、batch 半价任务、节省归因
export function costBreakdown() {
  const entries = listCacheStats(100000);
  const byModel = new Map();
  const start = beijingDayStart().getTime();
  let totalCost = 0;
  let totalSaved = 0;
  let today = 0;
  let batchCost = 0;
  let hit = 0;
  let miss = 0;
  for (const e of entries) {
    totalCost += e.cost || 0;
    totalSaved += e.saved || 0;
    hit += e.hit || 0;
    miss += e.miss || 0;
    if (e.batch) batchCost += e.cost || 0;
    if (e.at >= start) today += e.cost || 0;
    const m = byModel.get(e.model) || { prompt: 0, completion: 0, cost: 0, saved: 0, turns: 0, batchTurns: 0 };
    m.prompt += e.prompt || 0;
    m.completion += e.completion || 0;
    m.cost += e.cost || 0;
    m.saved += e.saved || 0;
    m.turns += 1;
    if (e.batch) m.batchTurns += 1;
    byModel.set(e.model, m);
  }
  return {
    totalCost,
    totalSaved,
    today,
    batchCost,
    hit,
    miss,
    rate: hit + miss > 0 ? hit / (hit + miss) : null,
    byModel: [...byModel.entries()].map(([model, m]) => ({ model, ...m })).sort((a, b) => b.cost - a.cost),
  };
}

// 月度费用报告（/cost 导出）：按北京时间月份聚合，month 形如 'YYYY-MM'，缺省返回全部月份
export function costMonthlyReport(month) {
  const entries = listCacheStats(100000);
  const want = String(month || '').trim();
  const months = new Map();
  for (const e of entries) {
    const p = beijingParts(new Date(e.at));
    const key = `${p.year}-${String(p.month).padStart(2, '0')}`;
    if (want && key !== want) continue;
    let m = months.get(key);
    if (!m) {
      m = { month: key, cost: 0, saved: 0, prompt: 0, completion: 0, hit: 0, miss: 0, batchCost: 0, days: new Map(), models: new Map() };
      months.set(key, m);
    }
    m.cost += e.cost || 0;
    m.saved += e.saved || 0;
    m.prompt += e.prompt || 0;
    m.completion += e.completion || 0;
    m.hit += e.hit || 0;
    m.miss += e.miss || 0;
    if (e.batch) m.batchCost += e.cost || 0;
    const day = String(p.day).padStart(2, '0');
    m.days.set(day, (m.days.get(day) || 0) + (e.cost || 0));
    const mm = m.models.get(e.model) || { prompt: 0, completion: 0, cost: 0, turns: 0 };
    mm.prompt += e.prompt || 0;
    mm.completion += e.completion || 0;
    mm.cost += e.cost || 0;
    mm.turns += 1;
    m.models.set(e.model, mm);
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
      days: [...m.days.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, cost]) => ({ day, cost })),
      models: [...m.models.entries()].map(([model, x]) => ({ model, ...x })).sort((a, b) => b.cost - a.cost),
    }));
}
