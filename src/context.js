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

// 消息对象级 token 缓存（WeakMap：消息被会话持有期间有效，随消息一起回收）。
// 会话历史消息内容基本不可变（裁剪是投影，不改原对象），同一回合的 24 步里
// trimMessages 每步全量重算时直接命中，跳过重复 BPE 计数；key 附上 count 函数，
// 模型切换（新计数器）后自动失效重算。
const messageTokenCache = new WeakMap();

export function messageTokens(msg, count = approxTokens) {
  const hit = messageTokenCache.get(msg);
  if (hit && hit.fn === count) return hit.value;
  const total = partTokens(msg, count) + 4; // 每条消息的协议开销
  messageTokenCache.set(msg, { fn: count, value: total });
  return total;
}

// 从尾部向前保留消息，直到预算用尽；始终保留首条 system 消息。
// 裁剪可能切断 assistant(tool_calls) ↔ tool 的配对，清洗掉孤立消息，
// 否则 OpenAI 兼容 API 会因 tool_call_id 找不到对应调用而报 400。
export function cleanToolPairing(kept) {
  const callIds = new Set();
  for (const m of kept) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc?.id) callIds.add(tc.id);
    }
  }
  const clean = kept.filter((m) => m.role !== 'tool' || callIds.has(m.tool_call_id));
  const toolIds = new Set(clean.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  // 注意：裁剪是每次请求的投影，绝不能改写调用方 messages 里的原对象
  // （否则会话历史被永久污染：assistant 消息丢失 tool_calls，下一轮 API 报 400）
  return clean.map((m) => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const keptCalls = m.tool_calls.filter((tc) => toolIds.has(tc.id));
      if (keptCalls.length !== m.tool_calls.length) {
        if (keptCalls.length) return { ...m, tool_calls: keptCalls };
        const copy = { ...m };
        delete copy.tool_calls; // 无任何对应 tool 响应，退化为纯文本消息
        return copy;
      }
    }
    return m;
  });
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
  // 静默裁剪：不向中间插入说明消息——保持消息前缀字节稳定，
  // 让 DeepSeek 等支持上下文缓存的 API 最大化缓存命中（命中价仅为未命中的约 1/30）。
  return kept;
}

export function clampText(text, maxChars = TOOL_RESULT_LIMIT) {
  const s = String(text);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n…[输出过长已截断，原文共 ${s.length} 字符]`;
}
