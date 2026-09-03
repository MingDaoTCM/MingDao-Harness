// 省钱基准（v0.3.0 P0-1）：把「MingDao 比裸调 DeepSeek API 省 X%」变成可复现、可回归的断言。
// 离线零 API 成本：全部用内置计价/词表/schema 函数做「朴素基线 vs MingDao 优化」对照。
// 与其它 bench 分工：bench-cost 测 token 数与拦截；bench-savings 测「钱」的节省口径 + 汇总基线。
// 运行：node test/bench/bench-savings.mjs
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const { estimateCost, estimateBatchCost, BATCH_DISCOUNT } = await import(pathToFileURL(path.join(srcDir, 'pricing.js')).href);
const { approxTokens, clampText, TOOL_RESULT_LIMIT } = await import(pathToFileURL(path.join(srcDir, 'context.js')).href);
const { toolSchemas, buildToolSchemas } = await import(pathToFileURL(path.join(srcDir, 'tools', 'index.js')).href);
const { countTokens, heuristicTokens } = await import(pathToFileURL(path.join(srcDir, 'tokenizer.js')).href);
const { modelPreset } = await import(pathToFileURL(path.join(srcDir, 'models.js')).href);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  ✖', msg); } };
const pct = (n) => (100 - n * 100).toFixed(1) + '%'; // 省下的百分比
const OFFPEAK = new Date('2026-08-15T04:00:00Z'); // 周六 12:00 北京时间，恒为闲时
const PEAK = new Date('2026-09-02T02:00:00Z'); // 周三 10:00 北京时间，恒为高峰

const report = [];

// ---------- 任务 1：缓存命中计价（命中价 1/30） ----------
{
  const P = 100000, C = 1000, HIT = 90000, MISS = 10000; // 90% 命中
  const naive = estimateCost('deepseek-v4-flash', P, C, null, OFFPEAK); // 全未命中
  const md = estimateCost('deepseek-v4-flash', P, C, { hit: HIT, miss: MISS }, OFFPEAK);
  ok(md < naive * 0.3, `缓存命中 90% 应省 >70%（省 ${pct(md / naive)}）`);
  ok(naive > 0 && md > 0, '费用应为正');
  report.push(['缓存命中计价（90%命中）', pct(md / naive)]);
  console.log(`  ① 缓存命中计价：朴素 ¥${naive.toFixed(5)} → MingDao ¥${md.toFixed(5)}，省 ${pct(md / naive)}`);
}

// ---------- 任务 2：峰谷避峰（闲时半价） ----------
{
  const P = 10000, C = 1000;
  const peak = estimateCost('deepseek-v4-pro', P, C, null, PEAK);
  const off = estimateCost('deepseek-v4-pro', P, C, null, OFFPEAK);
  ok(Math.abs(off - peak * 0.5) < 1e-9, `闲时应恰为高峰半价（${off} vs ${peak}）`);
  report.push(['峰谷避峰（闲时半价）', pct(off / peak)]);
  console.log(`  ② 峰谷避峰：高峰 ¥${peak.toFixed(5)} → 闲时 ¥${off.toFixed(5)}，省 ${pct(off / peak)}`);
}

// ---------- 任务 3：Batch 半价 ----------
{
  const P = 1000, C = 100;
  ok(BATCH_DISCOUNT === 0.5, 'BATCH_DISCOUNT 应为 0.5');
  const full = estimateCost('deepseek-v4-flash', P, C, null, OFFPEAK);
  const batch = estimateBatchCost('deepseek-v4-flash', P, C);
  ok(Math.abs(batch - full * 0.5) < 1e-9, `Batch 应恰为闲时全价一半（${batch} vs ${full}）`);
  report.push(['Batch 半价', pct(batch / full)]);
  console.log(`  ③ Batch 半价：标准 ¥${full.toFixed(6)} → Batch ¥${batch.toFixed(6)}，省 ${pct(batch / full)}`);
}

// ---------- 任务 4：工具 Schema 瘦身（已用工具剥描述） ----------
{
  const full = toolSchemas();
  const fullTok = approxTokens(JSON.stringify(full));
  const stripped = buildToolSchemas(new Set(full.map((t) => t.function.name)));
  const strippedTok = approxTokens(JSON.stringify(stripped));
  const inputPrice = 1.5 / 1e6; // flash 闲时输入价（元/token）
  const saved = (fullTok - strippedTok) * inputPrice;
  ok(strippedTok <= fullTok * 0.6, `全剥后应 ≤60%（实际 ${((strippedTok / fullTok) * 100).toFixed(1)}%）`);
  report.push(['工具 Schema 瘦身', pct(strippedTok / fullTok)]);
  console.log(`  ④ Schema 瘦身：${fullTok}→${strippedTok} tokens，每轮省 ≈¥${saved.toFixed(5)}（省 ${pct(strippedTok / fullTok)}）`);
}

// ---------- 任务 5：只读阶段收缩（只读工具子集） ----------
{
  const full = toolSchemas();
  const fullTok = approxTokens(JSON.stringify(full));
  const RO = new Set(['read', 'ls', 'glob', 'grep', 'skill', 'todo']);
  const tier = full.filter((t) => RO.has(t.function.name));
  const tierTok = approxTokens(JSON.stringify(tier));
  ok(tierTok <= fullTok * 0.55, `只读档应 ≤55% 全量（实际 ${((tierTok / fullTok) * 100).toFixed(1)}%）`);
  report.push(['只读阶段收缩', pct(tierTok / fullTok)]);
  console.log(`  ⑤ 只读阶段：${fullTok}→${tierTok} tokens，省 ${pct(tierTok / fullTok)}`);
}

// ---------- 任务 6：工具结果截断（clampText 上限） ----------
{
  const long = ('日志输出行内容填充。'.repeat(40) + '\n').repeat(600); // ≈ 6 万字符
  const clamped = clampText(long);
  const origTok = approxTokens(long);
  const clampTok = approxTokens(clamped);
  ok(clamped.length <= TOOL_RESULT_LIMIT + 64, `截断后应 ≤${TOOL_RESULT_LIMIT}+64 字符（正文+截断标记，实际 ${clamped.length}）`);
  ok(clampTok <= origTok * 0.6, `工具结果截断应省 ≥40% token（省 ${pct(clampTok / origTok)}）`);
  report.push(['工具结果截断', pct(clampTok / origTok)]);
  console.log(`  ⑥ 工具结果截断：${origTok}→${clampTok} tokens，省 ${pct(clampTok / origTok)}`);
}

// ---------- 任务 7：精确 tokenizer 不虚高（启发式为上界，不反向多计） ----------
{
  const text = '人工智能正在改变世界，MingDao 让每个人都拥有自己的智能体。MCP 连接外部工具，tokenizer 精确计量，WebUI 开箱即用。'.repeat(20);
  const exact = countTokens(text, 'deepseek-v4-flash');
  const heur = heuristicTokens(text);
  ok(exact > 0 && heur > 0, '两种计数都应为正');
  // 启发式是保守上界（CJK 0.75 token/字），不应低于精确值（低于=反向虚低、可能漏计费）
  ok(heur >= exact, `启发式应为上界（exact ${exact} ≤ heuristic ${heur}）`);
  report.push(['精确 tokenizer 不虚高', '—']);
  console.log(`  ⑦ 精确 tokenizer：exact ${exact} ≤ heuristic ${heur}（不虚高、不漏计）`);
}

// ---------- 任务 8：推理分级能力契约（pro 支持、flash 不支持） ----------
{
  const pro = modelPreset('deepseek-v4-pro');
  const flash = modelPreset('deepseek-v4-flash');
  ok(Boolean(pro?.supportsReasoning), 'pro 应支持 reasoning');
  ok(Array.isArray(pro?.reasoningEffort?.options) && ['low', 'high', 'max'].every((x) => pro.reasoningEffort.options.includes(x)), 'pro 推理档位 low/high/max');
  ok(flash?.supportsReasoning === false, 'flash 应不支持 reasoning（省推理开关契约）');
  report.push(['推理分级能力契约', '—']);
  console.log('  ⑧ 推理分级契约：pro 支持 low/high/max（off 可关）；flash 不发送 reasoning_effort');
}

// ---------- 汇总 ----------
const money = report.filter(([n]) => n !== '精确 tokenizer 不虚高' && n !== '推理分级能力契约');
const avgSave = money.length ? (money.reduce((a, [, s]) => a + (parseFloat(s) === parseFloat(s) ? parseFloat(s) : 0), 0) / money.length) : 0;
console.log('\n  综合（可叠加省钱杠杆的简单平均，非同时生效叠加）：省 ' + avgSave.toFixed(0) + '%');
console.log(`\nsavings 基准：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
