// 上下文管理：token 计数与预算裁剪。
// 计数优先级：DeepSeek 词表精确计数（tokenizer.js）→ 启发式估算（无词表模型回退）。

import { heuristicTokens } from './tokenizer.js';

export const TOOL_RESULT_LIMIT = 20000;

// 兼容旧接口的启发式估算（英文≈4 字符/token，CJK≈1 字符/token）
export function approxTokens(/** @type {any} */ text) {
  return heuristicTokens(text);
}

function partTokens(/** @type {any} */ msg, /** @type {any} */ count) {
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

export function messageTokens(/** @type {any} */ msg, count = approxTokens) {
  const hit = messageTokenCache.get(msg);
  if (hit && hit.fn === count) return hit.value;
  const total = partTokens(msg, count) + 4; // 每条消息的协议开销
  messageTokenCache.set(msg, { fn: count, value: total });
  return total;
}

// 从尾部向前保留消息，直到预算用尽；始终保留首条 system 消息。
// 裁剪可能切断 assistant(tool_calls) ↔ tool 的配对，清洗掉孤立消息，
// 否则 OpenAI 兼容 API 会因 tool_call_id 找不到对应调用而报 400。
export function cleanToolPairing(/** @type {any} */ kept) {
  const callIds = new Set();
  for (const m of kept) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc?.id) callIds.add(tc.id);
    }
  }
  const clean = kept.filter((/** @type {any} */ m) => m.role !== 'tool' || callIds.has(m.tool_call_id));
  const toolIds = new Set(clean.filter((/** @type {any} */ m) => m.role === 'tool').map((/** @type {any} */ m) => m.tool_call_id));
  // 注意：裁剪是每次请求的投影，绝不能改写调用方 messages 里的原对象
  // （否则会话历史被永久污染：assistant 消息丢失 tool_calls，下一轮 API 报 400）
  return clean.map((/** @type {any} */ m) => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const keptCalls = m.tool_calls.filter((/** @type {any} */ tc) => toolIds.has(tc.id));
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

export function trimMessages(/** @type {any} */ messages, /** @type {any} */ budget, count = approxTokens) {
  if (!messages.length) return [];
  const hasSystem = messages[0]?.role === 'system';
  const system = hasSystem ? [messages[0]] : [];
  const rest = hasSystem ? messages.slice(1) : messages;
  const totalOf = (/** @type {any} */ arr) => arr.reduce((/** @type {any} */ s, /** @type {any} */ m) => s + messageTokens(m, count), 0);
  // —— 轻量语义回收（Hermes B1 + workbuddy P0-1 修正）——
  // 只在「真的超预算」时回收（此前 >80% 即动手，能塞下的会话也被白白截断丢内容）；
  // 回收边界 = 按尾部保留规则确定将被丢弃的前缀（此前固定扫前 500 条，超长会话时回收全白做）；
  // 替换仅当摘要确实更短才接受（防短消息被摘要撑长）。
  const sysTokens = totalOf(system);
  let total = sysTokens + totalOf(rest);
  if (total > budget) {
    const out = [...rest];
    // 丢弃边界：从后往前贪心，确定尾部保留起点 s（s 之前的消息将被丢弃，只对它们回收）
    let s = out.length;
    {
      let acc = sysTokens;
      for (let i = out.length - 1; i >= 0; i--) {
        const t = messageTokens(out[i], count);
        if (acc + t > budget) { s = i + 1; break; }
        acc += t;
      }
    }
    for (let i = 0; i < s && i < 500; i++) {
      if (total <= budget) break;
      const m = out[i];
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
      // 幂等守卫（A4）：已回收过的内容跳过——否则「截断标记」把长度再次顶过阈值，逐轮嵌套重截，
      // 被保留消息字节逐轮漂移（前缀缓存连尾部都失配）
      if (c.includes('已回收')) continue;
      let next = null;
      if (m.role === 'tool' && c.length > 40) {
        next = { ...m, content: `[工具 ${m.tool_call_id || ''} 结果摘要：${c.slice(0, 40).replace(/\n/g, ' ')}…（已回收，原 ${c.length} 字）]` };
      } else if (m.role === 'assistant' && c.length > 200) {
        next = { ...m, content: c.slice(0, 200) + ` …[已回收，原 ${c.length} 字]` };
      }
      if (next) {
        const oldT = messageTokens(m, count);
        const newT = messageTokens(next, count);
        if (newT < oldT) {
          total += newT - oldT;
          out[i] = next;
        }
      }
    }
    // 回收后仍超预算 → 从尾部保留（必要时继续丢弃最老，清洗 tool 配对）
    total = sysTokens;
    const tail = [];
    for (let i = out.length - 1; i >= 0; i--) {
      const t = messageTokens(out[i], count);
      if (total + t > budget) break;
      total += t;
      tail.unshift(out[i]);
    }
    return cleanToolPairing(system.concat(tail));
  }
  return cleanToolPairing(system.concat(rest));
}

export function clampText(/** @type {any} */ text, maxChars = TOOL_RESULT_LIMIT) {
  const s = String(text);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n…[输出过长已截断，原文共 ${s.length} 字符]`;
}
