// DeepSeek「应用全家桶」API 客户端（v0.8.0）。
//
// 背景：2026-11-13 DeepSeek 把 App 的对话能力直接开在原有 API 上——联网搜索、深度思考搜索、
// 阅读链接、文件输入、安全校验、会话标题、日期/位置提醒；语音与 OCR/ASR/TTS 另开独立接口。
// 参考：https://api-docs.deepseek.com/guides/build_a_chatbot 与 https://github.com/deepseek-ai/chat-demo
//
// 为什么对本项目是**性能**改进（不是又一个功能）：
//   · 搜索/阅读由**服务端**执行：一次请求内多步完成，客户端不再「模型→工具→再发一次全上下文」
//     来回倒腾。会话越长，省下的重发 token 与往返延迟越多。
//   · 会话标题随 `message_delta` 一次返回：省掉 MDH 原本单独调用一次模型的标题生成（每会话 1 次请求）。
//   · 文件（PDF/Office/图片）由服务端解析成图文混排上下文：客户端不再整包读文本再塞进消息。
//
// 协议要点（以官方文档与 chat-demo 源码为准）：
//   · 会话：POST {base}/anthropic/v1/messages（Anthropic Messages 风格，`x-api-key` 鉴权）；
//   · 文件：POST {base}/anthropic/v1/files（multipart，`purpose` 字段必须排在 `file` 之前；
//     引用文件的请求要带 `anthropic-beta: files-api-2025-04-14`）；
//   · 语音：POST {base}/v1/tools/asr（multipart）、POST {base}/v1/tools/tts（JSON，返回裸 PCM）；
//   · 服务端工具（`deepseek_web_search` / `deepseek_read_url`）**不能与客户端工具同时声明**，
//     所以这条路径只用于「纯对话/搜索」模式；动作类 Agent 回合仍走 tools + OpenAI 兼容路径。
//
// 本模块保持零依赖、可注入 fetch（单测不触网）。

/** 支持应用全家桶能力的默认模型（官方：V4.1-Flash / deepseek-flash）。 */
export const APP_DEFAULT_MODEL = 'deepseek-flash';

/** 引用 Files API 上传文件时必带的 beta 头。 */
export const FILES_BETA = 'files-api-2025-04-14';

/** TTS 返回的裸 PCM 参数（官方：24kHz、单声道、16-bit 小端）。 */
export const TTS_SAMPLE_RATE = 24000;

/**
 * 去掉尾部斜杠的 API 根（如 `https://api.deepseek.com`）。
 * @param {string} baseUrl
 * @returns {string}
 */
export function apiRoot(baseUrl) {
  // 兼容三种常见写法：`https://api.deepseek.com`、`.../v1`（OpenAI 兼容预设）、`.../anthropic/v1`。
  // 不归一就会拼成 `/v1/anthropic/v1/messages`（404）——provider.appChat 直接透传 baseUrl 时必须挡住。
  let s = String(baseUrl || '').trim().replace(/\/+$/, '');
  s = s.replace(/\/anthropic\/v1$/i, '').replace(/\/+$/, '');
  s = s.replace(/\/v1$/i, '').replace(/\/+$/, '');
  return s;
}

/**
 * 是否是可开启应用工具的模型（官方目前只有 deepseek-flash 系列）。
 * 不是它时**不要**下发 server tools / safety_check / title——否则 400。
 * @param {string} model
 * @returns {boolean}
 */
export function supportsAppTools(model) {
  return /deepseek-flash/i.test(String(model || ''));
}

/**
 * 构造 Messages 请求体（纯函数，便于逐条钉边界）。
 * @param {{model?: string, system?: string, messages?: any[], thinking?: boolean, search?: boolean, readUrl?: boolean, safetyLevel?: 'high'|'low'|'off', title?: boolean, maxTokens?: number}} [opts]
 * @returns {Record<string, any>}
 */
export function buildAppRequest({
  model = APP_DEFAULT_MODEL,
  system,
  messages = [],
  thinking = false,
  search = false,
  readUrl = true,
  safetyLevel = 'high',
  title = false,
  maxTokens,
} = {}) {
  /** @type {Record<string, any>} */
  const body = { model, messages };
  if (system) body.system = String(system);
  body.thinking = { type: thinking ? 'enabled' : 'disabled' };
  /** @type {any[]} */
  const tools = [];
  // 阅读链接默认开（与官方 demo 一致）；搜索开关单独控制（含「边想边搜」）。
  if (readUrl) tools.push({ type: 'deepseek_read_url', name: 'deepseek_read_url' });
  if (search) tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' });
  if (tools.length) body.tools = tools;
  if (safetyLevel && safetyLevel !== 'off') body.safety_check = { level: safetyLevel };
  if (title) body.title = { enabled: true };
  if (maxTokens) body.max_tokens = maxTokens;
  return body;
}

/** `tool_use_id → 该次调用对应的 search/fetch 条目` 的配对索引（挂在聚合结果对象上）。
 *  官方明确：**按 tool_use_id 配对**，因为多个调用会先全部到达、结果随后才到（深度思考搜索尤甚）；
 *  用「最后一个 search」挂结果会在并发调用时把 A 的结果写到 B 上，A 静默变空。 */
const pairIndex = new WeakMap();

/** @param {any} out */
function pairingOf(/** @type {any} */ out) {
  let m = pairIndex.get(out);
  if (!m) {
    m = new Map();
    pairIndex.set(out, m);
  }
  return /** @type {Map<string, any>} */ (m);
}

/**
 * 把「日期/星期/地点/渠道/语言」拼成官方约定的 latest_reminder 文本。
 * 官方 demo：`2026-11-14,Saturday,浙江杭州,Web,中文`（五项逗号分隔，日期用**本地**时区）。
 * @param {{now?: Date, weekday?: string, location?: string, channel?: string, language?: string}} [opts]
 * @returns {string}
 */
export function buildLatestReminder({ now = new Date(), weekday, location = '', channel = 'Web', language = '中文' } = {}) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const wd = weekday || ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];
  return [date, wd, location, channel, language].join(',');
}

/**
 * 解析一行 SSE（`event:` / `data:` / 注释 / 空行）。返回 null 表示这行不产生事件。
 * @param {string} line
 * @returns {{event?: string, data?: string}|null}
 */
export function parseSseLine(line) {
  const s = String(line || '');
  if (!s || s.startsWith(':')) return null; // 空行与 keep-alive 注释
  if (s.startsWith('event:')) return { event: s.slice(6).trim() };
  if (s.startsWith('data:')) return { data: s.slice(5).trim() };
  return null;
}

/**
 * 流式调用 Messages API，边解析边回调；返回聚合结果。
 *
 * 回调 `onDelta` 收到的事件（全部可选，调用方按需渲染）：
 *   { type:'thinking', text } / { type:'text', text } / { type:'citation', url, title }
 *   { type:'search', queries, results } / { type:'fetch', action, url, title }
 *   { type:'title', title } / { type:'usage', usage } / { type:'stop', reason }
 *
 * @param {{baseUrl: string, apiKey?: string, model?: string, system?: string, messages?: any[], thinking?: boolean, search?: boolean, readUrl?: boolean, safetyLevel?: 'high'|'low'|'off', title?: boolean, maxTokens?: number, signal?: AbortSignal, onDelta?: (e: any) => void, fetchImpl?: typeof fetch, timeoutMs?: number, hasFiles?: boolean}} p
 * @returns {Promise<{ok: boolean, error?: string, status?: number, text: string, thinking: string, blocks: any[], citations: any[], searches: any[], fetches: any[], title: string, usage: any, stopReason: string}>}
 */
export async function streamAppChat({
  baseUrl,
  apiKey,
  model = APP_DEFAULT_MODEL,
  system,
  messages = [],
  thinking = false,
  search = false,
  readUrl = true,
  safetyLevel = 'high',
  title = false,
  maxTokens,
  signal,
  onDelta,
  fetchImpl = globalThis.fetch,
  timeoutMs = 600000,
  hasFiles = false,
} = /** @type {any} */ ({})) {
  const root = apiRoot(baseUrl);
  if (!root) return appFail('缺少 baseUrl');
  const body = buildAppRequest({ model, system, messages, thinking, search, readUrl, safetyLevel, title, maxTokens });
  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (apiKey) headers['x-api-key'] = String(apiKey);
  if (hasFiles) headers['anthropic-beta'] = FILES_BETA;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new Error('应用接口请求超时')), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${root}/anthropic/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return appFail(String(/** @type {any} */ (err)?.message || err));
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    clearTimeout(timer);
    return appFail(appErrorMessage(raw) || `HTTP ${res.status}`, res.status);
  }
  /** @type {{text: string, thinking: string, blocks: any[], citations: any[], searches: any[], fetches: any[], title: string, usage: any, stopReason: string}} */
  const out = { text: '', thinking: '', blocks: [], citations: [], searches: [], fetches: [], title: '', usage: null, stopReason: '' };
  /** @type {Map<number, any>} */
  const openBlocks = new Map();
  let streamError = '';
  try {
    const reader = /** @type {any} */ (res.body)?.getReader?.();
    if (!reader) return appFail('响应没有可读流');
    const decoder = new TextDecoder();
    let buf = '';
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let idx = buf.indexOf('\n');
      while (idx >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        const parsed = parseSseLine(line);
        if (parsed?.data) {
          let payload = null;
          try { payload = JSON.parse(parsed.data); } catch { payload = null; }
          if (payload && payload.type === 'message_stop') { done = true; break; }
          // 官方：生成中途失败时 HTTP 200、流以 `error` 事件收尾（可能还带 usage）。
          // 不识别就会把"半截回答"当成成功返回——这类静默截断比报错危险。
          if (payload && payload.type === 'error') {
            streamError = String(payload?.error?.message || payload?.error?.type || '生成中途失败');
            if (payload.usage) out.usage = payload.usage;
            done = true;
            break;
          }
          if (payload) applyAppEvent(payload, out, openBlocks, onDelta);
        }
        idx = buf.indexOf('\n');
      }
    }
  } catch (err) {
    clearTimeout(timer);
    return { ...out, ok: false, error: String(/** @type {any} */ (err)?.message || err) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
  if (streamError) return { ...out, ok: false, error: streamError };
  return { ...out, ok: true };
}

/**
 * 把一个流事件并入聚合结果（纯函数式：只改传入的 out/openBlocks）。
 * 单独导出便于用录制帧做单测，不必起网络。
 * @param {any} ev
 * @param {{text:string, thinking:string, blocks:any[], citations:any[], searches:any[], fetches:any[], title:string, usage:any, stopReason:string}} out
 * @param {Map<number, any>} openBlocks
 * @param {(e:any)=>void} [onDelta]
 */
export function applyAppEvent(ev, out, openBlocks, onDelta) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.type === 'message_start') {
    if (ev.message?.usage) out.usage = ev.message.usage;
    return;
  }
  if (ev.type === 'content_block_start') {
    const block = ev.content_block || {};
    const index = Number(ev.index ?? 0);
    openBlocks.set(index, block);
    if (block.type === 'thinking') return;
    if (block.type === 'text') { if (block.text) { out.text += block.text; onDelta?.({ type: 'text', text: block.text }); } return; }
    if (block.type === 'server_tool_use') {
      const action = block.input?.action || '';
      const kind = block.kind || '';
      const id = String(block.id || '');
      out.blocks.push({ type: 'tool_use', id, name: block.name, action, kind, url: block.input?.url || '', queries: block.input?.queries || [] });
      if (action === 'search') {
        const item = { id, queries: block.input?.queries || [], kind, results: [] };
        out.searches.push(item);
        if (id) pairingOf(out).set(id, item);
        onDelta?.({ type: 'search', queries: item.queries, kind, results: [] });
      } else if (action === 'open_page' || action === 'read_link' || action === 'find_in_page') {
        const item = { id, action, url: block.input?.url || '', kind };
        if (id) pairingOf(out).set(id, item);
        onDelta?.({ type: 'fetch', action, url: block.input?.url || '', kind });
      }
      return;
    }
    if (block.type === 'web_search_tool_result') {
      const results = (block.content || []).filter((/** @type {any} */ r) => r && r.type === 'web_search_result');
      const id = String(ev.tool_use_id || '');
      const target = (id && pairingOf(out).get(id)) || out.searches[out.searches.length - 1];
      if (target) target.results = results;
      out.blocks.push({ type: 'search_result', id, results });
      if (target) onDelta?.({ type: 'search', queries: target.queries, kind: block.kind, results });
      return;
    }
    if (block.type === 'web_fetch_tool_result') {
      const content = block.content || {};
      const id = String(ev.tool_use_id || '');
      const item = { id, url: content.url || '', title: content.content?.title || '', error: content.type === 'web_fetch_tool_result_error' ? content.error_code : '', signature: block.signature || '' };
      out.fetches.push(item);
      out.blocks.push({ type: 'fetch_result', ...item });
      onDelta?.({ type: 'fetch', action: 'result', ...item });
      return;
    }
    return;
  }
  if (ev.type === 'content_block_delta') {
    const delta = ev.delta || {};
    if (delta.type === 'thinking_delta' && delta.thinking) { out.thinking += delta.thinking; onDelta?.({ type: 'thinking', text: delta.thinking }); }
    else if (delta.type === 'signature_delta') { /* 签名用于多轮回传原块，这里不需要 */ }
    else if (delta.type === 'text_delta' && delta.text) { out.text += delta.text; onDelta?.({ type: 'text', text: delta.text }); }
    else if (delta.type === 'citations_delta' && delta.citation) {
      const c = { url: delta.citation.url || '', title: delta.citation.title || '', cited: delta.citation.cited_text || '' };
      out.citations.push(c);
      onDelta?.({ type: 'citation', ...c });
    }
    return;
  }
  if (ev.type === 'message_delta') {
    const delta = ev.delta || {};
    if (delta.title) { out.title = String(delta.title); onDelta?.({ type: 'title', title: out.title }); }
    if (delta.stop_reason) { out.stopReason = String(delta.stop_reason); onDelta?.({ type: 'stop', reason: out.stopReason }); }
    if (ev.usage) { out.usage = ev.usage; onDelta?.({ type: 'usage', usage: ev.usage }); }
    return;
  }
}

/**
 * 从错误响应体里取可读消息（`{error:{message}}` 或纯文本）。
 * @param {string} raw
 * @returns {string}
 */
export function appErrorMessage(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const json = JSON.parse(text);
    const msg = json?.error?.message || json?.message;
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  } catch { /* 纯文本 */ }
  return text.slice(0, 500);
}

/** @param {string} error @param {number} [status] */
function appFail(error, status) {
  return {
    ok: false, error, status,
    text: '', thinking: '', blocks: [], citations: [], searches: [], fetches: [], title: '', usage: null, stopReason: '',
  };
}

/**
 * 上传文件到 Files API（PDF/Office → 版面解析；文本/表格/电子书 → user_data）。
 * 注意：`purpose` 必须排在 `file` 之前，否则 400。
 * @param {{baseUrl: string, apiKey?: string, data: Uint8Array|ArrayBuffer|string, filename: string, purpose?: 'rich_layout_recognition'|'user_data', mime?: string, signal?: AbortSignal, fetchImpl?: typeof fetch, timeoutMs?: number}} p
 * @returns {Promise<{ok: boolean, error?: string, status?: number, fileId?: string, bytes?: number}>}
 */
export async function uploadAppFile({
  baseUrl, apiKey, data, filename, purpose = 'rich_layout_recognition', mime = 'application/octet-stream', signal, fetchImpl = globalThis.fetch, timeoutMs = 300000,
} = /** @type {any} */ ({})) {
  const root = apiRoot(baseUrl);
  if (!root) return { ok: false, error: '缺少 baseUrl' };
  const form = new FormData();
  form.append('purpose', purpose);
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const blob = new Blob([/** @type {any} */ (bytes)], { type: mime });
  form.append('file', blob, filename);
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(new Error('文件上传超时')); } catch {} }, timeoutMs);
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    /** @type {Record<string, string>} */
    const headers = { 'anthropic-beta': FILES_BETA };
    if (apiKey) headers['x-api-key'] = String(apiKey);
    const res = await fetchImpl(`${root}/anthropic/v1/files`, { method: 'POST', headers, body: form, signal: ctrl.signal });
    const raw = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, status: res.status, error: appErrorMessage(raw) || `HTTP ${res.status}` };
    let json = null;
    try { json = JSON.parse(raw); } catch { json = null; }
    if (!json?.id) return { ok: false, status: res.status, error: '上传成功但没有返回 file_id' };
    return { ok: true, status: res.status, fileId: String(json.id), bytes: Number(json.size_bytes || json.bytes || 0) };
  } catch (err) {
    return { ok: false, error: String(/** @type {any} */ (err)?.message || err) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * 语音识别（ASR）：上传 WAV/Ogg Opus，返回全文。
 * @param {{baseUrl: string, apiKey?: string, audio: Uint8Array|ArrayBuffer, filename?: string, mime?: string, signal?: AbortSignal, fetchImpl?: typeof fetch, timeoutMs?: number}} p
 * @returns {Promise<{ok: boolean, error?: string, text?: string, status?: number}>}
 */
export async function transcribeAudio({ baseUrl, apiKey, audio, filename = 'recording.wav', mime = 'audio/wav', signal, fetchImpl = globalThis.fetch, timeoutMs = 180000 } = /** @type {any} */ ({})) {
  const root = apiRoot(baseUrl);
  if (!root) return { ok: false, error: '缺少 baseUrl' };
  const form = new FormData();
  form.append('file', new Blob([/** @type {any} */ (audio)], { type: mime }), filename);
  /** @type {Record<string, string>} */
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('ASR 超时')), timeoutMs);
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchImpl(`${root}/v1/tools/asr`, { method: 'POST', headers, body: form, signal: ctrl.signal });
    const raw = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, status: res.status, error: appErrorMessage(raw) || `HTTP ${res.status}` };
    let json = null;
    try { json = JSON.parse(raw); } catch { json = null; }
    if (typeof json?.text !== 'string') return { ok: false, status: res.status, error: 'ASR 返回格式不符合预期' };
    return { ok: true, status: res.status, text: json.text };
  } catch (err) {
    return { ok: false, error: String(/** @type {any} */ (err)?.message || err) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * 语音合成（TTS）：返回裸 PCM 字节（24kHz 单声道 16-bit 小端）。
 * @param {{baseUrl: string, apiKey?: string, text: string, voice?: 'stella'|'tide', format?: 'pcm', filterMarkdown?: boolean, signal?: AbortSignal, fetchImpl?: typeof fetch, timeoutMs?: number}} p
 * @returns {Promise<{ok: boolean, error?: string, pcm?: Uint8Array, status?: number}>}
 */
export async function synthesizeSpeech({ baseUrl, apiKey, text, voice = 'stella', format = 'pcm', filterMarkdown = true, signal, fetchImpl = globalThis.fetch, timeoutMs = 180000 } = /** @type {any} */ ({})) {
  const root = apiRoot(baseUrl);
  if (!root) return { ok: false, error: '缺少 baseUrl' };
  if (!String(text || '').trim()) return { ok: false, error: '没有可朗读的文本' };
  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('TTS 超时')), timeoutMs);
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchImpl(`${root}/v1/tools/tts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, voice_id: voice, format, filter_markdown: filterMarkdown }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: appErrorMessage(raw) || `HTTP ${res.status}` };
    }
    const buf = await res.arrayBuffer();
    return { ok: true, status: res.status, pcm: new Uint8Array(buf) };
  } catch (err) {
    return { ok: false, error: String(/** @type {any} */ (err)?.message || err) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}
