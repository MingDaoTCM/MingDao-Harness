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

/**
 * 官方明确支持应用全家桶（server tools / safety_check / title）的模型 ID **精确表**。
 *
 * 为什么必须是精确表而不是子串匹配：v0.8.1 用 `/deepseek-flash/i`，会让
 * `custom-deepseek-flash-experimental`、`notdeepseek-flash` 这类名字通过能力门；
 * 请求随后带着服务端工具打到上游 → 400，用户只看到晦涩错误。
 *
 * 表里只放**官方 API id**。旧名/别名（如 models.js 的兼容别名）不在这里硬编码字面量：
 * 它们统一走 `resolveAppModel()` 的回落（等价到同一个官方模型），避免默认模型名散落多处
 * （`test/smoke.js` §86 的结构守卫：旧名字面量只允许出现在 `src/models.js`）。
 * 新增官方模型必须同时改这张表与回归断言，不写无边界正则。
 */
export const APP_TOOL_MODEL_IDS = Object.freeze([APP_DEFAULT_MODEL]);

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
 * 是否是可开启应用工具的模型（精确匹配官方 id，不做任意子串匹配）。
 * 不是它时**不要**下发 server tools / safety_check / title——否则 400。
 * 大小写与首尾空白归一后再查表（` DeepSeek-Flash ` 视为同一个官方 id）。
 * @param {string} model
 * @returns {boolean}
 */
export function supportsAppTools(model) {
  const id = String(model || '').trim().toLowerCase();
  return Boolean(id) && APP_TOOL_MODEL_IDS.includes(id);
}

/**
 * 解析本次应用请求实际使用的模型：`cfg.appApi.model` 优先，其次 `cfg.model`；
 * 候选值经 `supportsAppTools()` 校验，**不支持或缺失一律回落 `APP_DEFAULT_MODEL`**。
 *
 * 为什么必须在这里收口：CLI（`commands/app.js`）、Web（`web/app-mode.js`）与配置归一化
 * 如果各自保留一份“未支持也照发”的解析，就会出现「闸门看的是 flash、实际发的是 pro」，
 * 请求携带服务端工具 → 上游 400。单一判据保证三处结论一致。
 * @param {any} cfg
 * @returns {string}
 */
export function resolveAppModel(cfg) {
  const appModel = cfg && typeof cfg === 'object' ? cfg.appApi?.model : undefined;
  const candidate = typeof appModel === 'string' && appModel.trim()
    ? appModel.trim()
    : (cfg && typeof cfg === 'object' && typeof cfg.model === 'string' ? cfg.model.trim() : '');
  return supportsAppTools(candidate) ? candidate : APP_DEFAULT_MODEL;
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
  // `stream: true` 是**协议必填**：本客户端只会走 SSE。不下发时上游可能回整包 JSON，
  // v0.8.1 会把它当空流返回 ok:true（静默丢正文）。T01：固定写入，不提供关流开关。
  const body = { model, messages, stream: true };
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

/** `tool_use_id → 该次调用对应的 search/fetch 配对记录` 的索引（挂在聚合结果对象上）。
 *  官方明确：**按 tool_use_id 配对**，因为多个调用会先全部到达、结果随后才到（深度思考搜索尤甚）；
 *  键只取 `ev.content_block.tool_use_id`（结果块）与 `ev.content_block.id`（调用块）——
 *  外层 `ev.tool_use_id` 不是协议字段，v0.8.1 读错位置导致结果块全部成了孤儿。
 *  未知/缺失 ID **不再回落“最后一个 search”**：宁可不配对（进 blocks 供诊断），也不能把 A 的结果
 *  静默挂到 B 上。配对记录形如 `{ kind:'search', item, resultBlock }` /
 *  `{ kind:'fetch', item, resultItem, resultBlock }`。 */
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
 * 注意：流式路径**不**用它逐行解析——多行 `data:` 必须按事件合并（见 `feedSseLine`），
 * 这里保留给“单行形状”断言与外部诊断。
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
 * 流式 SSE 帧累积状态：一个事件由若干 `event:` / `data:` 行组成，空行结束。
 * @typedef {{event: string, dataLines: string[]}} SseState
 */

/** @returns {SseState} */
function createSseState() {
  return { event: '', dataLines: [] };
}

/**
 * 结束当前事件。同一事件的多个 `data:` 行按 SSE 规范用 `\n` 拼接后交给 JSON 解析；
 * 没有 `data:` 行的事件不产生负载（返回 null）。
 * @param {SseState} state
 * @returns {{event: string, data: string}|null}
 */
function finishSseEvent(state) {
  if (!state.dataLines.length) {
    state.event = '';
    return null;
  }
  const evt = { event: state.event || 'message', data: state.dataLines.join('\n') };
  state.event = '';
  state.dataLines = [];
  return evt;
}

/**
 * 喂入一行（调用方已去掉行尾 `\n` / `\r\n`）。
 * 空行 = 事件定界；`:` 开头是注释/keep-alive；`event:` / `data:` 累积。
 * EOF 的末尾残行也走这里，再由 `finishSseEvent()` 兜底没有空行收尾的残留事件。
 * @param {SseState} state
 * @param {string} line
 * @returns {{event: string, data: string}|null}
 */
function feedSseLine(state, line) {
  if (line === '') return finishSseEvent(state);
  if (line.startsWith(':')) return null;
  const colon = line.indexOf(':');
  const field = colon < 0 ? line : line.slice(0, colon);
  let value = colon < 0 ? '' : line.slice(colon + 1);
  if (value.startsWith(' ')) value = value.slice(1); // SSE：冒号后的单个前导空格属于语法
  if (field === 'event') state.event = value.trim();
  else if (field === 'data') state.dataLines.push(value);
  return null;
}

/**
 * 流式调用 Messages API，边解析边回调；返回聚合结果 + 机器可读终态。
 *
 * `outcome` 是 T01 的单一真源：
 *   · `'ok'`        —— 收到 `message_stop`，正文完整；
 *   · `'truncated'` —— EOF 前没有 `message_stop`（连接提前结束，半截不能算成功）；
 *   · `'failed'`    —— 非 SSE 2xx、坏 JSON 帧、`event:error` / `{error}` 帧、reader 异常、HTTP 错误；
 *   · `'refused'`   —— `stop_reason:'refusal'`（安全复审拒答，Web 层据此撤回已流出正文）。
 * `ok === true` **仅当** `outcome === 'ok'`；其余终态即使有部分正文也必须失败。
 *
 * 回调 `onDelta` 收到的事件（全部可选，调用方按需渲染）：
 *   { type:'thinking', text } / { type:'text', text } / { type:'citation', url, title }
 *   { type:'search', queries, results } / { type:'fetch', action, url, title }
 *   { type:'title', title } / { type:'usage', usage } / { type:'stop', reason }
 *   { type:'refusal' }（拒答终态，UI 必须撤回已显示的正文）
 *
 * @param {{baseUrl: string, apiKey?: string, model?: string, system?: string, messages?: any[], thinking?: boolean, search?: boolean, readUrl?: boolean, safetyLevel?: 'high'|'low'|'off', title?: boolean, maxTokens?: number, signal?: AbortSignal, onDelta?: (e: any) => void, fetchImpl?: typeof fetch, timeoutMs?: number, hasFiles?: boolean}} p
 * @returns {Promise<{ok: boolean, outcome: 'ok'|'truncated'|'failed'|'refused', error?: string, status?: number, text: string, thinking: string, blocks: any[], citations: any[], searches: any[], fetches: any[], title: string, usage: any, stopReason: string}>}
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
  /** @type {{text: string, thinking: string, blocks: any[], citations: any[], searches: any[], fetches: any[], title: string, usage: any, stopReason: string}} */
  const out = { text: '', thinking: '', blocks: [], citations: [], searches: [], fetches: [], title: '', usage: null, stopReason: '' };
  /** @type {Map<number, any>} */
  const openBlocks = new Map();
  /** @type {any} */
  let reader = null;
  let streamError = '';
  let badFrame = '';
  let sawMessageStop = false;
  let refused = false;
  try {
    let res;
    try {
      res = await fetchImpl(`${root}/anthropic/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      return appFail(errorText(err));
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      return appFail(appErrorMessage(raw) || `HTTP ${res.status}`, res.status);
    }
    // T01：读 body **之前**校验成功响应必须是 SSE。v0.8.1 对 2xx JSON 直接 getReader()，
    // 流里没有 SSE 行 → 空正文 + ok:true（把“非流式回包”静默当成功）。
    const contentType = String(res.headers?.get?.('content-type') || '');
    if (!/text\/event-stream/i.test(contentType)) {
      return appFail(
        `响应不是 SSE（Content-Type: ${contentType || '缺失'}），拒绝把非流式响应当成流式成功`,
        res.status,
      );
    }
    reader = /** @type {any} */ (res.body)?.getReader?.();
    if (!reader) return appFail('响应没有可读流');

    /**
     * 处理一个完整 SSE 事件。返回 true 表示遇到终态，停止继续读取。
     * @param {{event: string, data: string}} evt
     * @returns {boolean}
     */
    const dispatch = (evt) => {
      const raw = evt.data;
      if (!raw) {
        if (evt.event === 'error') {
          streamError = '流内 error 事件没有 data';
          return true;
        }
        return false;
      }
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        // T01：坏帧不得静默跳过——即使后面还有 message_stop，也不能把这次回答判成功。
        badFrame = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
        return true;
      }
      if (!payload || typeof payload !== 'object') {
        badFrame = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
        return true;
      }
      /** @type {string} */
      const type = typeof payload.type === 'string' ? payload.type : '';
      if (type === 'message_stop') {
        sawMessageStop = true;
        return true;
      }
      // 官方：生成中途失败时 HTTP 仍是 200，流以错误帧收尾（可能带 usage）。
      // 三种形状都算失败：`event:error`、`{type:'error'}`、无顶层 `type` 但含 `{error:…}`。
      if (evt.event === 'error' || type === 'error' || (!type && payload.error)) {
        streamError = String(payload?.error?.message || payload?.error?.type || payload?.message || '生成中途失败');
        if (payload.usage) out.usage = payload.usage;
        return true;
      }
      // 安全拒答：官方先给 `message_delta.delta.stop_reason='refusal'`，再收 `message_stop`。
      // 已流出的正文撤不回——这里先发拒答终态通知，由 Web 层撤回并改显固定文案。
      if (type === 'message_delta' && payload.delta?.stop_reason === 'refusal' && !refused) {
        refused = true;
        onDelta?.({ type: 'refusal' });
      }
      applyAppEvent(payload, out, openBlocks, onDelta);
      return false;
    };

    const decoder = new TextDecoder();
    const sse = createSseState();
    let buf = '';
    let stopped = false;
    while (!stopped) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let idx = buf.indexOf('\n');
      while (idx >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1); // CRLF
        const evt = feedSseLine(sse, line);
        if (evt && dispatch(evt)) { stopped = true; break; }
        idx = buf.indexOf('\n');
      }
    }
    if (!stopped) {
      // EOF：flush 解码器，把末尾没有换行符的残行也交给解析器，再兜底没有空行收尾的事件。
      buf += decoder.decode();
      if (buf) {
        const line = buf.endsWith('\r') ? buf.slice(0, -1) : buf;
        buf = '';
        const evt = feedSseLine(sse, line);
        if (evt && dispatch(evt)) stopped = true;
      }
      if (!stopped) {
        const tail = finishSseEvent(sse);
        if (tail) dispatch(tail);
      }
    }
  } catch (err) {
    return { ...out, ok: false, outcome: 'failed', error: errorText(err) };
  } finally {
    // T01：无论成功/失败/提前返回，reader、timeout、外部 abort listener 都必须释放。
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    try { await reader?.cancel?.(); } catch { /* 已关闭/已取消 */ }
  }
  if (badFrame) return { ...out, ok: false, outcome: 'failed', error: `应用接口返回无法解析的帧：${badFrame}` };
  if (streamError) return { ...out, ok: false, outcome: 'failed', error: streamError };
  if (refused) return { ...out, ok: false, outcome: 'refused', error: '安全拒答：服务端撤回了本次回答' };
  if (!sawMessageStop) {
    return {
      ...out,
      ok: false,
      outcome: 'truncated',
      error: '流在 message_stop 之前结束（响应被截断）',
    };
  }
  return { ...out, ok: true, outcome: 'ok' };
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
        if (id) pairingOf(out).set(id, { kind: 'search', item, resultBlock: null });
        onDelta?.({ type: 'search', queries: item.queries, kind, results: [] });
      } else if (action === 'open_page' || action === 'read_link' || action === 'find_in_page') {
        const item = { id, action, url: block.input?.url || '', kind };
        if (id) pairingOf(out).set(id, { kind: 'fetch', item, resultItem: null, resultBlock: null });
        onDelta?.({ type: 'fetch', action, url: block.input?.url || '', kind });
      }
      return;
    }
    if (block.type === 'web_search_tool_result') {
      const results = (block.content || []).filter((/** @type {any} */ r) => r && r.type === 'web_search_result');
      // 官方配对键在 `content_block.tool_use_id`；外层 `ev.tool_use_id` 不是协议字段（v0.8.1 读错位置）。
      const id = String(block.tool_use_id || '');
      const pair = id ? pairingOf(out).get(id) : undefined;
      const paired = Boolean(pair && pair.kind === 'search');
      // 同一 ID 重复结果：明确“后者替换前者”——重写挂回该调用的 results，不追加、不串到别的调用。
      if (paired) pair.item.results = results;
      /** @type {any} */
      let entry = paired ? pair.resultBlock : null;
      if (entry) Object.assign(entry, { type: 'search_result', id, results, paired });
      else {
        entry = { type: 'search_result', id, results, paired };
        out.blocks.push(entry);
        if (paired) pair.resultBlock = entry;
      }
      // 未知/缺失 ID：**不猜“最后一次搜索”**（并发时会把 A 的结果静默挂到 B）。
      // 结果块仍进 `out.blocks` 并带 tool_use_id 供诊断，但不改任何已有 search。
      if (paired) onDelta?.({ type: 'search', queries: pair.item.queries, kind: block.kind, results });
      return;
    }
    if (block.type === 'web_fetch_tool_result') {
      const content = block.content || {};
      const id = String(block.tool_use_id || '');
      const item = { id, url: content.url || '', title: content.content?.title || '', error: content.type === 'web_fetch_tool_result_error' ? content.error_code : '', signature: block.signature || '' };
      const pair = id ? pairingOf(out).get(id) : undefined;
      if (pair && pair.kind === 'fetch' && pair.resultItem) {
        // 同一 ID 重复结果：后者替换前者（原地覆盖，避免同一次抓取出现两条互相矛盾的记录）。
        Object.assign(pair.resultItem, item);
        if (pair.resultBlock) Object.assign(pair.resultBlock, { type: 'fetch_result', ...item });
      } else {
        out.fetches.push(item);
        const entry = { type: 'fetch_result', ...item };
        out.blocks.push(entry);
        if (pair && pair.kind === 'fetch') { pair.resultItem = item; pair.resultBlock = entry; }
      }
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

/**
 * 把任意抛出值归一成可见错误文案（AbortError 等也要有可读原因，不能变成空字符串）。
 * @param {any} err
 * @returns {string}
 */
function errorText(err) {
  const message = String(err?.message || err || '').trim();
  return message || '应用接口调用失败';
}

/**
 * @param {string} error
 * @param {number} [status]
 * @returns {{ok: false, outcome: 'failed', error: string, status: number|undefined, text: string, thinking: string, blocks: any[], citations: any[], searches: any[], fetches: any[], title: string, usage: any, stopReason: string}}
 */
function appFail(error, status) {
  return {
    ok: false, outcome: 'failed', error, status,
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
