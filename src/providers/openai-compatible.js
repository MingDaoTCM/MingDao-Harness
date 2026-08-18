// OpenAI 兼容协议的 HTTP + SSE 流式客户端。
// DeepSeek、OpenAI、Qwen、GLM、Moonshot 以及绝大多数模型网关都走这一层。

export async function chat({ baseUrl, apiKey, model, messages, tools, temperature, maxTokens, signal, onDelta, includeUsage = true }) {
  const url = String(baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const payload = { model, messages };
  if (temperature != null) payload.temperature = temperature;
  if (tools && tools.length) {
    payload.tools = tools;
    payload.tool_choice = 'auto';
  }
  if (maxTokens) payload.max_tokens = maxTokens;
  payload.stream = true;
  // 流式响应默认不带 usage，显式请求以便展示 token/费用统计
  // （部分网关不支持该字段，可在 config.json 设 "includeUsage": false 关闭）
  if (includeUsage) payload.stream_options = { include_usage: true };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    const e = new Error(`网络请求失败：${err?.message || err}`);
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
    const e = new Error(`[${model}] API 错误 ${res.status}: ${detail}`);
    e.status = res.status;
    throw e;
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const json = await res.json().catch(() => null);
    if (!json) throw new Error(`[${model}] 响应解析失败。`);
    return parseNonStream(json, onDelta);
  }
  return parseStream(res.body, onDelta);
}

export function parseNonStream(json, onDelta) {
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
export async function parseStream(body, onDelta) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  const calls = new Map(); // index -> {id, name, args}
  let usage = null;
  let finish = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        finish = finish || 'stop';
        continue;
      }
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = json?.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      if (d.content) {
        content += d.content;
        onDelta?.({ text: d.content });
      }
      if (d.reasoning_content) {
        reasoning += d.reasoning_content;
        onDelta?.({ reasoning: d.reasoning_content });
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const idx = tc.index ?? 0;
          let cur = calls.get(idx);
          if (!cur) {
            cur = { id: tc.id ?? '', name: '', args: '' };
            calls.set(idx, cur);
          }
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
      if (json.usage) usage = json.usage;
    }
  }

  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => ({
      id: c.id || `call_${c.name || 'x'}`,
      type: 'function',
      function: { name: c.name, arguments: c.args || '{}' },
    }))
    .filter((c) => c.function.name);

  return { text: content, reasoning, toolCalls: toolCalls.length ? toolCalls : null, usage, finish };
}
