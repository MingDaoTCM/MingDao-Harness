// 上下文管理：token 计数与预算裁剪。
// 计数优先级：DeepSeek 词表精确计数（tokenizer.js）→ 启发式估算（无词表模型回退）。

import { heuristicTokens } from './tokenizer.js';

export const TOOL_RESULT_LIMIT = 20000;

/**
 * 码点安全的前缀截断。
 *
 * 审计 BUG-079（实测复现）：`String.prototype.slice` 按 **UTF-16 单元**切，切点落在代理对中间时
 * 会留下一个孤立代理项（如 `\uD835`），渲染成 `�`，且发给上游时是非法 Unicode。
 * emoji / 增补平面汉字（𝕏、𠮷 等）都会命中。
 * @param {any} s @param {number} n
 */
function safeHead(s, n) {
  const head = String(s).slice(0, n);
  // 结尾是高代理（\uD800-\uDBFF）说明它后面的低代理被切掉了 → 去掉这个半个字符
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

// 兼容旧接口的启发式估算（英文≈4 字符/token，CJK≈1 字符/token）
export function approxTokens(/** @type {any} */ text) {
  return heuristicTokens(text);
}

// —— 多模态 content parts 的 token 估值口径（审计 v0.6.29 C-02 / 严重-2）——
// 旧实现在 content 为数组时走 `count(String(array))` → 只数到 "[object Object]"（13 token），
// 一条 200KB 的图文消息在预算/压缩/费用护栏里几乎是免费的，真实请求却可能直接超窗。
// 现在的口径（**宁可高估、不可漏计**）：
//   · text / input_text：交给现有计数器 count()——有词表走 BPE，无词表走启发式
//     （英文≈4 字符/token、CJK≈1 字符/token），与纯文本字符串消息**同一口径**；
//   · image_url / image / input_image：固定 2048 token/个。视觉开销取决于解码后的像素与
//     分块，无法从 base64 长度反推（同一张图 base64 可差数倍），故取保守占位：
//     OpenAI high detail（85 + 170×tiles）常见 ≈1,105、Anthropic（(w×h)/750）≈1,365，
//     2048 覆盖 2K 级截图；也远大于旧实现的 13；
//   · input_audio / audio：固定 1024 token/个（1 分钟 16kHz 语音的常见计费量级）；
//   · 未知 part：取 max(2048, 序列化长度/4)——既覆盖未知媒体，也避免把未知大对象当免费；
//   · 非数组对象（部分网关把 content 包成对象）：按 JSON 序列化后计数，绝不 String() 成
//     "[object Object]"。
const IMAGE_PART_TOKENS = 2048;
const AUDIO_PART_TOKENS = 1024;

function contentTokens(/** @type {any} */ content, /** @type {any} */ count) {
  if (typeof content === 'string') return count(content);
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) {
      if (part == null) continue;
      if (typeof part === 'string') {
        total += count(part);
        continue;
      }
      const type = String(part.type || '');
      if (type === 'text' || type === 'input_text' || (!type && typeof part.text === 'string')) {
        total += count(String(part.text ?? ''));
      } else if (type === 'image_url' || type === 'image' || type === 'input_image') {
        total += IMAGE_PART_TOKENS;
      } else if (type === 'input_audio' || type === 'audio') {
        total += AUDIO_PART_TOKENS;
      } else {
        let serialized = '';
        try {
          serialized = JSON.stringify(part) ?? '';
        } catch {
          serialized = '';
        }
        total += Math.max(IMAGE_PART_TOKENS, Math.ceil(serialized.length / 4));
      }
    }
    return total;
  }
  if (content == null) return 0;
  if (typeof content === 'object') {
    try {
      return count(JSON.stringify(content) ?? '');
    } catch {
      return 0;
    }
  }
  return count(String(content));
}

function partTokens(/** @type {any} */ msg, /** @type {any} */ count) {
  let total = contentTokens(msg.content, count);
  for (const tc of msg.tool_calls || []) {
    total += count(JSON.stringify(tc));
  }
  // P1 修复（v0.4.6）：reasoning_content 必须计入预算。带 tool_calls 的 assistant 消息会把
  // 完整 reasoning 原样回传（DeepSeek thinking 模式硬要求，缺/截断即 400，见 agent.js），
  // 而此前这里只算 content + tool_calls——实测单条 4400 字 reasoning = 2000 token，
  // messageTokens 只算 33（低估 61 倍）。后果：预算/压缩触发/护栏前置预估同源低估，
  // 思考型长会话会在「显示还有余量」时把请求顶到窗口边缘。
  if (typeof msg.reasoning_content === 'string') {
    total += count(msg.reasoning_content);
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

// —— 单条超预算消息的就地截断（审计 v0.6.29 H-01 / 高-1）——
// 尾部贪心遇到"单条即超预算"时不能直接 break：那样最新一条用户消息会被整条丢弃，
// 只剩 system，模型对着空气作答，而界面上看不出任何异常。这里的约定是**消息必留**，
// 放不下就按字符二分截断，并追加可见标注——"被截断"必须让模型和用户都看得见。
const TRUNCATED_MARK = '…（已截断）';

/** 取不超过 allowedTokens 的最长字符前缀（码点安全；兼容 BPE 与启发式计数器）。 */
function prefixWithin(/** @type {string} */ text, /** @type {number} */ allowedTokens, /** @type {any} */ count) {
  if (count(text) <= allowedTokens) return text;
  let lo = 0;
  let hi = text.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (count(safeHead(text, mid)) <= allowedTokens) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return safeHead(text, best);
}

/** 把任意 content 截到 allowedTokens 内，返回新 content（字符串或 parts 数组），绝不返回空。 */
function truncateContent(/** @type {any} */ content, /** @type {number} */ allowedTokens, /** @type {any} */ count) {
  const markTokens = count(TRUNCATED_MARK);
  if (typeof content === 'string') {
    if (count(content) <= allowedTokens) return content;
    if (allowedTokens <= markTokens) return TRUNCATED_MARK;
    return prefixWithin(content, allowedTokens - markTokens, count) + TRUNCATED_MARK;
  }
  if (Array.isArray(content)) {
    // parts 数组：按原序保留能放下的 part；第一个放不下的 text part 就地截断，
    // 媒体 part 放不下则丢弃；末尾统一补一个可见的 text 标注（不破坏 parts 结构）。
    let remaining = Math.max(0, allowedTokens - markTokens);
    const out = [];
    for (const part of content) {
      if (part == null) continue;
      const t = contentTokens([part], count);
      if (t <= remaining) {
        out.push(part);
        remaining -= t;
        continue;
      }
      if (typeof part === 'object' && typeof part.text === 'string') {
        out.push({ ...part, text: prefixWithin(part.text, remaining, count) });
        remaining = 0;
      }
      break;
    }
    out.push({ type: 'text', text: TRUNCATED_MARK });
    return out;
  }
  // 其他形态（对象/number 等）：转成 JSON 文本再走字符串截断
  const text = content == null ? '' : JSON.stringify(content) ?? String(content);
  return truncateContent(text, allowedTokens, count);
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
      // 注：无幂等守卫——回收结果只写在投影副本 out 上、从不回写原 messages（trimMessages 是投影，
      // 每次调用从原 messages 重新拷贝），故「已回收」标记不会进入下一次调用的输入，无需守卫。
      // 截断逻辑确定（同输入同输出），字节稳定，不会逐轮嵌套重截（审计 v0.4.1 确认的死代码已移除）。
      let next = null;
      if (m.role === 'tool' && c.length > 40) {
        next = { ...m, content: `[工具 ${m.tool_call_id || ''} 结果摘要：${safeHead(c, 40).replace(/\n/g, ' ')}…（已回收，原 ${c.length} 字）]` };
      } else if (m.role === 'assistant' && c.length > 200) {
        next = { ...m, content: safeHead(c, 200) + ` …[已回收，原 ${c.length} 字]` };
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
    // 不变量（审计 H-01）：**最后一条消息必留**。它通常是本轮最新的用户输入；
    // 旧实现从尾往前贪心、首条放不下就 break，单条超预算时结果只剩 system——
    // 模型看不到问题却照常作答，这是"静默失忆"里最危险的一种。
    const lastIndex = out.length - 1;
    if (lastIndex >= 0) {
      const last = out[lastIndex];
      const t = messageTokens(last, count);
      if (total + t <= budget) {
        tail.unshift(last);
        total += t;
      } else {
        // 单条即超预算：就地截断 + 可见标注（不丢消息）。扣掉该消息 4 token 的协议开销。
        const allowed = Math.max(0, budget - total - 4);
        const canTruncate = typeof last.content === 'string' || Array.isArray(last.content);
        const fitted = canTruncate ? { ...last, content: truncateContent(last.content, allowed, count) } : last;
        tail.unshift(fitted);
        total += messageTokens(fitted, count);
        // 截断后仍可能略超预算（标注本身需要 token，且 content 之外还有 tool_calls）——
        // 这里**宁可超一点也保留**，绝不因为放不下而整条丢弃。
      }
    }
    for (let i = out.length - 2; i >= 0; i--) {
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
  // v0.6.7（报告一 L-1）：此前是裸 slice —— 截断点落在**代理对**中间会切出半个 emoji，
  // 后续序列化/渲染得到 U+FFFD（BUG-079 只修了 safeHead 那条路径）。这里与它同源：回退一个码元。
  const safeHead = (/** @type {string} */ t, /** @type {number} */ n) => {
    if (t.length <= n) return t;
    const c = t.charCodeAt(n - 1);
    return c >= 0xd800 && c <= 0xdbff ? t.slice(0, n - 1) : t.slice(0, n);
  };
  return safeHead(s, maxChars) + `\n…[输出过长已截断，原文共 ${s.length} 字符]`;
}
