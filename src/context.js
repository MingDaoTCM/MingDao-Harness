// 上下文管理：token 计数与预算裁剪。
// 计数优先级：DeepSeek 词表精确计数（tokenizer.js）→ 启发式估算（无词表模型回退）。

import { heuristicTokens } from './tokenizer.js';

export const TOOL_RESULT_LIMIT = 20000;

// 兼容旧接口的启发式估算（英文≈4 字符/token，CJK≈1 字符/token）
export function approxTokens(text) {
  return heuristicTokens(text);
}

function partTokens(msg, count) {
  let total = count(msg.content || '');
  for (const tc of msg.tool_calls || []) {
    total += count(JSON.stringify(tc));
  }
  return total;
}

export function messageTokens(msg, count = approxTokens) {
  return partTokens(msg, count) + 4; // 每条消息的协议开销
}

// 从尾部向前保留消息，直到预算用尽；始终保留首条 system 消息。
// 裁剪可能切断 assistant(tool_calls) ↔ tool 的配对，清洗掉孤立消息，
// 否则 OpenAI 兼容 API 会因 tool_call_id 找不到对应调用而报 400。
function cleanToolPairing(kept) {
  const callIds = new Set();
  for (const m of kept) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc?.id) callIds.add(tc.id);
    }
  }
  const clean = kept.filter((m) => m.role !== 'tool' || callIds.has(m.tool_call_id));
  const toolIds = new Set(clean.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  for (const m of clean) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const keptCalls = m.tool_calls.filter((tc) => toolIds.has(tc.id));
      if (keptCalls.length !== m.tool_calls.length) {
        if (keptCalls.length) m.tool_calls = keptCalls;
        else delete m.tool_calls; // 无任何对应 tool 响应，退化为纯文本消息
      }
    }
  }
  return clean;
}

export function trimMessages(messages, budget, count = approxTokens) {
  if (!messages.length) return [];
  const hasSystem = messages[0]?.role === 'system';
  const system = hasSystem ? [messages[0]] : [];
  const rest = hasSystem ? messages.slice(1) : messages;
  let total = system.reduce((s, m) => s + messageTokens(m, count), 0);
  const tail = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const t = messageTokens(rest[i], count);
    if (total + t > budget) break;
    total += t;
    tail.unshift(rest[i]);
  }
  const kept = cleanToolPairing(system.concat(tail));
  const dropped = messages.length - kept.length;
  if (dropped > 0) {
    kept.splice(system.length, 0, {
      role: 'system',
      content: `[上下文管理：超出预算（${budget} tokens），已省略更早的 ${dropped} 条消息。]`,
    });
  }
  return kept;
}

export function clampText(text, maxChars = TOOL_RESULT_LIMIT) {
  const s = String(text);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n…[输出过长已截断，原文共 ${s.length} 字符]`;
}
