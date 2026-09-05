// OpenAI 兼容协议的 HTTP + SSE 流式客户端。
// DeepSeek、OpenAI、Qwen、GLM、Moonshot 以及绝大多数模型网关都走这一层。

/**
 * API 错误：Error 附带 HTTP 状态码与响应头（重试退避读 Retry-After 用）。
 * @typedef {Error & { status?: number, headers?: Headers }} ApiError
 */

export async function chat(/** @type {any} */ { baseUrl, apiKey, model, messages, tools, temperature, maxTokens, signal, onDelta, onActivity, includeUsage = true, responseFormat, reasoningEffort }) {
  const url = String(baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const payload = /** @type {Record<string, any>} */ ({ model, messages });
  if (temperature != null) payload.temperature = temperature;
  if (tools && tools.length) {
    payload.tools = tools;
    payload.tool_choice = 'auto';
  }
  if (maxTokens) payload.max_tokens = maxTokens;
  if (responseFormat) payload.response_format = responseFormat;
  if (reasoningEffort === 'off') payload.thinking = { type: 'disabled' }; // /think off：显式关闭思考（官方 thinking_mode）
  else if (reasoningEffort) payload.reasoning_effort = reasoningEffort; // 思考强度（官方 thinking_mode）
  payload.stream = true;
  // 流式响应默认不带 usage，显式请求以便展示 token/费用统计
  // （部分网关不支持该字段，可在 config.json 设 "includeUsage": false 关闭）
  if (includeUsage) payload.stream_options = { include_usage: true };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      // 审计（桌面版「第二问挂起」修复）：Node 全局 fetch(undici) 默认连接保活，
      // 与部分网关/NAT 组合下复用已断开的 keep-alive 连接会静默挂起——首个请求正常、
      // 后续请求无响应，重启进程恢复。显式 Connection: close 每次新建连接，可靠性优先
      // （模型请求本身是长流式调用，建连开销占比可忽略）。
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, Connection: 'close' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    /** @type {ApiError} */
    const e = new Error(`网络请求失败：${(/** @type {any} */ (err))?.message || err}`);
    e.status = 0;
    throw e;
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let detail = raw.slice(0, 400);
    try {
      const j = JSON.parse(raw);
      if (j?.error?.message) detail = j.error.message;
    } catch {}
    /** @type {ApiError} */
    const e = new Error(`[${model}] API 错误 ${res.status}: ${detail}`);
    e.status = res.status;
    e.headers = res.headers; // 重试退避读取 Retry-After 用
    throw e;
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const json = await res.json().catch(() => null);
    if (!json) throw new Error(`[${model}] 响应解析失败。`);
    return parseNonStream(json, onDelta);
  }
  return parseStream(res.body, onDelta, onActivity);
}

export function parseNonStream(/** @type {any} */ json, /** @type {any} */ onDelta) {
  const choice = json?.choices?.[0];
  const msg = choice?.message ?? {};
  if (msg.content) onDelta?.({ text: msg.content });
  if (msg.reasoning_content) onDelta?.({ reasoning: msg.reasoning_content });
  const toolCalls = msg.tool_calls?.length ? msg.tool_calls : null;
  return {
    text: msg.content ?? '',
    reasoning: msg.reasoning_content ?? '',
    toolCalls,
    usage: json?.usage ?? null,
    finish: choice?.finish_reason ?? null,
  };
}

// 解析 SSE 流：处理跨 chunk 断行、增量 content / reasoning_content / tool_calls。
// onActivity：每收到一个有效 SSE 数据帧即回调（含 usage-only 帧），供上层做「首 token 等待/流式空闲」超时仲裁——
// 长上下文 prefill 时服务端可能 200s+ 无正文，靠「有帧到达」而非「有正文」判定存活，避免误杀慢 prefill。
export async function parseStream(/** @type {any} */ body, /** @type {any} */ onDelta, /** @type {any} */ onActivity) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  const calls = new Map(); // key -> {id, name, args}（优先用 id，无 id 时按 index，再兜底自增）
  const indexKeys = new Map(); // index -> key（id 只在首片出现，后续分片按 index 找回同一条目）
  let autoKey = 0;
  let usage = null;
  let /** @type {any} */ finish = null;

  let doneFlag = false;
  const handleLine = (/** @type {any} */ lineRaw) => {
    const line = lineRaw.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      finish = /** @type {any} */ finish || 'stop';
      doneFlag = true;
      return true; // 通知外层终止读取（审计 P2-4：[DONE] 后不再消费残帧、不挂到超时）
    }
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    // 注意：DeepSeek/OpenAI 流式最后一块常是 usage-only（choices 为空），必须先取 usage 再判 choices
    if (json.usage) usage = json.usage;
    const choice = json?.choices?.[0];
    if (!choice) return;
    const d = choice.delta ?? {};
    if (d.content && !doneFlag) {
      content += d.content;
      onDelta?.({ text: d.content });
    }
    if (d.reasoning_content && !doneFlag) {
      reasoning += d.reasoning_content;
      onDelta?.({ reasoning: d.reasoning_content });
    }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        let key;
        if (tc.id) key = `id:${tc.id}`;
        else if (tc.index != null && indexKeys.has(tc.index)) key = indexKeys.get(tc.index);
        else key = `idx-${tc.index != null ? tc.index : autoKey++}`;
        if (tc.index != null) indexKeys.set(tc.index, key);
        let cur = calls.get(key);
        if (!cur) {
          cur = { id: tc.id ?? '', name: '', args: '' };
          calls.set(key, cur);
        }
        if (tc.id) cur.id = tc.id;
        // 部分网关会重复下发完整 name：保留最长版本，避免重复拼接
        if (tc.function?.name && tc.function.name.length > cur.name.length) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      // 有帧到达即视为「活着」：prefill 阶段服务端可能先发 usage-only/空帧，正文迟迟不来，
      // 靠帧到达刷新上层流式空闲计时器（首 token 等待则仍由「无任何帧」触发）
      if (line.trim()) onActivity?.();
      if (handleLine(line)) break;
    }
  }
  // 收尾：残行（网关最后一帧不带换行）与多字节字符冲刷——decode 残余并入 buf 统一走行解析，
  // 不再直接拼进 content（此前尾字节绕过 doneFlag/行解析，流中途截断时正文混入杂质）
  buf += decoder.decode();
  if (buf.trim()) handleLine(buf); // [DONE] 后残留 usage 尾帧仍吸收（正文/推理已被 doneFlag 拦截）

  const toolCalls = [...calls.entries()]
    .sort((a, b) => {
      const na = Number(String(a[0]).replace(/^idx-/, ''));
      const nb = Number(String(b[0]).replace(/^idx-/, ''));
      // 无 id 的 idx-N 按数字排序（审计 P2-5：idx-10 应在 idx-2 之后而非之前）
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a[0]).localeCompare(String(b[0]));
    })
    .map(([, c]) => ({
      id: c.id || `call_${c.name || 'x'}`,
      type: 'function',
      function: { name: c.name, arguments: c.args || '{}' },
    }))
    .filter((c) => c.function.name);

  return { text: content, reasoning, toolCalls: toolCalls.length ? toolCalls : null, usage, finish };
}
