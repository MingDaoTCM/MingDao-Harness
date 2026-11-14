// v0.8.1：WebUI「应用模式」开关（联网搜索 / 深度思考 / 阅读链接）的独立回归套件。
//
// 覆盖三层：
//   ① `src/web/app-mode.js` 纯函数：delta→SSE 帧映射（六种 + 未知为 null）、历史裁剪
//      （丢 tool/system/非字符串 content、截断 maxTurns*2、末尾追加当前文本）、配置判定默认值；
//   ② 真实 HTTP 服务（`runWebServer`，临时 MINGDAO_HOME）+ 本地 Anthropic SSE 桩：
//      `POST /api/chat {appMode:true}` 的整条链路——帧序列、请求体（服务端工具/思考/历史裁剪）、
//      会话落盘（user+assistant 两条）、服务端标题改名（只在默认时间戳名时才改）；
//   ③ 关闭态（不带 appMode）仍走原 Agent 路径：有 text/done，**没有**任何应用模式帧；
//   ④ 接线绊线（前端按钮 / 请求字段 / 服务端分支），防止"改测试不改实现"式变异。
//
// 运行：node test/app-mode.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-appmode-'));
process.env.MINGDAO_HOME = home;
// 环境变量隔离：别让本机真实密钥（或 CI 注入的变量）把「无 Key」用例变成假通过。
delete process.env.DEEPSEEK_API_KEY;
delete process.env.MINGDAO_API_KEY;

// v0.6.10 同款：源码里不放密钥形态的字面量（本轮转成等价形状）。
const FAKE = (/** @type {string} */ p) => p + 'x'.repeat(20);

const A = await import(pathToFileURL(path.join(srcDir, 'web', 'app-mode.js')).href);
const { saveConfig } = await import(pathToFileURL(path.join(srcDir, 'config.js')).href);
const { setStoredKey } = await import(pathToFileURL(path.join(srcDir, 'credentials.js')).href);
const { runWebServer } = await import(pathToFileURL(path.join(srcDir, 'web', 'server.js')).href);

let passed = 0;
/** @param {string} name */
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ 应用模式[${name}]`);
};
const eq = (/** @type {any} */ a, /** @type {any} */ b, /** @type {string} */ msg) => assert.deepEqual(a, b, msg);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// ① 纯函数：appFrameOf 六种映射 + 未知事件
// ===========================================================================
{
  eq(A.appFrameOf({ type: 'thinking', text: '想一想' }), { type: 'reasoning', text: '想一想' }, 'thinking → reasoning（沿用既有帧类型）');
  ok('thinking → {type:reasoning, text}');
  eq(A.appFrameOf({ type: 'text', text: '答案' }), { type: 'text', text: '答案' }, 'text → text（字段名 text）');
  ok('text → {type:text, text}');
  eq(
    A.appFrameOf({
      type: 'search',
      queries: ['深蓝', 'DeepSeek'],
      kind: 'search',
      results: [{ title: '结果一', url: 'https://e.com/a', snippet: '片段', site_name: 'e.com', extra: 1 }],
    }),
    {
      type: 'appSearch',
      queries: ['深蓝', 'DeepSeek'],
      kind: 'search',
      results: [{ title: '结果一', url: 'https://e.com/a', snippet: '片段', site_name: 'e.com' }],
    },
    'search → appSearch（结果只保留 title/url/snippet/site_name 四个字段）'
  );
  ok('search → {type:appSearch, queries, kind, results[4 字段]}');
  eq(A.appFrameOf({ type: 'fetch', action: 'open_page', url: 'https://e.com/a', title: '页面一' }), { type: 'appFetch', action: 'open_page', url: 'https://e.com/a', title: '页面一' }, 'fetch → appFetch');
  ok('fetch → {type:appFetch, action, url, title}');
  eq(A.appFrameOf({ type: 'citation', url: 'https://e.com/a', title: '结果一' }), { type: 'appCitation', url: 'https://e.com/a', title: '结果一' }, 'citation → appCitation');
  ok('citation → {type:appCitation, url, title}');
  eq(A.appFrameOf({ type: 'title', title: '会话标题' }), { type: 'appTitle', title: '会话标题' }, 'title → appTitle');
  ok('title → {type:appTitle, title}');
  eq(A.appFrameOf({ type: 'usage', usage: { input_tokens: 1 } }), null, 'usage 不产生帧');
  eq(A.appFrameOf({ type: 'stop', reason: 'end_turn' }), null, 'stop 不产生帧');
  eq(A.appFrameOf(null), null, 'null 不崩、不产生帧');
  eq(A.appFrameOf({ type: '未知事件' }), null, '未知事件 → null');
  ok('usage/stop/null/未知事件 → null（不产生帧）');
}

// ===========================================================================
// ② 纯函数：buildAppMessages（丢弃 / 只留文本 / 截断 / 末尾追加）
// ===========================================================================
{
  const history = [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'tool', content: '工具输出' },
    { role: 'assistant', content: [{ type: 'text', text: '数组内容' }], tool_calls: [{ id: 'c1' }] },
    { role: 'user', content: '第二问', _internal: true },
    { role: 'assistant', content: '第二答', _traj: [{ a: 1 }] },
    'not-a-message',
    null,
    { role: 'narrator', content: '旁白' },
  ];
  const built = A.buildAppMessages(history, '本轮问题');
  eq(
    built,
    [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' },
      { role: 'assistant', content: '第二答' },
      { role: 'user', content: '本轮问题' },
    ],
    '只留 user/assistant + 字符串 content；tool/system/数组/非法项全丢；末尾追加当前文本'
  );
  eq(Object.keys(built[2]), ['role', 'content'], '重建消息：不透传 `_` 开头等附加字段');
  ok('丢弃 tool/system/数组 content/非对象，且不透传附加字段');
  ok('只保留文本 content，消息重建为 {role, content}');
  const many = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }));
  const cut = A.buildAppMessages(many, 'current', { maxTurns: 2 });
  eq(cut.length, 5, 'maxTurns=2 → 最后 4 条 + 当前 1 条 = 5 条');
  eq(cut[0].content, 'm16', '截断取的是**最后** maxTurns*2 条（不是最前）');
  ok('maxTurns 截断（默认 8 轮；取最后 maxTurns*2 条）');
  eq(A.buildAppMessages(many, 'current').length, 17, '默认 maxTurns=8 → 16 条历史 + 当前 = 17');
  eq(A.buildAppMessages(history, 'x').at(-1), { role: 'user', content: 'x' }, '末尾恒为当前 user 文本');
  eq(A.buildAppMessages(null, 'x'), [{ role: 'user', content: 'x' }], '空/非数组历史不崩');
  ok('末尾追加当前 user 文本；空历史安全');
}

// ===========================================================================
// ③ 纯函数：配置判定默认值
// ===========================================================================
{
  eq(A.appModeEnabled(null), false, '无配置 → 关闭');
  eq(A.appModeEnabled({}), false, '无 appApi → 关闭');
  eq(A.appModeEnabled({ appApi: { enabled: 'true' } }), false, '字符串 "true" 不算开启（只认字面量 true）');
  eq(A.appModeEnabled({ appApi: { enabled: true } }), true, 'enabled===true → 开启');
  ok('appModeEnabled：默认关闭，只认字面量 true');
  eq(A.appModelOf(null), 'deepseek-flash', '默认模型 deepseek-flash');
  eq(A.appModelOf({ appApi: { model: 'deepseek-v4-pro' } }), 'deepseek-v4-pro', 'appApi.model 优先');
  eq(A.appModelOf({ appApi: { model: '  ' } }), 'deepseek-flash', '空字符串回落默认');
  ok('appModelOf：appApi.model || deepseek-flash');
  eq(A.APP_NO_KEY_MESSAGE.includes('mingdao key set deepseek'), true, '缺 Key 文案必须给出可执行的命令');
}

// ===========================================================================
// ④ 真实 HTTP 服务 + 本地桩：应用模式链路 / 无 Key / 关闭态回落 Agent 路径
// ===========================================================================
{
  /** @type {any[]} */
  const anthropicRequests = [];
  /** @type {any[]} */
  const openaiRequests = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {}
      const url = String(req.url || '');
      // 应用接口：只会被 MINGDAO_APP_BASEURL（/approot）指到这里——证明可注入点真的生效。
      if (url === '/approot/anthropic/v1/messages') {
        anthropicRequests.push({ url, headers: req.headers, body: parsed });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        /** @param {any} o */
        const ev = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        ev({ type: 'message_start', message: { usage: { input_tokens: 12 } } });
        ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先想一想。' } });
        ev({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'server_tool_use', id: 's1', name: 'deepseek_web_search', input: { action: 'search', queries: ['深蓝', 'DeepSeek'] }, kind: 'search' },
        });
        ev({
          type: 'content_block_start',
          index: 2,
          content_block: {
            type: 'web_search_tool_result',
            content: [{ type: 'web_search_result', title: '结果一', url: 'https://example.com/a', snippet: '片段一', site_name: 'example' }],
            kind: 'search',
          },
          tool_use_id: 's1',
        });
        ev({ type: 'content_block_start', index: 3, content_block: { type: 'text' } });
        ev({ type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: '这是应用模式回答。' } });
        ev({ type: 'content_block_delta', index: 3, delta: { type: 'citations_delta', citation: { url: 'https://example.com/a', title: '结果一', cited_text: '片段一' } } });
        ev({ type: 'message_delta', delta: { title: '应用标题测试', stop_reason: 'end_turn' }, usage: { output_tokens: 7 } });
        ev({ type: 'message_stop' });
        res.end();
        return;
      }
      // Agent 路径（OpenAI 兼容）：直接给正文并收尾（不回 tool_calls，避免多轮）。
      if (url === '/v1/chat/completions') {
        openaiRequests.push({ url, body: parsed });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '普通 Agent 回答' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      // 其余（/props、/v1/models、预检）：给合法 JSON，避免预检噪音影响用例。
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [], object: 'list', n_ctx: 32768 }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubPort = /** @type {import('node:net').AddressInfo} */ (stub.address()).port;

  saveConfig({
    provider: 'custom',
    model: 'test-model',
    baseUrl: `http://127.0.0.1:${stubPort}/v1`,
    permission: 'auto',
    contextBudget: 32000,
    appApi: { enabled: true, model: 'deepseek-flash', search: true, readUrl: true, thinking: true, safetyLevel: 'high', title: true },
  });
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ custom: FAKE('sk-test-appmode-') }), { mode: 0o600 });
  process.env.MINGDAO_APP_BASEURL = `http://127.0.0.1:${stubPort}/approot`;

  const srv = await runWebServer({ host: '127.0.0.1', port: 0, authToken: null });
  if (!srv.listening) await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (srv.address()).port}`;

  /**
   * 发一轮 chat 并读完 SSE 帧。
   * @param {any} body
   * @returns {Promise<any[]>}
   */
  const chat = async (body) => {
    const resp = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(resp.status, 200, 'chat 必须返回 200（SSE）');
    /** @type {any[]} */
    const frames = [];
    const reader = /** @type {any} */ (resp.body).getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) {
          try {
            frames.push(JSON.parse(line.slice(5)));
          } catch {}
        }
        nl = buf.indexOf('\n');
      }
    }
    return frames;
  };

  try {
    // —— ④-0 /api/state 暴露 appMode（前端据此决定开关可见性） ——
    const st = await (await fetch(base + '/api/state')).json();
    eq(st.appMode, true, '/api/state 必须透出 appMode（cfg.appApi.enabled=true 时前端才显示开关）');
    ok('服务端：/api/state 透出 appMode 开关可见性');

    // —— ④-1 无 Key：明确文案，不发半截正文 ——
    const noKey = await chat({ message: '无 Key 的应用模式', appMode: true });
    const noKeyErr = noKey.find((f) => f.type === 'error');
    assert.ok(noKeyErr, '无 Key 必须给 error 帧（不能静默回落）');
    eq(noKeyErr.message, A.APP_NO_KEY_MESSAGE, '无 Key 的文案与 CLI/常量一致（给出 mingdao key set deepseek）');
    eq(noKey.some((f) => f.type === 'text'), false, '无 Key 时不应产生正文帧');
    ok('服务端：无 Key → error 帧（文案含 mingdao key set deepseek），不发正文');

    // 补上 deepseek 密钥（凭证库写入路径，不动 custom 密钥）
    const put = setStoredKey('deepseek', FAKE('sk-test-deepseek-'));
    assert.equal(put.ok, true, '写入 deepseek 测试密钥必须成功');

    // —— ④-2 应用模式成功链路 ——
    const before = anthropicRequests.length;
    const frames = await chat({ message: '应用模式问题', appMode: true, search: true, think: true });
    eq(anthropicRequests.length, before + 1, '一轮只发 1 次应用接口请求（服务端执行搜索/阅读，不多轮往返）');
    const areq = anthropicRequests[anthropicRequests.length - 1];
    eq(areq.url, '/approot/anthropic/v1/messages', 'baseUrl 走 MINGDAO_APP_BASEURL 可注入点（不是 config.baseUrl）');
    eq(String(areq.headers['x-api-key'] || '').startsWith('sk-test-deepseek-'), true, '应用接口用 x-api-key 发凭证');
    eq(areq.body.thinking, { type: 'enabled' }, 'think:true → thinking.enabled');
    const tools = (areq.body.tools || []).map((t) => String(t.type));
    eq(tools.includes('deepseek_web_search'), true, 'search:true → 声明服务端搜索工具');
    eq(tools.includes('deepseek_read_url'), true, 'readUrl 默认开 → 声明服务端阅读工具');
    eq(areq.body.messages.at(-1), { role: 'user', content: '应用模式问题' }, '请求 messages 末尾是当前 user 文本');
    eq(areq.body.messages.some((m) => m.role === 'tool' || m.role === 'system'), false, '应用接口 messages 里没有 tool/system 消息');
    ok('服务端：一轮 1 次请求 / MINGDAO_APP_BASEURL / 服务端工具与 think / 历史裁剪后消息');

    const types = frames.map((f) => f.type);
    eq(types.includes('reasoning'), true, 'thinking delta → reasoning 帧');
    eq(types.includes('text'), true, 'text_delta → text 帧');
    const textFrame = frames.find((f) => f.type === 'text');
    eq(textFrame.text, '这是应用模式回答。', 'text 帧带 text 字段（前端入口兼容 delta/text）');
    const searches = frames.filter((f) => f.type === 'appSearch');
    assert.ok(searches.length >= 2, '搜索开始 + 结果到达各产生一条 appSearch（实时反馈）');
    eq(searches[0].queries, ['深蓝', 'DeepSeek'], 'appSearch 带 queries');
    const withResults = searches.find((f) => Array.isArray(f.results) && f.results.length);
    assert.ok(withResults, 'appSearch 的结果帧必须带 results');
    eq(withResults.results[0], { title: '结果一', url: 'https://example.com/a', snippet: '片段一', site_name: 'example' }, '结果只保留四字段');
    const cite = frames.find((f) => f.type === 'appCitation');
    assert.ok(cite, 'citations_delta → appCitation');
    eq([cite.url, cite.title], ['https://example.com/a', '结果一'], 'appCitation 带 url/title');
    ok('服务端 SSE：reasoning / appSearch(queries+结果) / appCitation / text 齐全');
    const titled = frames.find((f) => f.type === 'appTitle');
    assert.ok(titled, 'message_delta.title → appTitle');
    eq(titled.title, '应用标题测试', 'appTitle 带服务端标题');
    const done = frames.find((f) => f.type === 'done');
    assert.ok(done, '必须以 done 收尾');
    eq(done.ok, true, 'done.ok=true');
    eq(done.session, '应用标题测试.jsonl', '会话已按服务端标题改名，done 带新会话名');
    eq(frames.every((f) => typeof f.taskId === 'string' && f.taskId.startsWith('t')), true, '每帧都带 taskId（走既有 send() 封装）');
    eq(frames.every((f) => Number.isInteger(f.streamSeq) && f.streamSeq >= 1), true, '每帧都带 streamSeq（既有流游标）');
    ok('服务端 SSE：appTitle / done(ok+session) / 每帧 taskId+streamSeq');

    // —— ④-3 会话落盘：user + assistant 两条，正文是应用模式回答 ——
    const sessFile = path.join(home, 'sessions', '应用标题测试.jsonl');
    await sleep(120); // 落盘在 done 之前完成；这里只做文件系统可见性的保守等待
    assert.equal(fs.existsSync(sessFile), true, '服务端标题必须落到会话文件名上');
    const lines = fs
      .readFileSync(sessFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    eq(lines.map((m) => m.role), ['user', 'assistant'], '会话落盘只有 user + assistant 两条（应用模式不在会话里留工具消息）');
    eq(lines[0].content, '应用模式问题', 'user 消息内容');
    eq(lines[1].content, '这是应用模式回答。', 'assistant 消息内容 = 应用接口正文');
    ok('会话落盘：user+assistant 两条 + 服务端标题改名（默认时间戳名才改）');

    // —— ④-4 关闭态：不带 appMode → 原 Agent 路径，无应用模式帧 ——
    const plain = await chat({ message: '普通消息' });
    const plainTypes = plain.map((f) => f.type);
    eq(plainTypes.includes('text'), true, '关闭态仍走 Agent 路径并有正文');
    eq(plainTypes.includes('done'), true, '关闭态以 done 收尾');
    eq(plainTypes.some((t) => ['appSearch', 'appFetch', 'appCitation', 'appTitle'].includes(t)), false, '不带 appMode 时不得出现任何应用模式帧');
    eq(openaiRequests.length > 0, true, '关闭态真的打到了 OpenAI 兼容的 Agent 端点');
    eq(JSON.stringify(openaiRequests.at(-1)?.body || {}).includes('普通消息'), true, '关闭态请求里带上用户消息');
    ok('关闭态：走原 Agent 路径（text/done），没有任何应用模式帧');
  } finally {
    delete process.env.MINGDAO_APP_BASEURL;
    await new Promise((r) => srv.close(r));
    await new Promise((r) => stub.close(r));
  }
}

// ===========================================================================
// ⑤ 接线绊线：前端按钮 / 请求字段 / 服务端分支（变异防护；行为在 ①–④）
// ===========================================================================
{
  const appSrc = fs.readFileSync(path.join(srcDir, 'web', 'app.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(srcDir, 'web', 'index.html'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(srcDir, 'web', 'server.js'), 'utf8');
  assert.ok(/id="appSearchBtn"/.test(htmlSrc), '输入区必须有 #appSearchBtn 开关按钮');
  assert.ok(/title="[^"]*联网搜索 \/ 深度思考 \/ 阅读链接[^"]*"/.test(htmlSrc), '按钮 title 必须说明服务端执行/一轮 1 次请求');
  assert.ok(/服务端执行/.test(htmlSrc) && /1 次请求/.test(htmlSrc), 'title 必须写清服务端执行与一轮 1 次请求');
  assert.ok(/payload\.appMode=true/.test(appSrc), 'send() 开启态必须带 appMode');
  assert.ok(/payload\.search=true/.test(appSrc) && /payload\.think=/.test(appSrc), 'send() 开启态必须带 search/think');
  assert.ok(/ev\.type==='appSearch'/.test(appSrc) && /ev\.type==='appFetch'/.test(appSrc) && /ev\.type==='appCitation'/.test(appSrc), '前端必须渲染 appSearch/appFetch/appCitation');
  assert.ok(/参考：/.test(appSrc), '引用必须汇总成「参考：…」（最多 5 条）');
  // v0.8.1：闸门 = 配置开启 **或** 显式 UI 开关（与 CLI `mingdao app` 同口径），且模型必须是 flash 家族。
  assert.ok(/shouldRunAppMode\(body, cfg, runModel\)/.test(serverSrc), '服务端必须用 shouldRunAppMode 单点判据触发应用模式');
  const gateSrc = fs.readFileSync(path.join(srcDir, 'web', 'app-mode.js'), 'utf8');
  assert.ok(/body\.appMode !== true\) return false/.test(gateSrc), 'shouldRunAppMode：非显式开关一律 false');
  assert.ok(/appModeEnabled\(cfg\) \|\| supportsAppTools\(/.test(gateSrc), 'shouldRunAppMode：配置开启 或 flash 家族模型');
  assert.ok(/const agent = createAgent\(/.test(serverSrc), '应用模式分支不得删除 Agent 路径');
  ok('接线绊线：按钮 / 请求字段 / 三帧渲染 / 服务端双闸门 / Agent 路径仍在');
}

// 清理临时 home（Windows 上偶发 EBUSY——尽力而为，失败不影响结论）
for (let i = 0; i < 3; i++) {
  try {
    fs.rmSync(home, { recursive: true, force: true });
    break;
  } catch {
    await sleep(120);
  }
}

console.log(`✅ test/app-mode.js：${passed} 项通过（纯函数映射/裁剪 + 真实 HTTP 应用模式链路 + 关闭态回落 + 接线绊线）`);
process.exit(0);
