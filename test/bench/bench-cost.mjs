// 费用基准（Phase C A3）：mock 模型费用对照，零 API 成本。
// 覆盖：工具 Schema 瘦身收益（全量/全剥/只读档 token 数）、A1 两态冻结（回合内 ≤2 个 payload、
// 跨回合才剥描述）、护栏前置拦截（超限请求不发出）、Batch 半价。
// 运行：node test/bench/bench-cost.mjs
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const { toolSchemas, buildToolSchemas } = await import(pathToFileURL(path.join(srcDir, 'tools', 'index.js')).href);
const { approxTokens } = await import(pathToFileURL(path.join(srcDir, 'context.js')).href);
const { estimateBatchCost, BATCH_DISCOUNT, estimateCost } = await import(pathToFileURL(path.join(srcDir, 'pricing.js')).href);
const { createAgent } = await import(pathToFileURL(path.join(srcDir, 'agent.js')).href);
const { createIO } = await import(pathToFileURL(path.join(srcDir, 'ui.js')).href);
const { saveConfig } = await import(pathToFileURL(path.join(srcDir, 'config.js')).href);
const { recordUsage } = await import(pathToFileURL(path.join(srcDir, 'cachestats.js')).href);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  ✖', msg); } };

// ---------- 1. Schema 瘦身收益（token 口径） ----------
{
  const full = toolSchemas();
  const fullTokens = approxTokens(JSON.stringify(full));
  const usedAll = new Set(full.map((t) => t.function.name));
  const stripped = buildToolSchemas(usedAll);
  const strippedTokens = approxTokens(JSON.stringify(stripped));
  ok(fullTokens > 900, `全量 schema 应 >900 tokens（实际 ${fullTokens}）`);
  ok(strippedTokens <= fullTokens * 0.6, `全剥后应 ≤60%（实际 ${((strippedTokens / fullTokens) * 100).toFixed(1)}%）`);
  // 只读档（B1 分层）：8 个只读工具（含 git/fetch）
  const READONLY_TIER_SET = new Set(['read', 'ls', 'glob', 'grep', 'skill', 'todo', 'git', 'fetch']);
  const tier = full.filter((t) => READONLY_TIER_SET.has(t.function.name));
  const tierTokens = approxTokens(JSON.stringify(tier));
  ok(tierTokens <= fullTokens * 0.55, `只读档应 ≤55% 全量（实际 ${((tierTokens / fullTokens) * 100).toFixed(1)}%）`);
  console.log(`  schema：全量 ${fullTokens} · 全剥 ${strippedTokens}（-${(100 - (strippedTokens / fullTokens) * 100).toFixed(0)}%）· 只读档 ${tierTokens}（-${(100 - (tierTokens / fullTokens) * 100).toFixed(0)}%）tokens`);
}

// ---------- 2. A1 两态冻结：回合内 ≤2 个 payload；跨回合才剥描述 ----------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-benchcost-'));
  const prevHome = process.env.MINGDAO_HOME;
  process.env.MINGDAO_HOME = home;
  saveConfig({ provider: 'deepseek', model: 'deepseek-v4-flash', permission: 'auto', sandbox: 'off' });

  const io = createIO({ quiet: true });
  const payloads = []; // 每轮收到的 tools JSON
  let round = 0;
  const stub = {
    async chat(opts) {
      round += 1;
      payloads.push(JSON.stringify(opts.tools));
      if (round === 1) {
        // 只读档 + 模型用 read 并表达写意图 → 下一轮全量档
        return { text: '我需要修改文件。', reasoning: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }], usage: { prompt_tokens: 5, completion_tokens: 2 }, finish: 'tool_calls' };
      }
      if (round === 2) {
        // 全量档 + 用 write（本回合新用，不得改变本回合 payload）
        return { text: '', reasoning: '', toolCalls: [{ id: 'c2', type: 'function', function: { name: 'write', arguments: '{"path":"a.txt","content":"x"}' } }], usage: { prompt_tokens: 5, completion_tokens: 2 }, finish: 'tool_calls' };
      }
      return { text: '完成', reasoning: '', toolCalls: null, usage: { prompt_tokens: 5, completion_tokens: 2 }, finish: 'stop' };
    },
  };
  const agent = createAgent({ provider: stub, permission: { async check() { return true; } }, io, modelName: 'deepseek-v4-flash', workingDir: home, cfg: { permission: 'auto' } });
  await agent.runTurn([{ role: 'user', content: '帮我分析一下这个目录' }]);
  const distinctTurn1 = new Set(payloads);
  ok(distinctTurn1.size <= 2, `回合 1 应至多 2 个 payload（实际 ${distinctTurn1.size}）`);
  ok(payloads[0] !== payloads[1], '只读档 → 全量档（写意图注入）应切换一次');
  const turn1Full = [...distinctTurn1].sort((a, b) => a.length - b.length)[1] || [...distinctTurn1][0]; // 较长的是全量档

  // 回合 2（同一 agent 会话）：写意图提示 → 首轮即全量档；剥描述集合含回合 1 用过的 read/write
  // → 比回合 1 的全量档更小（跨回合才剥描述 = A1 冻结语义）
  payloads.length = 0;
  round = 0;
  await agent.runTurn([{ role: 'user', content: '帮我写一个文件' }]);
  const turn2Full = payloads[0];
  ok(turn2Full.length < turn1Full.length, `跨回合剥描述生效：回合2 全量档（${turn2Full.length}B）应小于回合1 全量档（${turn1Full.length}B）`);
  ok(payloads.every((x) => x === turn2Full), '回合 2 内 payload 应恒定（首轮全量档后不再变化）');
  process.env.MINGDAO_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
}

// ---------- 3. 护栏前置拦截：超限请求不发出 ----------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-benchcost-guard-'));
  const prevHome = process.env.MINGDAO_HOME;
  process.env.MINGDAO_HOME = home;
  saveConfig({ provider: 'deepseek', model: 'deepseek-v4-flash', permission: 'auto', costGuard: { dailyLimitYuan: 0.001, action: 'block' } });
  recordUsage('deepseek-v4-flash', { prompt_tokens: 1000000, completion_tokens: 100 }); // 今日费用远超上限
  let chatCalls = 0;
  const stub = { async chat() { chatCalls += 1; return { text: 'x', toolCalls: null, usage: {}, finish: 'stop' }; } };
  const agent = createAgent({ provider: stub, permission: { async check() { return true; } }, io: createIO({ quiet: true }), modelName: 'deepseek-v4-flash', workingDir: home, cfg: { permission: 'auto', costGuard: { dailyLimitYuan: 0.001, action: 'block' } } });
  const res = await agent.runTurn([{ role: 'user', content: '写点什么' }]);
  ok(chatCalls === 0, `前置拦截应不发请求（实际 ${chatCalls} 次）`);
  ok(String(res.note || '').includes('拦截'), '应给出拦截说明');
  process.env.MINGDAO_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
}

// ---------- 4. A4 前沿对齐测量：被保留消息的字节稳定性（回收幂等） ----------
{
  const { trimMessages } = await import(pathToFileURL(path.join(srcDir, 'context.js')).href);
  // 模拟会话逐轮增长（每轮 +2 条），固定预算裁剪。前缀缓存只认 token 0 起的连续前缀：
  // 裁剪活跃时前沿必然前移、前缀必断（两种策略皆然）——真正的低成本承诺是
  // 「一旦保留，消息字节不再漂移」：已截断的字节恒定（幂等）、未截断的保持原样、最新尾部原样保留。
  const mk = (/** @type {number} */ i) => [
    { role: 'user', content: '第' + i + '轮问题：' + '内容填充。'.repeat(40) },
    { role: 'assistant', content: '第' + i + '轮回答：' + '回复填充。'.repeat(60) },
  ];
  let msgs = [{ role: 'system', content: '你是 MingDao。' }];
  const snapshots = [];
  for (let r = 1; r <= 8; r++) {
    msgs = msgs.concat(mk(r));
    snapshots.push(trimMessages(msgs, 1500, approxTokens));
  }
  // ① 幂等：同一条消息首次截断后字节不再变化；且绝不出现嵌套标记（重复截断）
  const find = (/** @type {any[]} */ out, /** @type {string} */ prefix) => out.find((m) => String(m.content || '').startsWith(prefix));
  let firstTrunc = null;
  let nested = false;
  let drift = false;
  for (let r = 0; r < snapshots.length; r++) {
    const m = find(snapshots[r], '第2轮回答');
    if (!m) continue;
    const c = String(m.content || '');
    if (c.split('已回收').length > 2) nested = true; // 嵌套标记 = 重复截断
    const isTrunc = c.includes('已回收');
    if (isTrunc && firstTrunc == null) firstTrunc = c;
    else if (isTrunc && c !== firstTrunc) drift = true;
  }
  ok(!nested && !drift, '首次截断后字节恒定、无嵌套重截');
  // ② 保持原样：中间消息在被保留期间字节不变（第 3 轮回答在前三轮输出中始终与原文一致）
  const orig3 = mk(3)[1];
  let keptOk = true;
  for (const out of snapshots.slice(0, 4)) {
    const m = find(out, '第3轮回答');
    if (!m) continue;
    if (JSON.stringify(m) !== JSON.stringify(orig3)) { keptOk = false; break; }
  }
  ok(keptOk, '被保留的中间消息字节与原消息一致（回收不侵蚀保留区）');
  // ③ 最新尾部：最后一轮的输出尾部 = 源消息原样
  const last = snapshots[snapshots.length - 1];
  const tailOrig = msgs.slice(-2);
  const tailOk = last.slice(-2).every((m, i) => JSON.stringify(m) === JSON.stringify(tailOrig[i]));
  ok(tailOk, '最新尾部 2 条原样保留');
  console.log('  A4 前沿对齐：回收幂等 + 保留区不侵蚀 + 尾部原样（结论：裁剪期前缀必断由滞回压缩兜底，回收不额外劣化）');
}

// ---------- 5. Batch 半价 ----------
{
  ok(BATCH_DISCOUNT === 0.5, 'BATCH_DISCOUNT 应为 0.5');
  // Batch 按设计恒为「闲时全未命中 × 0.5」（异步任务等价闲时，见 pricing.js 注释）。
  // 测试须用固定闲时基准对比，否则高峰时段 new Date() 让 full 取峰值、断言偶发失败（v0.2.8 自检修复）。
  const offpeakDate = new Date('2026-08-15T04:00:00Z'); // 周六 12:00 北京时间，必为闲时
  const full = estimateCost('deepseek-v4-flash', 1000, 100, null, offpeakDate);
  const batch = estimateBatchCost('deepseek-v4-flash', 1000, 100);
  ok(Math.abs(batch - full * 0.5) < 1e-9, `batch 应恰为闲时全价一半（${batch} vs ${full}）`);
}

console.log(`\ncost 基准：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
