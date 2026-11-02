// 批六十四（v0.6.29 报告三 §5.1/5.2/5.6/5.7）：Agent 与上下文正确性变异验证。
//
// 判定入口：test/agent-context-hardening.js（独立套件，D1≥6 / D2≥5 / D3≥5 / D4≥4 / D5≥3）。
// 每条都把修复改回缺陷，套件必须当场红；`expect` 是失败断言原文里的关键词。
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const SUITE = () => M.suite('test/agent-context-hardening.js');

// ---------------------------------------------------------------------------
// D1（C-01）：中断产生孤儿 tool_calls
// ---------------------------------------------------------------------------
M.mutate({
  name: '① D1 收尾恢复"删除最后一条 assistant 的 tool_calls"（旧 stripOrphanCalls）',
  file: 'src/agent.js',
  from: ['    if (!missing.length) return;', '    let insertAt = idx + 1;'].join('\n'),
  to: [
    '    if (!missing.length) return;',
    '    // mutated：回到旧实现——只清最后一条消息的 tool_calls（末条是 tool 时静默失效）',
    '    const lastMsg = messages[messages.length - 1];',
    '    if (lastMsg?.role === \'assistant\' && Array.isArray(lastMsg.tool_calls)) {',
    '      messages[messages.length - 1] = { ...lastMsg, tool_calls: undefined };',
    '    }',
    '    return;',
    '    let insertAt = idx + 1;',
  ].join('\n'),
  expect: ['缺失的第 2 个调用必须被补齐'],
  run: SUITE,
});

M.mutate({
  name: '② D1 只在 assistant 是最后一条消息时补齐（末条为 tool 时静默失效）',
  file: 'src/agent.js',
  from: '    if (idx < 0) return;\n    const answered = new Set();',
  to: '    if (idx < 0 || idx !== messages.length - 1) return; // mutated：末条是 tool 时不补\n    const answered = new Set();',
  expect: ['缺失的第 2 个调用必须被补齐'],
  run: SUITE,
});

M.mutate({
  name: '③ D1 占位追加到历史末尾（不紧跟 assistant 的 tool 块）→ 顺序非法',
  file: 'src/agent.js',
  from: "    messages.splice(insertAt, 0, ...missing.map((id) => ({ role: 'tool', tool_call_id: id, content: INTERRUPTED_TOOL_CONTENT })));",
  to: "    messages.push(...missing.map((id) => ({ role: 'tool', tool_call_id: id, content: INTERRUPTED_TOOL_CONTENT }))); // mutated：追加到末尾",
  expect: ['tool 响应必须紧跟 assistant'],
  run: SUITE,
});

// ---------------------------------------------------------------------------
// D2（C-02）：多模态 content 被计成 13 token
// ---------------------------------------------------------------------------
M.mutate({
  name: '④ D2 恢复 `count(String(content))`（数组 → [object Object] → 13 token）',
  file: 'src/context.js',
  from: '  let total = contentTokens(msg.content, count);',
  to: "  let total = count(String(msg.content || '')); // mutated：数组被 String() 成 [object Object]",
  expect: ['204KB 图文消息必须按 parts 计数'],
  run: SUITE,
});

M.mutate({
  name: '⑤ D2 image part 只计 1 token（视觉开销几乎免费）',
  file: 'src/context.js',
  from: '        total += IMAGE_PART_TOKENS;',
  to: '        total += 1; // mutated：图片按 1 token 计',
  expect: ['204KB 图文消息必须按 parts 计数'],
  run: SUITE,
});

M.mutate({
  name: '⑥ D2 未知 part 计 0（大对象当免费）',
  file: 'src/context.js',
  from: '        total += Math.max(IMAGE_PART_TOKENS, Math.ceil(serialized.length / 4));',
  to: '        total += 0; // mutated：未知 part 不计',
  expect: ['未知 part 必须给保守值'],
  run: SUITE,
});

M.mutate({
  name: '⑦ D2 text part 不再走统一计数器（纯文本数组与字符串口径分裂）',
  file: 'src/context.js',
  from: "      if (type === 'text' || type === 'input_text' || (!type && typeof part.text === 'string')) {",
  to: "      if (type === '__never_text_part__') { // mutated：text part 落入未知分支",
  expect: ['纯文本数组与字符串必须同口径'],
  run: SUITE,
});

// ---------------------------------------------------------------------------
// D3（H-01）：尾部贪心丢掉最新用户消息
// ---------------------------------------------------------------------------
M.mutate({
  name: '⑧ D3 恢复"从最后一条开始贪心、超预算即 break"（最后一条被整条丢弃）',
  file: 'src/context.js',
  from: '    const lastIndex = out.length - 1;',
  to: '    const lastIndex = -1; // mutated：不再无条件保留最后一条',
  expect: ['最新用户消息不得被丢弃'],
  run: SUITE,
});

M.mutate({
  name: '⑨ D3 单条超预算时不截断、直接原样保留（无可见标注）',
  file: 'src/context.js',
  from: '        const canTruncate = typeof last.content === \'string\' || Array.isArray(last.content);',
  to: '        const canTruncate = false; // mutated：不截断也不标注',
  expect: ['超预算单条消息必须带可见截断标注'],
  run: SUITE,
});

M.mutate({
  name: '⑩ D3 去掉可见截断标注（静默截断）',
  file: 'src/context.js',
  from: "const TRUNCATED_MARK = '…（已截断）';",
  to: "const TRUNCATED_MARK = ''; // mutated：截断不可见",
  expect: ['超预算单条消息必须带可见截断标注'],
  run: SUITE,
});

// ---------------------------------------------------------------------------
// D4（C-04）：SSE 兜底 id 只用工具名 → 同名并行调用重复
// ---------------------------------------------------------------------------
M.mutate({
  name: '⑪ D4 兜底 id 退回 `call_${name}`（同名调用共享 id）',
  file: 'src/providers/openai-compatible.js',
  from: [
    '      let id = c.id;',
    '      if (!id) {',
    '        const base = `call_${c.name || \'x\'}_${idx}_${fallbackIdNonce}`;',
    '        id = base;',
    '        let n = 1;',
    '        while (usedIds.has(id)) id = `${base}_${n++}`;',
    '      }',
  ].join('\n'),
  to: '      let id = c.id || `call_${c.name || \'x\'}`; // mutated：只按工具名派生',
  expect: ['同名并行调用的兜底 id 必须唯一'],
  run: SUITE,
});

M.mutate({
  name: '⑫ D4 兜底 id 去掉序号与防撞（同一次响应内必然重复）',
  file: 'src/providers/openai-compatible.js',
  from: [
    '      let id = c.id;',
    '      if (!id) {',
    '        const base = `call_${c.name || \'x\'}_${idx}_${fallbackIdNonce}`;',
    '        id = base;',
    '        let n = 1;',
    '        while (usedIds.has(id)) id = `${base}_${n++}`;',
    '      }',
  ].join('\n'),
  to: "      let id = c.id || `call_${c.name || 'x'}_${fallbackIdNonce}`; // mutated：无 index、无防撞",
  expect: ['同名并行调用的兜底 id 必须唯一'],
  run: SUITE,
});

M.mutate({
  name: '⑬ D4 覆盖网关显式下发的 id（兜底规则吃掉真实 id）',
  file: 'src/providers/openai-compatible.js',
  from: '      let id = c.id;',
  to: "      let id = ''; // mutated：忽略显式 id",
  expect: ['网关显式下发的 id 必须原样保留'],
  run: SUITE,
});

// ---------------------------------------------------------------------------
// D5（H-02）：工具消息回填顺序倒置
// ---------------------------------------------------------------------------
M.mutate({
  name: '⑭ D5 拒绝项在预检阶段就地 push（回到旧顺序倒置）',
  file: 'src/agent.js',
  from: [
    '        function finishDenied(/** @type {any} */ prep) {',
    '          pendingToolMessages.push({',
    "            idx: prep.idx,",
    "            msg: { role: 'tool', tool_call_id: prep.tc.id, content: prep.denied },",
    '          });',
    '        }',
  ].join('\n'),
  to: [
    '        function finishDenied(/** @type {any} */ prep) {',
    "          messages.push({ role: 'tool', tool_call_id: prep.tc.id, content: prep.denied }); // mutated：就地回填",
    '        }',
  ].join('\n'),
  expect: ['tool 消息必须与 tool_calls 原序一致'],
  run: SUITE,
});

M.mutate({
  name: '⑮ D5 回填前按倒序排序（顺序仍与 tool_calls 不一致）',
  file: 'src/agent.js',
  from: '    pendingToolMessages.sort((a, b) => a.idx - b.idx);',
  to: '    pendingToolMessages.sort((a, b) => b.idx - a.idx); // mutated：倒序回填',
  expect: ['tool 消息必须与 tool_calls 原序一致'],
  run: SUITE,
});

M.mutate({
  name: '⑯ D5 成功项在 finishTool 里就地 push（被拒项在前时顺序错位）',
  file: 'src/agent.js',
  from: [
    '          pendingToolMessages.push({',
    '            idx: prep.idx,',
    '            msg: {',
    "              role: 'tool',",
    '              tool_call_id: prep.tc.id,',
    '              content: toolResultMessage(text, { cached: prep.cached, cap: toolResultCap, post: pv }),',
    '            },',
    '          });',
  ].join('\n'),
  to: [
    "          messages.push({ // mutated：成功项立即回填，不等整批",
    "            role: 'tool',",
    '            tool_call_id: prep.tc.id,',
    '            content: toolResultMessage(text, { cached: prep.cached, cap: toolResultCap, post: pv }),',
    '          });',
  ].join('\n'),
  expect: ['被拒项在前时也必须严格按 tool_calls 原序回填'],
  run: SUITE,
});

if (!M.report()) process.exit(1);
