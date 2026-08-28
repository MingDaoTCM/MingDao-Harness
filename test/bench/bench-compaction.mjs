// 评测基准（Hermes E2-1）：压缩质量结构回归——离线 mock provider，零 API 成本。
// 断言：触发线/摘要标记/保留尾部字节不变/增量压缩只压新增段（摘要的摘要）。
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const srcDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'src');
const { compactConversation } = await import(pathToFileURL(path.join(srcDir, 'compact.js')).href);
const { messageTokens, approxTokens } = await import(pathToFileURL(path.join(srcDir, 'context.js')).href);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  ✖', msg); } };

// mock 摘要器：记录收到的输入（用于断言增量压缩的输入只含增量段）
let lastSummaryInput = '';
const mockProvider = { chat: async (opts) => {
  lastSummaryInput = String(opts.messages?.at(-1)?.content || '');
  return { text: JSON.stringify({ summary: '【摘要】用户要求：整理数据文件' }), usage: { prompt_tokens: 100, completion_tokens: 30 } };
} };

// 构造长会话：system + 40 条消息（每条 ~1200 字 → 总 token 超 80% 触发线）
const msgs = [{ role: 'system', content: '你是 MingDao。' }];
for (let i = 1; i <= 40; i++) {
  if (i % 2 === 1) msgs.push({ role: 'user', content: '第' + i + '条用户消息：' + '内容填充。'.repeat(60) });
  else msgs.push({ role: 'assistant', content: '第' + i + '条回复：' + '回复内容填充。'.repeat(60) });
}
const budget = 6000;

{
  const r = await compactConversation({ messages: msgs, budget, count: approxTokens, provider: mockProvider, executorModel: 'deepseek-v4-flash' });
  ok(Boolean(r && r.messages), '应触发压缩');
  if (!r || !r.messages) { process.exit(1); }
  ok(r.messages[1]?.role === 'user' && r.messages[1].content.includes('<conversation_summary>'), '摘要标记注入为 system 后首条 user');
  ok(r.droppedCount > 0, 'droppedCount > 0（实际 ' + r.droppedCount + '）');
  ok(r.incremental !== true, '首次压缩应为全量');
  // 保留尾部字节不变：最后 5 条与原文一致
  const tailSame = r.messages.slice(-5).every((m, i) => JSON.stringify(m) === JSON.stringify(msgs.slice(-5)[i]));
  ok(tailSame, '保留段尾部字节不变（缓存前缀稳定）');
}

{
  // 二次压缩：会话继续增长后再次压缩 → 已有摘要标记 → 增量路径（只压新增段，与旧摘要合并）
  const first = await compactConversation({ messages: msgs, budget, count: approxTokens, provider: mockProvider, executorModel: 'deepseek-v4-flash' });
  if (!first || !first.messages) { console.error('  前置：首次压缩失败'); process.exit(1); }
  const grown = [...first.messages];
  for (let i = 1; i <= 20; i++) {
    if (i % 2 === 1) grown.push({ role: 'user', content: '新增第' + i + '条：' + '内容填充。'.repeat(60) });
    else grown.push({ role: 'assistant', content: '新增第' + i + '条回复：' + '回复内容填充。'.repeat(60) });
  }
  const r2 = await compactConversation({ messages: grown, budget, count: approxTokens, provider: mockProvider, executorModel: 'deepseek-v4-flash' });
  ok(Boolean(r2 && r2.messages), '增长后应再次触发压缩');
  if (!r2 || !r2.messages) { process.exit(1); }
  ok(r2.incremental === true, '二次压缩应走增量路径（实际 ' + r2.incremental + '）');
  ok(lastSummaryInput.includes('【既有摘要】') && lastSummaryInput.includes('【新增对话记录】'), '增量压缩输入应含既有摘要与新增段');
  ok(r2.messages[1]?.content.includes('<conversation_summary>'), '合并后的摘要标记仍在');
}

{
  // 低于触发线：不压缩（返回 null）
  const small = [msgs[0], msgs[1], msgs[2]];
  const r3 = await compactConversation({ messages: small, budget: 100000, count: approxTokens, provider: mockProvider, executorModel: 'deepseek-v4-flash' });
  ok(r3 === null, '低于触发线应返回 null');
}

{
  // 摘要失败回退：provider 抛错 → null（不阻塞会话）
  const bad = { chat: async () => { throw new Error('boom'); } };
  const r4 = await compactConversation({ messages: msgs, budget, count: approxTokens, provider: bad, executorModel: 'deepseek-v4-flash' });
  ok(r4 === null, '摘要失败应回退 null');
}

console.log(`compaction 基准：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
