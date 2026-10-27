// Provider 加固回归：H-04（切换 baseUrl 后旧实例/Cache 仍出网）、M-8（SSE 多行 data / 坏帧可见）、
// M-9（SSE 异常路径取消 reader）、M-13（脱敏前缀与子进程 env 过滤）、L-9（HTTP 掩码只回末 4 位）。
//
// 为什么单独成一套（而不是塞进 smoke.js）：H-04 需要**两个真实可区分的桩端点 + 真 Web 服务器**，
// 而 smoke.js 是本轮禁止改动的文件（其它并行轨道在改它）。本套件可单独跑，也作为
// test/mutate/batch59-provider-hardening.mjs 的判定入口。
//
// 运行：node test/provider-hardening.js

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
// 公开仓库不放密钥字面量：样例运行时拼装。
const FAKE = (/** @type {string} */ p, /** @type {number} */ n = 24) => p + 'x'.repeat(n);

let passed = 0;
function ok(/** @type {string} */ name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ① M-8：多行 data: 按 SSE 规范以 \n 拼接；坏帧必须 warn 一次并计数
// ─────────────────────────────────────────────────────────────────────────────
async function testSseMultilineAndBadFrames() {
  const { parseStream } = await import(pathToFileURL(path.join(srcDir, 'providers', 'openai-compatible.js')).href);
  const enc = new TextEncoder();
  const streamOf = (/** @type {string} */ text) =>
    new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(text));
        c.close();
      },
    });

  // ① 多行 data：JSON 在两个 data 行之间被折开（SSE 规范：事件内多行以 \n 连接）
  {
    const r = await parseStream(
      streamOf('data: {"choices":[{"delta":\ndata: {"content":"多行拼接"}}]}\n\n'),
      null
    );
    assert.equal(r.text, '多行拼接', 'SSE 多行 data: 必须按 \\n 拼接成一个 JSON 事件（M-8）');
    // 结构断言：JSON 的换行只是空白，join('') 在多数样本上仍能解析——但规范要求 \n，
    // 且换成 join('') 会让"多行文本/非 JSON 前缀"类网关行为漂移。这里把连接符本身钉住。
    const sseSrc = fs.readFileSync(path.join(srcDir, 'providers', 'openai-compatible.js'), 'utf8');
    assert.match(sseSrc, /const data = dataLines\.join\('\\n'\)/, '多行 data 必须用 \\n 连接（SSE 规范，不得 join("")）');
  }

  // ② 三行 data + 跨 chunk 断行：拼接后再解析，且不影响后续帧
  {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":\n'));
        c.enqueue(enc.encode('data: [{"delta":\ndata: {"content":"三行"}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n'));
        c.close();
      },
    });
    const r = await parseStream(stream, null);
    assert.equal(r.text, '三行!', '多行 data 与后续事件都必须正确解析');
    assert.equal(r.finish, 'stop', '后续事件仍应正常给出 finish');
  }

  // ③ 坏帧：不得静默丢——至少 warn 一次、计数准确，且不拖累好帧
  {
    const warns = [];
    const oldWarn = console.warn;
    console.warn = (/** @type {any[]} */ ...args) => warns.push(args.map(String).join(' '));
    let r;
    try {
      r = await parseStream(
        streamOf('data: {这里不是 JSON\n\ndata: {"choices":[{"delta":{"content":"好帧"}}]}\n\ndata: [DONE]\n\n'),
        null
      );
    } finally {
      console.warn = oldWarn;
    }
    assert.equal(r.text, '好帧', '坏帧之后的正常帧不得被丢弃');
    assert.equal(r.badFrames, 1, '坏帧必须被**计数**（返回值 badFrames；静默丢弃视为未修）');
    assert.equal(warns.length, 1, '坏帧必须 warn（至少一次；不能每帧刷屏）');
    assert.match(warns[0], /坏帧|坏.*帧/, 'warn 文案必须明确说明是坏帧/已忽略');
  }

  // ④ 兼容无空行分隔的网关：[DONE] 后紧跟 usage 尾帧（无空行）时 usage 仍必须捕获
  {
    const r = await parseStream(
      streamOf('data: {"choices":[{"delta":{"content":"尾"}}]}\n\ndata: [DONE]\ndata: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":1}}'),
      null
    );
    assert.equal(r.text, '尾', '正文仍应保留');
    assert.equal(r.usage?.prompt_tokens, 9, '[DONE] 后无空行分隔的 usage 尾帧必须仍被捕获');
  }
  ok('M-8：SSE 多行 data 拼接 + 坏帧 warn/计数可见 + [DONE] 后 usage 仍捕获');
}

// ─────────────────────────────────────────────────────────────────────────────
// ② M-9：任何异常路径都必须 cancel reader（连接释放）
// ─────────────────────────────────────────────────────────────────────────────
async function testReaderCancelOnError() {
  const { parseStream } = await import(pathToFileURL(path.join(srcDir, 'providers', 'openai-compatible.js')).href);

  // ① reader.read() 直接抛错
  {
    let cancelled = 0;
    const reader = {
      read: async () => {
        throw new Error('read-boom');
      },
      cancel: async () => {
        cancelled += 1;
      },
    };
    await assert.rejects(() => parseStream({ getReader: () => reader }, null), /read-boom/);
    assert.equal(cancelled, 1, 'read() 抛错后必须调用 reader.cancel() 释放连接（M-9）');
  }

  // ② 已收到 error 帧上抛（handleLine 抛错）——同样必须 cancel
  {
    let cancelled = 0;
    let reads = 0;
    const enc = new TextEncoder();
    const reader = {
      read: async () => {
        reads += 1;
        if (reads === 1) return { done: false, value: enc.encode('data: {"error":{"code":507,"message":"memory_refusal"}}\n\n') };
        throw new Error('should-not-read-again');
      },
      cancel: async () => {
        cancelled += 1;
      },
    };
    await assert.rejects(() => parseStream({ getReader: () => reader }, null), /memory_refusal/);
    assert.equal(cancelled, 1, 'error 帧上抛路径同样必须 cancel reader');
  }

  // ③ 正常结束也必须 cancel（幂等释放，不能只修异常路径）
  {
    let cancelled = 0;
    let done = false;
    const enc = new TextEncoder();
    const reader = {
      read: async () => {
        if (done) return { done: true, value: undefined };
        done = true;
        return { done: false, value: enc.encode('data: [DONE]\n\n') };
      },
      cancel: async () => {
        cancelled += 1;
      },
    };
    const r = await parseStream({ getReader: () => reader }, null);
    assert.equal(r.finish, 'stop');
    assert.equal(cancelled, 1, '正常结束也应在 finally 中 cancel（drain 提前退出同样释放连接）');
  }
  ok('M-9：read 抛错 / error 帧 / 正常结束三条路径均 cancel reader');
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ M-13：脱敏前缀表 + 子进程 env 过滤（每一项都有 sample 与断言）
// ─────────────────────────────────────────────────────────────────────────────
async function testRedactAndEnv() {
  const { redactSecrets, SECRET_PREFIXES } = await import(pathToFileURL(path.join(srcDir, 'redact.js')).href);
  const bash = await import(pathToFileURL(path.join(srcDir, 'tools', 'bash.js')).href);

  // 新增前缀：显式列出（表驱动遍历只能证明"表里的行能掩"，删掉一行仍会通过；
  // 所以这里先断言"必须有这一行"，再用 sample 证明"这一行真的认得"）。
  const REQUIRED_PREFIXES = ['hf_', 'shpat_', 'dckr_pat_', 'xai-', 'gsk_', 'pplx-', 'r8_', 'npm_', 'sk_live_', 'sk_test_'];
  for (const prefix of REQUIRED_PREFIXES) {
    const sample = FAKE(prefix);
    const row = SECRET_PREFIXES.find((/** @type {any} */ r) => {
      r.re.lastIndex = 0;
      return r.re.test(sample);
    });
    assert.ok(row, `前缀表必须有能认出 ${prefix} 的行（漏一行 = 该厂商 key 原样进审计/账本）`);
    const out = redactSecrets(`K=${sample} tail`);
    assert.ok(!out.includes(sample), `${prefix} 样例必须被掩码（表里有规则 ≠ 规则认得这种 key）`);
    assert.ok(out.includes(row.mask), `${prefix} 掩码后应保留 ${row.mask}`);
  }

  // 表里每一行都必须带 sample 且自洽（沿用既有表驱动口径，新增行不能只写正则）
  for (const row of SECRET_PREFIXES) {
    assert.ok(
      row && typeof row.vendor === 'string' && row.re instanceof RegExp && typeof row.mask === 'string' && typeof row.sample === 'string',
      `前缀表每行必须带 vendor/re/mask/sample，问题行：${JSON.stringify(row)}`
    );
    const out = redactSecrets(`K=${row.sample} tail`);
    assert.ok(!out.includes(row.sample), `[${row.vendor}] 自带 sample 必须被本行规则掩掉`);
  }

  // 子进程 env：新增名单逐条断言（SSH_PASSPHRASE / PGPASSWORD / DATABASE_URL 等连接串）
  const REQUIRED_ENV = [
    'SSH_PASSPHRASE',
    'PGPASSWORD',
    'DATABASE_URL',
    'MYSQL_URL',
    'POSTGRES_URL',
    'POSTGRESQL_URL',
    'REDIS_URL',
    'MONGODB_URI',
    'MONGO_URL',
    'AMQP_URL',
    'RABBITMQ_URL',
    'MY_DATABASE_URL',
    'CACHE_REDIS_URI',
  ];
  for (const name of REQUIRED_ENV) {
    assert.equal(bash.isSensitiveEnv(name), true, `${name} 必须被判为敏感 env（不得透传给子进程）`);
  }
  assert.equal(bash.isSensitiveEnv('PATH'), false, '普通变量不得被误过滤');
  assert.equal(bash.isSensitiveEnv('SSH_AUTH_SOCK'), false, 'SSH_AUTH_SOCK 是连接句柄（显式放行），不能被误伤');

  // buildChildEnv 整体行为：真实 process.env 里的这些变量不得进入子进程环境
  const backup = new Map();
  for (const name of REQUIRED_ENV) {
    backup.set(name, process.env[name]);
    process.env[name] = `secret-${name.toLowerCase()}`;
  }
  try {
    const env = bash.buildChildEnv({ cfg: {} }, true);
    for (const name of REQUIRED_ENV) assert.equal(env[name], undefined, `${name} 不得出现在子进程 env（buildChildEnv）`);
  } finally {
    for (const [name, value] of backup) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  ok('M-13：新增 10 个密钥前缀 + 13 个敏感 env 名（含 PGPASSWORD/DATABASE_URL/各类 *_URL）');
}

// ─────────────────────────────────────────────────────────────────────────────
// ④ L-9：HTTP 只回末 4 位（独立掩码函数，断言不含前 6 位）
// ─────────────────────────────────────────────────────────────────────────────
async function testTailMask() {
  const cred = await import(pathToFileURL(path.join(srcDir, 'credentials.js')).href);
  const key = FAKE('sk-httpleak-', 20);
  assert.equal(typeof cred.maskKeyTail, 'function', '必须提供 HTTP 专用的 tail-only 掩码（L-9）');
  const masked = cred.maskKeyTail(key);
  assert.equal(masked, `…${key.slice(-4)}`, 'HTTP 掩码形态应为「… + 末 4 位」（固定长度）');
  assert.ok(!masked.includes(key.slice(0, 6)), 'HTTP 掩码不得泄露 Key 前 6 位（L-9 的核心断言）');
  assert.ok(!masked.includes(key), 'HTTP 掩码不得包含完整 Key');
  assert.equal(cred.maskKeyTail(''), null, '空 Key 仍返回 null');
  assert.equal(cred.maskKeyTail('short'), '******', '过短 Key 用固定长度掩码，不回显任何字符');
  ok('L-9：HTTP 掩码只回末 4 位（不含前 6 位）');
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ H-04：A/B 两个可区分桩端点；切换后新任务只到 B，A 不再收到 Authorization/正文
// ─────────────────────────────────────────────────────────────────────────────
function freePort() {
  return new Promise((/** @type {(p:number)=>void} */ resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = /** @type {any} */ (srv.address()).port;
      srv.close(() => resolve(p));
    });
  });
}

/** @param {string} label */
function stubEndpoint(label) {
  /** @type {{url:string,auth:string,body:any,text:string}[]} */
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {}
      const text = `${label}-reply`;
      requests.push({ url: String(req.url), auth: String(req.headers.authorization || ''), body, text });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return { label, requests, server };
}

/** 读取 /api/chat 的 SSE，返回事件数组。 */
async function chatOnce(/** @type {string} */ base, /** @type {string} */ message) {
  const resp = await fetch(base + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  assert.equal(resp.status, 200, 'chat 应返回 200');
  const events = [];
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      try {
        events.push(JSON.parse(line.slice(5)));
      } catch {}
    }
  }
  return events;
}

function replyText(/** @type {any[]} */ events) {
  const streamed = events.filter((e) => e?.type === 'text').map((e) => String(e.delta || '')).join('');
  if (streamed) return streamed;
  const done = events.find((e) => e?.type === 'done');
  return String(done?.text || '');
}
function errorText(/** @type {any[]} */ events) {
  return events
    .filter((e) => e?.type === 'error')
    .map((e) => String(e.message || ''))
    .join(' | ');
}

async function testBaseUrlSwitch() {
  const KEY = FAKE('sk-probe-', 24);
  const A = stubEndpoint('A');
  const B = stubEndpoint('B');
  await new Promise((r) => A.server.listen(0, '127.0.0.1', r));
  await new Promise((r) => B.server.listen(0, '127.0.0.1', r));
  const aUrl = `http://127.0.0.1:${/** @type {any} */ (A.server.address()).port}/v1`;
  const bUrl = `http://127.0.0.1:${/** @type {any} */ (B.server.address()).port}/v1`;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-provider-'));
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ provider: 'custom', model: 'test-model', baseUrl: aUrl, permission: 'readonly', contextBudget: 32000 })
  );
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ custom: KEY }), { mode: 0o600 });

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'src', 'cli.js'), 'web', String(port)], {
    cwd: home,
    env: { ...process.env, MINGDAO_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 25000;
    while (!log.includes('地址: http://127.0.0.1:') && Date.now() < deadline) {
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(log.includes('地址: http://127.0.0.1:'), `Web 服务器未就绪；日志：${log.slice(-800)}`);

    /** @param {string} baseUrl @param {string} [apiKey] */
    const setBaseUrl = async (baseUrl, apiKey) => {
      const body = /** @type {any} */ ({ action: 'setBaseUrl', baseUrl });
      if (apiKey) body.apiKey = apiKey;
      const r = await fetch(base + '/api/models-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: r.status, json: await r.json() };
    };

    // ⓪ L-9 的 HTTP 面：服务端返回的 keyMasked 只回末 4 位
    {
      const mc = await (await fetch(base + '/api/models-config')).json();
      const custom = mc.providers.find((/** @type {any} */ p) => p.name === 'custom');
      assert.ok(custom && custom.keyState === 'stored', '测试前提：custom 服务商 Key 已入库');
      assert.equal(custom.keyMasked, `…${KEY.slice(-4)}`, 'HTTP 返回的 keyMasked 必须是 tail-only（L-9）');
      assert.ok(!custom.keyMasked.includes(KEY.slice(0, 6)), 'HTTP 返回不得泄露 Key 前 6 位（L-9）');
    }

    // ① 对话 A：主回答 + 自动标题（title 用同一 provider 实例，正是 H-04 的放大面）
    const first = await chatOnce(base, '第一问：请回答 A');
    assert.equal(replyText(first), 'A-reply', `第一轮应到 A；实际：${replyText(first)}；错误：${errorText(first)}`);
    const aAfterFirst = A.requests.length;
    assert.ok(aAfterFirst >= 1, 'A 必须收到请求');
    assert.ok(A.requests.some((r) => r.auth === `Bearer ${KEY}`), 'A 应收到 Authorization（复现条件）');
    assert.equal(B.requests.length, 0, '切换前 B 不得收到任何请求');

    // ② 切到 B（跨 origin 的凭证级操作，必须重新提交 Key）
    const sw1 = await setBaseUrl(bUrl, KEY);
    assert.equal(sw1.status, 200, `setBaseUrl 应 200：${JSON.stringify(sw1.json)}`);
    assert.equal(sw1.json.ok, true, `setBaseUrl 应成功：${sw1.json.error}`);

    // ③ 第二轮（新会话）：主回答 + 标题都只能到 B；A 不得再收到任何请求
    const second = await chatOnce(base, '第二问：只准去 B');
    assert.equal(replyText(second), 'B-reply', `切换后新任务必须到 B；实际：${replyText(second)}；错误：${errorText(second)}`);
    assert.equal(A.requests.length, aAfterFirst, 'H-04：切换后 A 不得再收到任何请求（含标题/记忆等后续请求）');
    assert.ok(B.requests.length >= 2, 'B 应收到主回答 + 自动标题（证明后续请求同样走新端点）');
    assert.ok(B.requests.some((r) => r.auth === `Bearer ${KEY}`), 'B 应收到 Authorization');
    assert.ok(
      !A.requests.some((r) => JSON.stringify(r.body || {}).includes('第二问')),
      'H-04：第二轮的用户正文不得出现在 A 的请求里'
    );

    // ④ 同地址重写：仍不得复活旧实例
    {
      const beforeA = A.requests.length;
      const sw = await setBaseUrl(bUrl);
      assert.equal(sw.status, 200, '同地址重写应成功');
      const third = await chatOnce(base, '第三问：同地址重写');
      assert.equal(replyText(third), 'B-reply', `同地址重写后仍应到 B；实际：${replyText(third)}`);
      assert.equal(A.requests.length, beforeA, '同地址重写后 A 不得收到请求');
    }

    // ⑤ 清空 baseUrl：新任务必须失败（缺少 baseUrl），不得拿旧实例继续打 B
    {
      const beforeA = A.requests.length;
      const beforeB = B.requests.length;
      const sw = await setBaseUrl('', KEY);
      assert.equal(sw.status, 200, `清空 baseUrl 应成功：${JSON.stringify(sw.json)}`);
      const cleared = await chatOnce(base, '第四问：已清空 baseUrl');
      // 清空后 resolveProviderConfig 会回落到 custom 预设的占位地址（your-gateway.example.com），
      // 因此错误文案可能是「缺少 baseUrl」或该占位地址的 fetch failed——两者都说明**没有复用旧实例**。
      // 判据取「显式失败 + A/B 都没收到请求 + 没有旧端点的回复」。
      assert.ok(errorText(cleared), `清空 baseUrl 后新任务必须显式失败（不得复用旧实例）；事件：${JSON.stringify(cleared.slice(-2))}`);
      assert.ok(!/A-reply|B-reply/.test(replyText(cleared)), '清空后不得再拿到旧端点的回复');
      assert.equal(A.requests.length, beforeA, '清空后 A 不得收到请求');
      assert.equal(B.requests.length, beforeB, '清空后 B 不得收到请求（不得复用旧 B 实例）');
    }

    // ⑥ 并发切换：切换与对话同时发生。旧任务可自然到 A；但**最终切换完成后**的新任务只能到 B
    {
      const backA = await setBaseUrl(aUrl, KEY);
      assert.equal(backA.json.ok, true, `恢复 A 失败：${backA.json.error}`);
      const [sw, raced] = await Promise.all([setBaseUrl(bUrl, KEY), chatOnce(base, '第五问：并发切换中')]);
      assert.equal(sw.status, 200, '并发切换应成功');
      assert.ok(['A-reply', 'B-reply'].includes(replyText(raced)), `并发中的旧任务应有可解释结果，实际：${replyText(raced)}`);
      const afterRaceA = A.requests.length;
      const final = await chatOnce(base, '第六问：切换完成后的新任务');
      assert.equal(replyText(final), 'B-reply', `并发切换完成后新任务必须到 B；实际：${replyText(final)}`);
      assert.equal(A.requests.length, afterRaceA, '并发切换完成后 A 不得再收到新任务请求');
    }
  } finally {
    try {
      child.kill('SIGTERM');
    } catch {}
    await new Promise((r) => {
      if (child.exitCode !== null) return r(undefined);
      child.once('close', r);
      setTimeout(r, 3000);
    });
    await new Promise((r) => A.server.close(r));
    await new Promise((r) => B.server.close(r));
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {}
  }
  ok('H-04：A→B 切换后主回答/标题只到 B；同地址重写、清空 baseUrl、并发切换均不复用旧实例');
}

// --only=<子串> 只跑匹配的分组（排查/复现用；默认全跑，变异批次不传该参数）。
const only = (process.argv.slice(2).find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
const GROUPS = [
  ['M-8', testSseMultilineAndBadFrames],
  ['M-9', testReaderCancelOnError],
  ['M-13', testRedactAndEnv],
  ['L-9', testTailMask],
  ['H-04', testBaseUrlSwitch],
];
try {
  for (const [name, fn] of GROUPS) {
    if (only && !name.includes(only)) continue;
    await fn();
  }
  console.log(`\nprovider-hardening：${passed} 组全部通过`);
} catch (e) {
  console.error('\n✗ provider-hardening 失败：');
  console.error(e);
  process.exitCode = 1;
}
