// DeepSeek「应用全家桶」API 客户端回归（v0.8.0）。
//
// 为什么单独一套：这条路径的**协议形状**与 OpenAI 兼容层完全不同（Anthropic Messages 风格 +
// 服务端工具块 + 引用 + 标题），而且它是「性能」路径（服务端搜索/标题替代客户端多轮往返）。
// 一旦形状错了，表现是"能跑但搜索块/引用/标题全丢"——不会报错，所以必须逐块钉死。
import assert from 'node:assert/strict';
import {
  APP_DEFAULT_MODEL, FILES_BETA, TTS_SAMPLE_RATE, apiRoot, supportsAppTools,
  buildAppRequest, buildLatestReminder, parseSseLine, applyAppEvent, streamAppChat,
  uploadAppFile, transcribeAudio, synthesizeSpeech, appErrorMessage,
} from '../src/deepseek-app.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

/** 造一个 SSE 响应体（按官方 demo 的帧顺序）。 */
function sseBody(frames) {
  const text = frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join('') + ': keep-alive\n\n';
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) { controller.close(); return; }
      sent = true;
      controller.enqueue(bytes);
    },
  });
}

// ---------- ① 纯函数：请求体 ----------
{
  const body = buildAppRequest({ model: 'deepseek-flash', system: 'S', messages: [{ role: 'user', content: 'hi' }], thinking: true, search: true, readUrl: true, safetyLevel: 'high', title: true });
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.system, 'S');
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.deepEqual(body.tools.map((t) => t.type), ['deepseek_read_url', 'deepseek_web_search'], '阅读链接在前、搜索在后（与官方 demo 一致）');
  assert.deepEqual(body.safety_check, { level: 'high' });
  assert.deepEqual(body.title, { enabled: true });
  ok('① 请求体：thinking/tools 顺序/safety/title 全部就位');

  const noTools = buildAppRequest({ search: false, readUrl: false, safetyLevel: 'off' });
  assert.equal(noTools.tools, undefined, '两个工具都关时不得下发空 tools');
  assert.equal(noTools.safety_check, undefined, 'safety=off 时不得下发 safety_check');
  assert.deepEqual(noTools.thinking, { type: 'disabled' });
  ok('② 关掉工具与安全时不下发空字段（空 tools 会被上游判非法）');

  assert.equal(supportsAppTools('deepseek-flash'), true);
  assert.equal(supportsAppTools('deepseek-v4-pro'), false, '非 flash 模型不得开应用工具');
  assert.equal(apiRoot('https://api.deepseek.com///'), 'https://api.deepseek.com');
  assert.equal(APP_DEFAULT_MODEL, 'deepseek-flash');
  ok('③ 模型门与 URL 归一化');
}

// ---------- ② latest_reminder ----------
{
  const r = buildLatestReminder({ now: new Date(2026, 10, 14), weekday: 'Saturday', location: '浙江杭州', channel: 'Web', language: '中文' });
  assert.equal(r, '2026-11-14,Saturday,浙江杭州,Web,中文');
  assert.equal(r.split(',').length, 5, '官方约定五项逗号分隔');
  ok('④ latest_reminder：本地日期 + 五项约定');
}

// ---------- ③ SSE 行解析 ----------
{
  assert.equal(parseSseLine(''), null);
  assert.equal(parseSseLine(': keep-alive'), null, 'keep-alive 注释不产生事件');
  assert.deepEqual(parseSseLine('event: message_stop'), { event: 'message_stop' });
  assert.deepEqual(parseSseLine('data: {"type":"x"}'), { data: '{"type":"x"}' });
  ok('⑤ SSE 行：注释/event/data 三态');
}

// ---------- ④ 逐块聚合 ----------
{
  const out = { text: '', thinking: '', blocks: [], citations: [], searches: [], fetches: [], title: '', usage: null, stopReason: '' };
  const open = new Map();
  const events = [];
  const emit = (e) => events.push(e);
  applyAppEvent({ type: 'message_start', message: { usage: { input_tokens: 10 } } }, out, open, emit);
  applyAppEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, out, open, emit);
  applyAppEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想一想' } }, out, open, emit);
  applyAppEvent({ type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', name: 'deepseek_web_search', input: { action: 'search', queries: ['a', 'b'] }, kind: 'search' } }, out, open, emit);
  applyAppEvent({ type: 'content_block_start', index: 2, content_block: { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'T', url: 'https://e.com', snippet: 'S', site_name: 'E' }], kind: 'search' } }, out, open, emit);
  applyAppEvent({ type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } }, out, open, emit);
  applyAppEvent({ type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: '答案' } }, out, open, emit);
  applyAppEvent({ type: 'content_block_delta', index: 3, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://e.com', title: 'T', cited_text: '答案' } } }, out, open, emit);
  applyAppEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn', title: '标题一' }, usage: { output_tokens: 3 } }, out, open, emit);
  assert.equal(out.thinking, '想一想');
  assert.equal(out.text, '答案');
  assert.equal(out.searches.length, 1);
  assert.equal(out.searches[0].queries.length, 2);
  assert.equal(out.searches[0].results[0].url, 'https://e.com', '搜索结果必须挂回发起它的那次 search');
  assert.equal(out.citations.length, 1);
  assert.equal(out.title, '标题一', '服务端标题必须取出来（替代客户端单独调一次模型）');
  assert.equal(out.stopReason, 'end_turn');
  assert.equal(out.usage.output_tokens, 3);
  assert.ok(events.some((e) => e.type === 'search'), '搜索步骤要回调给 UI');
  assert.ok(events.some((e) => e.type === 'citation'), '引用要回调给 UI');
  ok('⑥ 逐块聚合：thinking/搜索+结果/正文/引用/标题/usage 全接住');

  const out2 = { text: '', thinking: '', blocks: [], citations: [], searches: [], fetches: [], title: '', usage: null, stopReason: '' };
  applyAppEvent({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', name: 'deepseek_read_url', input: { action: 'read_link', url: 'https://a.com' }, kind: 'read_link' } }, out2, new Map());
  applyAppEvent({ type: 'content_block_start', index: 1, content_block: { type: 'web_fetch_tool_result', content: { type: 'web_fetch_result', url: 'https://a.com', content: { title: 'A' } }, kind: 'read_link', signature: 'sig' } }, out2, new Map());
  assert.equal(out2.fetches.length, 1);
  assert.equal(out2.fetches[0].title, 'A');
  assert.equal(out2.fetches[0].signature, 'sig', 'read_link 的 signature 必须保留（多轮回传靠它还原页面）');
  ok('⑦ 阅读链接：url/title/signature 保留');

  const out3 = { text: '', thinking: '', blocks: [], citations: [], searches: [], fetches: [], title: '', usage: null, stopReason: '' };
  applyAppEvent({ type: 'content_block_start', index: 0, content_block: { type: 'web_fetch_tool_result', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_allowed' }, kind: 'read_link' } }, out3, new Map());
  assert.equal(out3.fetches[0].error, 'url_not_allowed', '失败结果要带错误码（安全审核会返回它）');
  ok('⑧ 阅读失败：错误码透出');
}

// ---------- ⑤ streamAppChat 端到端（假 fetch） ----------
{
  const frames = [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '思考' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', name: 'deepseek_web_search', input: { action: 'search', queries: ['q'] }, kind: 'deep_search' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'T', url: 'https://e.com' }], kind: 'deep_search' } },
    { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: '答' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', title: 'T1' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  let seenUrl = '', seenBody = null, seenHeaders = /** @type {any} */ ({});
  const fakeFetch = async (url, init) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init.body));
    seenHeaders = init.headers;
    return new Response(sseBody(frames), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const r = await streamAppChat({
    baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-flash',
    system: 'SYS', messages: [{ role: 'user', content: 'q' }], thinking: true, search: true, title: true,
    fetchImpl: /** @type {any} */ (fakeFetch),
  });
  assert.equal(seenUrl, 'https://api.deepseek.com/anthropic/v1/messages', '端点必须是 Anthropic Messages');
  assert.equal(seenHeaders['x-api-key'], 'k', '鉴权走 x-api-key');
  assert.equal(seenBody.system, 'SYS');
  assert.equal(seenBody.title.enabled, true);
  assert.equal(r.ok, true);
  assert.equal(r.thinking, '思考');
  assert.equal(r.text, '答');
  assert.equal(r.title, 'T1');
  assert.equal(r.searches.length, 1);
  assert.equal(r.searches[0].results[0].url, 'https://e.com');
  assert.equal(r.stopReason, 'end_turn');
  ok('⑨ streamAppChat：真实 SSE 帧驱动，聚合结果与请求形状都对');

  const errFetch = async () => new Response(JSON.stringify({ error: { message: '内容存在风险' } }), { status: 400 });
  const bad = await streamAppChat({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', fetchImpl: /** @type {any} */ (errFetch) });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.equal(bad.error, '内容存在风险', '错误消息要透出，不能变成 "HTTP 400"');
  ok('⑩ 上游错误：取出 error.message 而不是只报状态码');

  assert.equal(appErrorMessage('<html>bad</html>'), '<html>bad</html>');
  assert.equal(appErrorMessage(''), '');
  ok('⑪ 非 JSON 错误体：原样截断保留');
}

// ---------- ⑥ 文件上传 ----------
{
  let formBody = null, headers = /** @type {any} */ ({});
  const fakeFetch = async (url, init) => {
    formBody = init.body;
    headers = init.headers;
    return new Response(JSON.stringify({ id: 'file-abc', size_bytes: 12 }), { status: 200 });
  };
  const r = await uploadAppFile({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', data: 'hello', filename: 'a.txt', purpose: 'user_data', fetchImpl: /** @type {any} */ (fakeFetch) });
  assert.equal(r.ok, true);
  assert.equal(r.fileId, 'file-abc');
  assert.equal(headers['anthropic-beta'], FILES_BETA, '文件请求必须带 beta 头');
  const entries = [...formBody.entries()];
  assert.equal(entries[0][0], 'purpose', 'purpose 必须排在 file 之前（官方明确要求，否则 400）');
  assert.equal(entries[0][1], 'user_data');
  assert.equal(entries[1][0], 'file');
  ok('⑫ 文件上传：beta 头 + purpose 先于 file + file_id 解析');

  const badFetch = async () => new Response(JSON.stringify({ error: { message: '解析失败' } }), { status: 400 });
  const bad = await uploadAppFile({ baseUrl: 'https://api.deepseek.com', data: 'x', filename: 'a.pdf', fetchImpl: /** @type {any} */ (badFetch) });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, '解析失败');
  ok('⑬ 上传失败：错误透出，不伪造 file_id');
}

// ---------- ⑦ 语音 ----------
{
  let asrForm = null;
  const asrFetch = async (url, init) => { asrForm = init.body; return new Response(JSON.stringify({ text: '你好' }), { status: 200 }); };
  const asr = await transcribeAudio({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', audio: new Uint8Array([1, 2]), fetchImpl: /** @type {any} */ (asrFetch) });
  assert.equal(asr.ok, true);
  assert.equal(asr.text, '你好');
  assert.equal(String(asrForm.get('file')?.name || asrForm.get('file')?.constructor?.name || ''), 'recording.wav');
  ok('⑭ ASR：multipart 上传并取回 text');

  let ttsBody = null, ttsHeaders = /** @type {any} */ ({});
  const ttsFetch = async (url, init) => { ttsBody = JSON.parse(String(init.body)); ttsHeaders = init.headers; return new Response(new Uint8Array([9, 8, 7]), { status: 200 }); };
  const tts = await synthesizeSpeech({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', text: '朗读我', voice: 'tide', fetchImpl: /** @type {any} */ (ttsFetch) });
  assert.equal(tts.ok, true);
  assert.deepEqual([...tts.pcm], [9, 8, 7]);
  assert.equal(ttsBody.voice_id, 'tide');
  assert.equal(ttsBody.format, 'pcm');
  assert.equal(ttsBody.filter_markdown, true);
  assert.equal(ttsHeaders.Authorization, 'Bearer k', '语音接口用 Bearer 而非 x-api-key');
  assert.equal(TTS_SAMPLE_RATE, 24000);
  ok('⑮ TTS：voice_id/format/filter_markdown + Bearer 鉴权 + 裸 PCM');
}

// ---------- ⑧ 生成中途失败：流以 error 事件收尾（HTTP 仍是 200） ----------
{
  const frames = [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半截' } },
    { type: 'error', error: { type: 'api_error', message: 'The model failed to generate a complete response.' }, usage: { output_tokens: 1 } },
  ];
  const fakeFetch = async () => new Response(sseBody(frames), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const r = await streamAppChat({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', fetchImpl: /** @type {any} */ (fakeFetch) });
  assert.equal(r.ok, false, '流内 error 必须判失败，不能把半截回答当成功');
  assert.match(String(r.error), /failed to generate|中途/);
  assert.equal(r.text, '半截', '已产出的正文保留，便于用户看到进度');
  ok('⑯ 流内 error：判失败但保留已产出正文');
}

// ---------- ⑨ 性能断言：一轮「深度思考搜索」只发 1 次 HTTP 请求 ----------
// 这是「应用模式比工具循环快」的可验证口径：工具循环每搜一次要回到模型再发一次全上下文，
// 而服务端工具在一次请求内完成 search → open_page → find_in_page → 作答。
{
  const frames = [
    { type: 'message_start', message: { usage: { input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先搜' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', name: 'deepseek_web_search', input: { action: 'search', queries: ['q1', 'q2'] }, kind: 'deep_search' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'A', url: 'https://a' }], kind: 'deep_search' } },
    { type: 'content_block_start', index: 3, content_block: { type: 'server_tool_use', name: 'deepseek_web_search', input: { action: 'open_page', url: 'https://a' }, kind: 'deep_search' } },
    { type: 'content_block_start', index: 4, content_block: { type: 'web_fetch_tool_result', content: { type: 'web_fetch_result', url: 'https://a', content: { title: 'A' } }, kind: 'deep_search' } },
    { type: 'content_block_start', index: 5, content_block: { type: 'server_tool_use', name: 'deepseek_web_search', input: { action: 'search', queries: ['q3'] }, kind: 'deep_search' } },
    { type: 'content_block_start', index: 6, content_block: { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'B', url: 'https://b' }], kind: 'deep_search' } },
    { type: 'content_block_start', index: 7, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 7, delta: { type: 'text_delta', text: '答案' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', title: 'T' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  let calls = 0;
  const fakeFetch = async () => { calls += 1; return new Response(sseBody(frames), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); };
  const r = await streamAppChat({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', thinking: true, search: true, fetchImpl: /** @type {any} */ (fakeFetch) });
  assert.equal(calls, 1, '深度思考搜索（2 次搜索 + 1 次开页）必须只发 1 次 HTTP 请求');
  assert.equal(r.searches.length, 2, '两次 search 步骤都要被记录下来');
  assert.equal(r.fetches.length, 1, '开页步骤要记录');
  assert.equal(r.text, '答案');
  assert.equal(r.thinking, '先搜');
  ok('⑰ 性能口径：一次请求内完成多步搜索/开页（客户端往返 = 1）');
}

// ---------- ⑩ 并发调用：结果必须按 tool_use_id 配对（官方原文：Match calls to results by tool_use_id） ----------
// 深度思考搜索会「多个调用先全部到达、结果随后才到」。若按"最后一个 search"挂结果，
// A 的结果会被写到 B 上，A 静默变空——UI 上表现为"搜了但一条结果都没有"。
{
  const out = { text: '', thinking: '', blocks: [], citations: [], searches: [], fetches: [], title: '', usage: null, stopReason: '' };
  const open = new Map();
  const ev = (e) => applyAppEvent(e, out, open);
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_A', name: 'deepseek_web_search', input: { action: 'search', queries: ['A'] }, kind: 'deep_search' } });
  ev({ type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 'srvtoolu_B', name: 'deepseek_web_search', input: { action: 'search', queries: ['B'] }, kind: 'deep_search' } });
  ev({ type: 'content_block_start', index: 2, content_block: { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'a', url: 'https://a' }], kind: 'deep_search' }, tool_use_id: 'srvtoolu_A' });
  ev({ type: 'content_block_start', index: 3, content_block: { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'b', url: 'https://b' }], kind: 'deep_search' }, tool_use_id: 'srvtoolu_B' });
  assert.equal(out.searches.length, 2);
  assert.deepEqual(out.searches[0].results.map((r) => r.url), ['https://a'], 'A 的搜索结果必须挂回 A（不能按"最后一个 search"错配）');
  assert.deepEqual(out.searches[1].results.map((r) => r.url), ['https://b'], 'B 的结果挂回 B');
  assert.equal(out.searches[0].id, 'srvtoolu_A', 'search 条目要带 tool_use_id，供 UI/日志配对');
  ok('⑱ 并发搜索：结果按 tool_use_id 配对（不是"最后一个"）');

  // 结果先于调用到达（缺 id 的残缺负载）时，退回最后一个 search，不能崩
  const out2 = { text: '', thinking: '', blocks: [], citations: [], searches: [], fetches: [], title: '', usage: null, stopReason: '' };
  applyAppEvent({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'x', name: 'deepseek_web_search', input: { action: 'search', queries: ['q'] }, kind: 'search' } }, out2, new Map());
  applyAppEvent({ type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://z' }], kind: 'search' } }, out2, new Map());
  assert.deepEqual(out2.searches[0].results.map((r) => r.url), ['https://z'], '缺 tool_use_id 时退回最后一个 search（容错，不丢结果）');
  ok('⑲ 残缺负载：缺 tool_use_id 时容错回退');
}

console.log(`\nDeepSeek 应用全家桶：${passed} 项通过`);
