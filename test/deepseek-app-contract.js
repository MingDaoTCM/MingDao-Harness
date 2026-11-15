// MingDao-Harness v0.8.2 DeepSeek 应用协议准入套件（审计方产出，T07 移植进默认门禁）。
//
// 运行：
//   node test/deepseek-app-contract.js          # 直接跑（node:test 自带运行器，失败退出码非零）
//   node --test test/deepseek-app-contract.js   # 同上
//   node test/run-all.mjs --suite=deepseek-app-contract
//
// **夹具来源**（v0.8.2 移植时如实登记）：
//   · 官方文档：https://api-docs.deepseek.com/guides/build_a_chatbot（Messages/SSE 形状、流内 error、refusal、title）
//               https://api-docs.deepseek.com/guides/web_tools（server_tool_use / web_search_tool_result / tool_use_id）
//               https://api-docs.deepseek.com/guides/document_parsing（files 上传顺序、purpose、anthropic-beta、20 个/32MiB 限制）
//               https://api-docs.deepseek.com/guides/asr 与 https://api-docs.deepseek.com/guides/tts（Bearer 鉴权、WAV/8MiB/120s、10000 字符）
//   · 获取日期：2026-11-15（对照仓库 docs/DEEPSEEK-APP-API.md 的字段表与官方 demo 形状）
//   · 是否线上录制：**未录制**，按官方文档形状手工构造（全部用假 fetch / 假流，不产生真实网络与费用）。
//
// **口径声明**：这些断言描述**目标行为**，不是当前实现的反向特征测试——基线出现失败是缺陷探针，
// 修实现让它变绿，不许改断言迁就实现（移植时逐条保留原断言，未按仓库风格改写口径）。
// 所有网络均为假 fetch；全局网络护栏会拦截任何未注入的真实请求。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// T07 移植点：套件就在仓库的 test/ 下，直接相对仓库根（不再依赖 MINGDAO_REPO 指向外部工作副本）。
const repo = path.join(here, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-v082-contract-'));
const savedEnv = {
  MINGDAO_HOME: process.env.MINGDAO_HOME,
  MINGDAO_APP_BASEURL: process.env.MINGDAO_APP_BASEURL,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
};
process.env.MINGDAO_HOME = home;
process.env.MINGDAO_APP_BASEURL = 'https://example.invalid';
process.env.DEEPSEEK_API_KEY = 'audit-invalid-key-not-for-network';

const importSource = (relative) => import(pathToFileURL(path.join(repo, relative)).href);
const D = await importSource('src/deepseek-app.js');
const W = await importSource('src/web/app-mode.js');
const C = await importSource('src/commands/app.js');
const P = await importSource('src/app-protocol.js');
const { runAppModeChat } = await importSource('src/web/app-mode-run.js');

const originalFetch = globalThis.fetch;
const networkGuard = async () => {
  throw new Error('测试网络护栏：本套件禁止未注入的真实 fetch');
};
globalThis.fetch = networkGuard;

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const encoder = new TextEncoder();
const messageStart = { type: 'message_start', message: { usage: { input_tokens: 1 } } };
const textStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const textDelta = (text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const endTurn = { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } };
const messageStop = { type: 'message_stop' };

function sseText(frames) {
  return frames.map((frame) => `event: ${frame.type || 'message'}\ndata: ${JSON.stringify(frame)}\n\n`).join('');
}

function streamResponse(text, { chunkSize = 0, failAfterFirstChunk = false } = {}) {
  const bytes = encoder.encode(text);
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (failAfterFirstChunk && offset > 0) {
        controller.error(new Error('fixture reader failure'));
        return;
      }
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = chunkSize > 0 ? Math.min(offset + chunkSize, bytes.length) : bytes.length;
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

function sseResponse(frames, options) {
  return streamResponse(sseText(frames), options);
}

async function chatWith(responseOrFactory, extra = {}) {
  const fetchImpl = typeof responseOrFactory === 'function'
    ? responseOrFactory
    : async () => responseOrFactory;
  return D.streamAppChat({
    baseUrl: 'https://example.invalid',
    apiKey: 'audit-key',
    messages: [{ role: 'user', content: 'contract test' }],
    fetchImpl,
    timeoutMs: 5000,
    ...extra,
  });
}

function assertFailure(result, message) {
  assert.equal(result.ok, false, message);
  assert.ok(String(result.error || '').trim(), `${message}：必须带可见错误`);
}

function emptyOut() {
  return { text: '', thinking: '', blocks: [], citations: [], searches: [], fetches: [], title: '', usage: null, stopReason: '' };
}

const PC_OK = { baseUrl: 'https://example.invalid/v1', apiKey: 'audit-key', envHint: 'DEEPSEEK_API_KEY' };
const CFG = { provider: 'deepseek', model: 'deepseek-flash' };

async function runApp(argv, overrides = {}) {
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  let output = '';
  try {
    const out = {
      write: (text) => { output += text; },
      print: (text = '') => { output += `${text}\n`; },
    };
    const handled = await C.handleApp('app', argv, {
      cfg: CFG,
      resolveProviderConfig: () => PC_OK,
      ...overrides,
      out,
    });
    return { handled, exitCode: Number(process.exitCode || 0), output };
  } finally {
    process.exitCode = previousExitCode;
  }
}

function virtualBytes(byteLength) {
  // 避免为 100 MiB 边界测试实际分配大 Buffer；预算校验必须先于任何 Blob/网络转换。
  return new Proxy(new Uint8Array(1), {
    get(target, property, receiver) {
      if (property === 'byteLength') return byteLength;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function pcm16Wav(seconds) {
  const sampleRate = 24000;
  const channels = 1;
  const bitsPerSample = 16;
  const dataSize = seconds * sampleRate * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

// ---------- 请求与流完整性：H-01 / H-03 ----------

test('DS-01 请求体必须显式携带 stream:true', () => {
  const body = D.buildAppRequest({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(body.stream, true);
});

test('DS-02 非 SSE 的 2xx JSON 不得被当成空正文成功', async () => {
  const response = new Response(JSON.stringify({
    type: 'message',
    content: [{ type: 'text', text: 'non-stream answer' }],
    stop_reason: 'end_turn',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const result = await chatWith(response);
  assertFailure(result, '未实现非流解析时必须明确失败');
});

test('DS-03 阳性对照：任意分块与多字节字符的完整 SSE 必须成功', async () => {
  const result = await chatWith(
    sseResponse([messageStart, textStart, textDelta('完整回答'), endTurn, messageStop], { chunkSize: 7 }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.text, '完整回答');
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(result.usage, { output_tokens: 1 });
});

test('DS-04 同一 SSE 事件的多个 data 行必须合并后解析', async () => {
  const body = [
    'data: ' + JSON.stringify(messageStart),
    '',
    'data: ' + JSON.stringify(textStart),
    '',
    'data: {"type":"content_block_delta","index":0,',
    'data: "delta":{"type":"text_delta","text":"multi-line"}}',
    '',
    'data: ' + JSON.stringify(endTurn),
    '',
    'data: ' + JSON.stringify(messageStop),
    '',
    '',
  ].join('\n');
  const result = await chatWith(streamResponse(body, { chunkSize: 11 }));
  assert.equal(result.ok, true);
  assert.equal(result.text, 'multi-line');
});

test('DS-05 缺少 message_stop 的 EOF 必须判为截断失败', async () => {
  const result = await chatWith(sseResponse([messageStart, textStart, textDelta('半截正文')]));
  assertFailure(result, '提前 EOF 不是完整答案');
  assert.equal(result.outcome, 'truncated');
});

test('DS-06 无顶层 type 的官方错误帧必须失败', async () => {
  const body = 'event: error\ndata: {"error":{"message":"generation start timeout"}}\n\n';
  const result = await chatWith(streamResponse(body));
  assertFailure(result, 'event:error 不能依赖 payload.type 才识别');
  assert.match(String(result.error), /generation start timeout/);
});

test('DS-07 坏 JSON 帧即使随后收到 message_stop 也必须失败', async () => {
  const body = 'data: {not-json}\n\n' + sseText([messageStop]);
  const result = await chatWith(streamResponse(body));
  assertFailure(result, '坏帧不得静默忽略');
});

test('DS-08 reader 异常必须失败并透出原因', async () => {
  const response = streamResponse(sseText([messageStart, textStart, textDelta('半截')]), {
    chunkSize: 20,
    failAfterFirstChunk: true,
  });
  const result = await chatWith(response);
  assertFailure(result, 'reader 异常不得成功');
  assert.match(String(result.error), /fixture reader failure/);
});

test('DS-09 阳性对照：带 type:error 的流内错误必须失败', async () => {
  const result = await chatWith(sseResponse([
    messageStart,
    textStart,
    textDelta('半截'),
    { type: 'error', error: { type: 'api_error', message: 'generation failed' }, usage: { output_tokens: 1 } },
  ]));
  assertFailure(result, '显式流内错误必须保持失败');
  assert.match(String(result.error), /generation failed/);
  assert.deepEqual(result.usage, { output_tokens: 1 });
});

// ---------- 内容安全拒答：H-02 ----------

test('DS-10 refusal 是 refused 终态，不得返回正常成功或原正文成功态', async () => {
  const deltas = [];
  const result = await chatWith(
    sseResponse([
      messageStart,
      textStart,
      textDelta('将被撤回的文本'),
      { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 2 } },
      messageStop,
    ]),
    { onDelta: (event) => deltas.push(event) },
  );
  assertFailure(result, '安全拒答不能 ok:true');
  assert.equal(result.stopReason, 'refusal');
  assert.equal(result.outcome, 'refused');
  assert.ok(deltas.some((event) => event.type === 'refusal'), '必须通知 UI 撤回已经流出的文本');
});

test('DS-11 Web 映射必须产生 appRefusal 撤回帧', () => {
  assert.deepEqual(W.appFrameOf({ type: 'refusal' }), { type: 'appRefusal' });
});

test('DS-12 Web 拒答不得持久化 user/assistant 正文或发送成功 done', async () => {
  const sent = [];
  const persisted = [];
  const finished = [];
  const entry = { status: 'running', startedAt: Date.now() };
  globalThis.fetch = async () => sseResponse([
    messageStart,
    textStart,
    textDelta('不得落盘的拒答正文'),
    { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 2 } },
    messageStop,
  ]);
  try {
    await runAppModeChat({
      cfg: { provider: 'deepseek', model: 'deepseek-flash', appApi: { enabled: true, model: 'deepseek-flash', title: false } },
      body: { appMode: true },
      session: { messages: [], file: path.join(home, 'refusal.jsonl') },
      built: { persistText: '会触发拒答的问题' },
      userMessage: '会触发拒答的问题',
      home,
      taskId: 'audit-refusal',
      send: (frame) => sent.push(frame),
      srvlog: () => {},
      entry,
      res: { on: () => {} },
      fs,
      path,
      withSessionLock: async (_file, fn) => fn(),
      appendMessages: (_file, messages) => { persisted.push(...messages); },
      renameSessionFile: () => { throw new Error('拒答路径不得改名'); },
      moveSessionWorkspace: () => {},
      claimSessionKey: () => {},
      chatFailure: (message) => new Error(String(message || 'refusal')),
      finishChat: (cause) => finished.push(cause || null),
    });
  } finally {
    globalThis.fetch = networkGuard;
  }
  assert.equal(persisted.length, 0, '拒答不得调用正常消息落盘');
  assert.equal(sent.some((frame) => frame.type === 'done' && frame.ok === true), false);
  assert.ok(sent.some((frame) => frame.type === 'appRefusal'), 'Web 必须发出撤回帧');
  assert.equal(finished.length, 1);
});

// ---------- 官方工具配对与多轮历史：M-01 / M-02 ----------

test('DS-13 并发搜索结果只按 content_block.tool_use_id 配对', () => {
  const out = emptyOut();
  const open = new Map();
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'A', name: 'deepseek_web_search', input: { action: 'search', queries: ['A'] }, kind: 'deep_search' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 'B', name: 'deepseek_web_search', input: { action: 'search', queries: ['B'] }, kind: 'deep_search' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'web_search_tool_result', tool_use_id: 'A', content: [{ type: 'web_search_result', url: 'https://a.invalid' }], kind: 'deep_search' } },
    { type: 'content_block_start', index: 3, content_block: { type: 'web_search_tool_result', tool_use_id: 'B', content: [{ type: 'web_search_result', url: 'https://b.invalid' }], kind: 'deep_search' } },
  ];
  for (const event of events) D.applyAppEvent(event, out, open);
  assert.deepEqual(
    out.searches.map((item) => item.results.map((result) => result.url)),
    [['https://a.invalid'], ['https://b.invalid']],
    '并发结果必须按 tool_use_id 各归各的（不能错配/丢失）',
  );
});

test('DS-14 未知 tool_use_id 不得猜挂到最后一次搜索', () => {
  const out = emptyOut();
  const open = new Map();
  D.applyAppEvent({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'known', name: 'deepseek_web_search', input: { action: 'search', queries: ['q'] } } }, out, open);
  D.applyAppEvent({ type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'unknown', content: [{ type: 'web_search_result', url: 'https://orphan.invalid' }] } }, out, open);
  assert.deepEqual(out.searches[0].results, [], '未知结果不能污染已知搜索');
  assert.ok(out.blocks.some((block) => block.id === 'unknown'), '未配对结果应保留用于诊断');
});

test('DS-15 多轮历史必须原样回传带 kind/signature 的 assistant 内容块', () => {
  const assistant = {
    role: 'assistant',
    content: [
      { type: 'server_tool_use', id: 'R', name: 'deepseek_read_url', input: { action: 'read_link', url: 'https://example.invalid' }, kind: 'read_link' },
      { type: 'web_fetch_tool_result', tool_use_id: 'R', content: { type: 'web_fetch_result', url: 'https://example.invalid', content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '' }, title: 'Example' } }, kind: 'read_link', signature: 'signed-page-content' },
      { type: 'text', text: 'first answer' },
    ],
  };
  const result = W.buildAppMessages([{ role: 'user', content: 'read link' }, assistant], 'quote it');
  assert.deepEqual(result[1], assistant, '协议原始块必须逐字段保留，不能只留字符串或重组子集');
  assert.deepEqual(result.at(-1), { role: 'user', content: 'quote it' });
});

// ---------- 附件与语音预算：M-03 / M-04 ----------

test('DS-16 Files API 上传后的图片必须按 document 引用', () => {
  assert.equal(
    C.blockTypeForFile('image.png'),
    'document',
    '图片必须按 document 引用（v0.8.1 的 image 块会被上游 400）',
  );
  const messages = C.buildAppMessages('read it', [{ type: C.blockTypeForFile('image.png'), fileId: 'file-1' }]);
  assert.deepEqual(messages[0].content.at(-1), { type: 'document', source: { type: 'file', file_id: 'file-1' } });
});

test('DS-17 不支持的 ASR 扩展名必须本地失败且零网络调用', async () => {
  let calls = 0;
  let reads = 0;
  const result = await runApp(['--asr', 'voice.mp3'], {
    readFile: () => { reads += 1; return new Uint8Array([1, 2, 3]); },
    transcribeAudio: async () => { calls += 1; return { ok: true, text: 'should not run' }; },
  });
  assert.notEqual(result.exitCode, 0, '不支持的格式必须本地失败（非零退出）');
  assert.equal(calls, 0);
  assert.equal(reads, 0, '不支持的格式不得读取文件（零读取、零网络）');
  assert.match(result.output, /WAV|Ogg|不支持/);
});

test('DS-18 ASR 超过 8 MiB 必须本地失败且零网络调用', async () => {
  let calls = 0;
  const result = await runApp(['--asr', 'large.wav'], {
    readFile: () => virtualBytes(8 * 1024 * 1024 + 1),
    transcribeAudio: async () => { calls += 1; return { ok: true, text: 'should not run' }; },
  });
  assert.notEqual(result.exitCode, 0, '8 MiB 超限必须非零退出');
  assert.equal(calls, 0);
  assert.match(result.output, /8\s*MiB|8\s*MB|大小|超过/);
});

test('DS-19 16-bit PCM WAV 超过 120 秒必须本地失败且零网络调用', async () => {
  let calls = 0;
  const result = await runApp(['--asr', 'long.wav'], {
    readFile: () => pcm16Wav(121),
    transcribeAudio: async () => { calls += 1; return { ok: true, text: 'should not run' }; },
  });
  assert.notEqual(result.exitCode, 0, '121 秒必须本地失败（时长上限 120 秒）');
  assert.equal(calls, 0);
  assert.match(result.output, /120|时长|超过/);
});

test('DS-20 TTS 超过 10000 字符必须本地失败且零网络调用', async () => {
  let calls = 0;
  const result = await runApp(['--tts', 'a'.repeat(10001)], {
    synthesizeSpeech: async () => { calls += 1; return { ok: true, pcm: new Uint8Array([1]) }; },
    writeFile: () => {},
  });
  assert.notEqual(result.exitCode, 0, '超过 10000 字符必须本地失败');
  assert.equal(calls, 0);
  assert.match(result.output, /10000|字符|超过/);
});

test('DS-21 超过 20 个文件必须在上传前失败', async () => {
  let uploads = 0;
  const files = Array.from({ length: 21 }, (_, index) => `f${index}.txt`);
  const result = await runApp(['question', ...files.flatMap((file) => ['--file', file])], {
    readFile: () => new Uint8Array([1]),
    uploadAppFile: async () => { uploads += 1; return { ok: true, fileId: `id-${uploads}` }; },
    streamAppChat: async () => { throw new Error('超限时不应进入对话请求'); },
  });
  assert.notEqual(result.exitCode, 0, '21 个文件必须本地失败');
  assert.equal(uploads, 0, '数量超限不得上传任何文件');
  assert.match(result.output, /20|数量|超过/);
});

test('DS-22 单文件超过 100 MiB 必须在读取转换和上传前失败', async () => {
  let uploads = 0;
  const result = await runApp(['question', '--file', 'huge.pdf'], {
    readFile: () => virtualBytes(100 * 1024 * 1024 + 1),
    uploadAppFile: async () => { uploads += 1; return { ok: true, fileId: 'should-not-upload' }; },
    streamAppChat: async () => { throw new Error('超限时不应进入对话请求'); },
  });
  assert.notEqual(result.exitCode, 0, '单文件超 100 MiB 必须在读取/上传前失败');
  assert.equal(uploads, 0, '单文件超 100 MiB 不得上传');
  assert.match(result.output, /100\s*MiB|100\s*MB|大小|超过/);
});

test('DS-25 恰好 20 个文件必须放行（数量上限是含 20 的 >，不是 >=）', async () => {
  let uploads = 0;
  const files = Array.from({ length: 20 }, (_, index) => `f${index}.txt`);
  const result = await runApp(['question', ...files.flatMap((file) => ['--file', file])], {
    readFile: () => new Uint8Array([1]),
    uploadAppFile: async () => { uploads += 1; return { ok: true, fileId: `id-${uploads}` }; },
    streamAppChat: async () => ({
      ok: true, text: 'ok', thinking: '', title: '', searches: [], citations: [], fetches: [], usage: null, stopReason: 'end_turn',
    }),
  });
  assert.equal(result.exitCode, 0, '恰好 20 个文件必须放行（上限 20 含 20，不能差一）');
  assert.equal(uploads, 20, '20 个文件都必须上传');
});

test('DS-26 请求内文档合计超过 32 MiB 必须本地失败（单文件均未超 100 MiB）', async () => {
  let uploads = 0;
  const files = Array.from({ length: 17 }, (_, index) => `p${index}.txt`);
  const result = await runApp(['question', ...files.flatMap((file) => ['--file', file])], {
    readFile: () => virtualBytes(2 * 1024 * 1024),
    uploadAppFile: async () => { uploads += 1; return { ok: true, fileId: 'should-not-upload' }; },
    streamAppChat: async () => { throw new Error('合计超限时不应进入对话请求'); },
  });
  assert.notEqual(result.exitCode, 0, '合计超 32 MiB 必须非零退出');
  assert.equal(uploads, 0, '合计超 32 MiB 不得上传任何文件');
  assert.match(result.output, /32\s*MiB|合计|超过/, '错误必须说明合计上限 32 MiB');
});

test('DS-27 TTS 请求体超过 64 KiB 必须本地拒绝（与字符上限分开）', () => {
  // 64 KiB 是**请求体**上限，不是字符上限：字符数合法（1 个）但请求体因 voice 过大而超限。
  const budget = P.checkTtsBudget('读', { voice: 'v'.repeat(70 * 1024) });
  assert.equal(budget.ok, false, '请求体超 64 KiB 必须本地拒绝');
  assert.match(String(budget.error), /64 KiB|请求体/, '错误必须说明 64 KiB 请求体上限');
});

test('DS-28 单文件 100 MiB 规则必须独立成立（不能被 32 MiB 合计掩盖）', () => {
  // 100 MiB > 32 MiB，所以一个超 100 MiB 的文件也必然超合计；但**单文件规则先判**，
  // 文案必须点名「单文件上限」——否则单独把 100 MiB 改大时行为看起来没变化（合计兜底）。
  const single = P.checkDocumentsBudget([{ name: 'huge.pdf', bytes: 100 * 1024 * 1024 + 1 }]);
  assert.equal(single.ok, false, '单文件超 100 MiB 必须拒绝');
  assert.match(String(single.error), /单文件上限/, '单文件超限必须点名单文件上限（先于合计判定）');
  assert.match(String(single.error), /100\s*MiB/, '文案必须给出 100 MiB 上限');
  // 边界：恰好 100 MiB 不触发单文件规则（严格 >），由合计规则兜底——两条规则互不替代。
  const boundary = P.checkDocumentsBudget([{ name: 'edge.pdf', bytes: 100 * 1024 * 1024 }]);
  assert.equal(boundary.ok, false, '恰好 100 MiB 仍超合计 32 MiB');
  assert.match(String(boundary.error), /合计/, '恰好 100 MiB 由合计规则兜底（单文件是严格 >）');
});

// ---------- 模型能力与入口一致性：M-05 ----------

test('DS-23 模型门不得被任意 deepseek-flash 子串绕过', () => {
  assert.equal(D.supportsAppTools('deepseek-flash'), true);
  assert.equal(D.supportsAppTools('custom-deepseek-flash-experimental'), false, '伪冒后缀不得通过能力门');
  assert.equal(D.supportsAppTools('notdeepseek-flash'), false, '伪冒前缀不得通过能力门');
  assert.equal(D.supportsAppTools('deepseek-v4-pro'), false);
});

test('DS-24 CLI 与 Web 对不支持模型统一回落到 deepseek-flash', () => {
  for (const model of ['deepseek-v4-pro', 'custom-deepseek-flash-experimental']) {
    const cfg = { provider: 'deepseek', model, appApi: { model } };
    const cliModel = C.resolveAppModel(cfg);
    const webModel = W.appModelOf(cfg);
    assert.equal(cliModel, D.APP_DEFAULT_MODEL, `CLI 必须归一化 ${model}`);
    assert.equal(webModel, D.APP_DEFAULT_MODEL, `Web 必须归一化 ${model}`);
    assert.equal(cliModel, webModel);
    assert.equal(D.supportsAppTools(cliModel), true);
  }
});
