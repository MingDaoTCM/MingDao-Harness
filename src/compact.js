// 上下文自动压缩（P3-1，复审建议第一优先）：
// 长会话超出预算、静默裁剪即将丢弃早期段落时，先用 executor 模型把被裁段落压成摘要，
// 以单条 user 消息注入（替代「失忆」）；被裁段落不足最小阈值时仍走普通裁剪（省一次模型调用）。
// 摘要失败绝不阻塞会话：任何异常回退普通裁剪。
//
// 触发条件：总 token 数 > 预算，且被裁段落（不含 system）≥ MIN_DROP_MESSAGES 条、≥ MIN_DROP_TOKENS tokens。
// 注入格式：system → 摘要(user) → 保留段（保留段头部经 cleanToolPairing 清洗孤儿 tool 消息）。

import { messageTokens, cleanToolPairing, clampText } from './context.js';

const MIN_DROP_MESSAGES = 3; // 至少裁掉 3 条才值得压缩
const MIN_DROP_TOKENS = 2000; // 被裁段落 token 数低于此值不值得一次模型调用
// B1/B2（评估建议）：达到预算 80% 即提前压缩、压到 60%——滞回缓冲带避免在预算线附近
// 反复触发裁剪/压缩，让摘要成为稳定前缀、后续轮次全程缓存命中；压缩触发频率也大幅下降。
const DEFAULT_TRIGGER_RATIO = 0.8;
const TARGET_RATIO = 0.6;
const SUMMARY_MAX_CHARS = 1600; // 摘要上限（约几百 token，远小于被裁段落）
const INPUT_MAX_CHARS = 30000; // 摘要输入上限（防超长工具输出撑爆摘要请求）
const TOOL_OUTPUT_CAP = 300; // 摘要输入中每条工具结果截断长度

const SUMMARY_SYSTEM =
  '你是 MingDao Harness 的会话压缩器。把对话记录压成紧凑中文摘要（≤500 字，要点列表）：' +
  '保留用户目标与关键要求、已完成的步骤与结论、修改/创建的文件、未完成事项、重要约定与决策；' +
  '省略已完成的中间过程与细节。只输出 JSON：{"summary": "摘要内容"}。';

export async function summarizeConversation(/** @type {any} */ provider, /** @type {any} */ model, /** @type {any} */ convoText) {
  const base = {
    model,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: convoText },
    ],
    tools: [],
    temperature: 0.2,
  };
  // 结构化输出（审计 MiniMax §3.3-D）：压缩是 30K 输入 × pro 价的大开销，与标题/记忆/路由
  // 一致改 json_object + maxTokens 2048→1024（1600 字摘要足够）；网关不支持时回退纯文本。
  let text = '';
  let usage = null;
  try {
    const res = await provider.chat({ ...base, maxTokens: 1024, responseFormat: { type: 'json_object' } });
    const j = JSON.parse(String(res?.text || '').trim());
    text = String(j?.summary || '').trim();
    usage = res?.usage || null;
  } catch {}
  if (!text) {
    try {
      const res = await provider.chat({ ...base, maxTokens: 1024 });
      text = String(res?.text || '').trim();
      usage = res?.usage || null;
    } catch {}
  }
  if (!text) return { text: null, usage };
  return { text: text.slice(0, SUMMARY_MAX_CHARS), usage };
}

export async function compactConversation(/** @type {any} */ { messages, budget, count, provider, executorModel, triggerRatio, force = false }) {
  if (!messages.length) return null;
  // 各消息 token 与总量；低于触发线（默认预算 80%）无需压缩
  const sizes = [];
  let total = 0;
  for (const m of messages) {
    const t = messageTokens(m, count);
    sizes.push(t);
    total += t;
  }
  const trigger = Number.isFinite(Number(triggerRatio)) ? Number(triggerRatio) : DEFAULT_TRIGGER_RATIO;
  if (total <= budget * trigger) return null;
  // 保留边界：保留段（boundary..end）≤ budget×TARGET_RATIO（system 恒保留）
  let keepTokens = sizes[0] ?? 0;
  let boundary = messages.length;
  for (let i = messages.length - 1; i >= 1; i--) {
    if (keepTokens + sizes[i] > budget * TARGET_RATIO) {
      boundary = i + 1;
      break;
    }
    keepTokens += sizes[i];
  }
  const droppedCount = boundary - 1; // 不含 system
  if (!force && droppedCount < MIN_DROP_MESSAGES) return null;
  let droppedTokens = 0;
  for (let i = 1; i < boundary; i++) droppedTokens += sizes[i];
  if (!force && droppedTokens < MIN_DROP_TOKENS) return null;

  // 被裁段落 → 文本（工具结果截断；tool_calls 带名称标注）
  const convoText = messages
    .slice(1, boundary)
    .map((/** @type {any} */ m) => {
      if (m.role === 'tool') {
        return `工具结果(${m.tool_call_id ?? ''}): ${clampText(String(m.content ?? ''), TOOL_OUTPUT_CAP)}`;
      }
      const head = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'MingDao' : String(m.role);
      const calls =
        Array.isArray(m.tool_calls) && m.tool_calls.length
          ? ` [调用: ${m.tool_calls.map((/** @type {any} */ tc) => `${tc.function?.name ?? ''}(${String(tc.function?.arguments ?? '').slice(0, 200)})`).join('; ')}]`
          : '';
      return `${head}: ${String(m.content ?? '')}${calls}`;
    })
    .join('\n')
    .slice(0, INPUT_MAX_CHARS);

  // —— 增量压缩（Kimi P2-D）：已压缩过的会话只压「旧摘要之后的新增段」，与旧摘要合并（摘要的摘要），
  // 不再反复把早期内容送进摘要输入——第 N 次压缩输入从 O(历史) 降为 O(增量)。 ——
  const sumIdx = messages.findIndex(
    (/** @type {any} */ m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('<conversation_summary>')
  );
  let incremental = false;
  let summary = null;
  let usage = null;
  if (sumIdx > 0 && sumIdx + 1 < boundary) {
    incremental = true;
    const m = /<conversation_summary>\n([\s\S]*?)\n<\/conversation_summary>/.exec(String(messages[sumIdx].content));
    const oldSummary = (m && m[1]) || '';
    const newText = messages
      .slice(sumIdx + 1, boundary)
      .map((/** @type {any} */ msg) => {
        if (msg.role === 'tool') {
          return `工具结果(${msg.tool_call_id ?? ''}): ${clampText(String(msg.content ?? ''), TOOL_OUTPUT_CAP)}`;
        }
        const head = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? 'MingDao' : String(msg.role);
        return `${head}: ${String(msg.content ?? '')}`;
      })
      .join('\n')
      .slice(0, INPUT_MAX_CHARS);
    try {
      const r = await summarizeConversation(
        provider,
        executorModel,
        `【既有摘要】\n${oldSummary.slice(0, SUMMARY_MAX_CHARS)}\n\n【新增对话记录】\n${newText}`
      );
      summary = r.text;
      usage = r.usage;
    } catch {
      return null;
    }
    if (!summary) return null;
  } else {
    try {
      const r = await summarizeConversation(provider, executorModel, convoText);
      summary = r.text;
      usage = r.usage;
    } catch {
      return null; // 摘要失败：退回普通裁剪
    }
    if (!summary) return null;
  }

  // 组装：system + 摘要(user) + 保留段（清洗保留段头部因裁剪而孤立的 tool 消息）
  const kept = cleanToolPairing(messages.slice(boundary));
  const next = [
    messages[0],
    {
      role: 'user',
      content:
        '（以下是本会话早期内容的自动压缩摘要，细节已省略；如摘要与你的最新要求冲突，以最新指令为准）\n<conversation_summary>\n' +
        summary +
        '\n</conversation_summary>',
    },
    ...kept,
  ];
  return { messages: next, droppedCount: incremental ? boundary - (sumIdx + 1) : droppedCount, droppedTokens, summary, usage, incremental };
}
