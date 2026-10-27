// Web 健壮性独立套件（v0.6.28 审计报告 A：H-01 + M-03）
//
// 运行：node test/web-robustness.js
//
// H-01：畸形 HTTP request-target（非法 IPv6 / 非法端口 / 控制字符 / 绝对形式 URI /
//       协议相对 URI / 超长目标）不得让 Web 进程退出；必须限时得到 400（或 4xx/连接关闭），
//       随后 /api/state 与静态页仍 200。
// M-03：任务注册后、主 try/finally 之前的早期异常（工作空间锁 / 会话落盘 / Provider 创建 /
//       建会话路由阶段）必须走同一个幂等 finishChat：SSE 有 error、任务 failed、running 归零、
//       onBusy(false)、5s progressTimer 已清、会话 claim 已释放、重复收尾不二次通知。
//
// 本套件**不**依赖 test/smoke.js / test/e2e-web.js，可单独运行。

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ web-robustness：${name}`);
}
function heading(name) {
  console.log(`\n[${name}]`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 隔离环境（必须在 import server.js 之前设好，锁超时在模块加载时读取） ----------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-webrb-'));
process.env.MINGDAO_HOME = home;
process.env.MINGDAO_LOCK_TIMEOUT_MS = '900'; // 锁超时：让"不可满足的锁"900ms 内失败，测试不拖 5s
process.env.MINGDAO_LOCK_STALE_MS = '600000'; // 活 pid 的锁绝不能被判陈旧回收
process.env.MINGDAO_ASK_TIMEOUT_MS = '3000';

// ---------- 桩 Provider（OpenAI 兼容） ----------
let mockRequests = 0;
const mock = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    mockRequests += 1;
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {}
    // 探针与正常回合都走这里：立即回一帧文本 + stop（不返回 tool_calls → 回合一次模型请求就结束）
    const send = () => {
      if (body.stream === false) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'mock',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 1 },
          })
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          id: 'mock',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        })}\n\n`
      );
      res.end('data: [DONE]\n\n');
    };
    setTimeout(send, 0);
  });
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const mockPort = mock.address().port;

// ---------- 配置文件 ----------
function writeConfig() {
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      provider: 'custom',
      model: 'test-model',
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      permission: 'auto',
      contextBudget: 32000,
      autoTitle: false,
      timeout: { firstTokenMs: 30000, streamIdleMs: 30000, totalMs: 60000 },
    })
  );
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ custom: 'sk-test-' + 'x'.repeat(24) }), { mode: 0o600 });
}
writeConfig();
fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });

// ---------- 5s 进度计时器观测：包一层全局 setInterval/clearInterval ----------
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
/** @type {Map<any, {ms:number, cleared:boolean}>} */
const intervals = new Map();
/** @type {any} */
globalThis.setInterval = ((fn, ms, ...args) => {
  const id = realSetInterval(fn, ms, ...args);
  try {
    intervals.set(id, { ms: Number(ms) || 0, cleared: false });
  } catch {}
  return id;
});
globalThis.clearInterval = ((id) => {
  const rec = intervals.get(id);
  if (rec) rec.cleared = true;
  return realClearInterval(id);
});
function progressIntervalsSince(before) {
  return [...intervals.entries()].filter(([id, rec]) => !before.has(id) && rec.ms === 5000).map(([, rec]) => rec);
}

// ---------- 动态导入（env 已设好） ----------
const { runWebServer, parseRequestTarget } = await import(pathToFileURL(path.join(srcDir, 'web', 'server.js')).href);

// ---------- HTTP 小工具 ----------
/** @returns {Promise<{status:number, events:any[]}>} */
async function chat(payload, { timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    assert.equal(resp.status, 200, 'chat 应返回 200（SSE 已开流）');
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
    return { status: resp.status, events };
  } finally {
    clearTimeout(timer);
  }
}

/** 原始 socket 发一行 request-target；返回 {status, closed, timedOut}。 */
function rawRequest(port, requestText, { timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    let settled = false;
    const finish = (/** @type {any} */ result) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {}
      resolve(result);
    };
    sock.setTimeout(timeoutMs, () => finish({ status: null, closed: false, timedOut: true, data }));
    sock.on('connect', () => sock.write(requestText));
    sock.on('data', (d) => {
      data += d.toString('latin1');
      if (data.includes('\r\n\r\n')) {
        const m = data.match(/^HTTP\/1\.[01] (\d{3})/);
        finish({ status: m ? Number(m[1]) : null, closed: false, timedOut: false, data });
      }
    });
    sock.on('close', () => finish({ status: null, closed: true, timedOut: false, data }));
    sock.on('error', () => finish({ status: null, closed: true, timedOut: false, data }));
  });
}

function assertTargetRejected(/** @type {any} */ r, /** @type {string} */ label) {
  assert.ok(!r.timedOut, `${label}：必须在限时内得到响应或连接关闭（实际超时无响应）`);
  assert.ok(r.closed || [400, 414, 431, 505].includes(r.status), `${label}：应得到 400/4xx 或连接关闭（实际 status=${r.status}, closed=${r.closed}）`);
}

// ---------- 起服务 ----------
/** @type {any[]} */
const busyCalls = [];
/** @type {any} */
let srv;
let base = '';
try {
  srv = await runWebServer({
    host: '127.0.0.1',
    port: 0,
    authToken: null,
    onBusy: (b) => busyCalls.push(b),
  });
  base = `http://127.0.0.1:${srv.address().port}`;

  // =========================================================================
  // ① parseRequestTarget 纯函数（表驱动）
  // =========================================================================
  heading('1. parseRequestTarget 纯函数');
  {
    assert.equal(typeof parseRequestTarget, 'function', 'server.js 必须导出 parseRequestTarget');
    const legal = [
      ['/', '/'],
      ['/api/state', '/api/state'],
      ['/api/state?token=abc', '/api/state'],
      ['/a%20b/c', '/a%20b/c'],
      ['/index.html', '/index.html'],
      ['/x?y=1&z=2', '/x'],
    ];
    for (const [raw, pathname] of legal) {
      const r = parseRequestTarget(raw);
      assert.equal(r.ok, true, `合法目标 ${raw} 应通过`);
      assert.equal(r.url.pathname, pathname, `合法目标 ${raw} 的 pathname 应为 ${pathname}`);
      assert.equal(r.url.hostname, 'localhost');
      assert.equal(r.url.port, '');
    }
    const illegal = [
      ['', '空'],
      [null, 'null'],
      [undefined, 'undefined'],
      [123, '非字符串'],
      ['http://127.0.0.1/api/state', '绝对形式 URI'],
      ['http://[::1', '非法 IPv6'],
      ['http://127.0.0.1:99999/', '非法端口（越界）'],
      ['http://127.0.0.1:abc/', '非法端口（非数字）'],
      ['//evil.example/', '协议相对 URI'],
      ['/\\evil.example/', '反斜杠（URL 解析器会当 /）'],
      ['/a\u0000b', '控制字符 NUL'],
      ['/a\rb', '控制字符 CR'],
      ['/' + 'a'.repeat(9000), '超长目标'],
      ['foo', '非 origin-form'],
      ['*', 'OPTIONS *（本服务不接受）'],
    ];
    for (const [raw, label] of illegal) {
      const r = parseRequestTarget(raw);
      assert.equal(r.ok, false, `${label} 应被拒绝`);
      assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `${label} 应给出拒绝原因`);
    }
    ok('合法 6 例 / 非法 15 例表驱动');
  }

  // =========================================================================
  // ② 原始 socket：畸形 request-target 不得杀进程
  // =========================================================================
  heading('2. 原始 socket 畸形请求（H-01）');
  {
    const port = srv.address().port;
    const host = `127.0.0.1:${port}`;
    const cases = [
      ['非法 IPv6 目标', `GET http://[::1 HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`],
      ['非法端口（越界）', `GET http://127.0.0.1:99999/ HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`],
      ['控制字符', `GET /api/\x01state HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`],
      ['绝对形式 URI', `GET http://${host}/api/state HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`],
      ['协议相对 URI', `GET //evil.example/ HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`],
      ['反斜杠目标', `GET /\\evil.example/ HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`],
      ['超长目标', `GET /${'a'.repeat(20000)} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`],
    ];
    for (const [label, text] of cases) {
      const r = await rawRequest(port, text);
      assertTargetRejected(r, label);
    }
    // 进程仍存活 + 正常请求仍可用
    assert.equal(process.exitCode, undefined, '进程不得因畸形请求设置退出码');
    const st = await fetch(base + '/api/state');
    assert.equal(st.status, 200, '畸形请求之后 /api/state 必须 200');
    const page = await fetch(base + '/');
    assert.equal(page.status, 200, '畸形请求之后静态页必须 200');
    ok('7 类畸形目标后进程存活，/api/state 与静态页 200');
  }

  // =========================================================================
  // ③ M-03：早期异常必须完整收尾
  // =========================================================================
  heading('3. M-03 早期异常收尾');

  let scenarioNo = 0;
  /** @type {null | (() => void)} */
  let scRestoreAppend = null;
  /** 每个场景用独立会话文件；返回 body.file */
  function newSession(tag) {
    const file = `sess-${tag}.jsonl`;
    fs.writeFileSync(path.join(home, 'sessions', file), JSON.stringify({ role: 'user', content: `prior ${tag}`, ts: new Date().toISOString() }) + '\n');
    return file;
  }

  /**
   * 注入 → 发一次注定早期失败的聊天 → 断言完整收尾 → 解除注入 → 同会话再来一次（claim 已释放）
   * @param {{name:string, tag:string, setup:()=>any, teardown:()=>any, expect:RegExp}} sc
   */
  async function faultScenario(sc) {
    scenarioNo += 1;
    const file = newSession(sc.tag);
    const message = `fault-${sc.tag}`;
    const beforeIntervals = new Set(intervals.keys());
    busyCalls.length = 0;
    await sc.setup();
    let first;
    try {
      first = await chat({ file, message });
    } finally {
      await sc.teardown();
    }
    const errors = first.events.filter((e) => e.type === 'error');
    assert.equal(errors.length, 1, `${sc.name}：SSE 必须恰好一条 error（实际 ${errors.length}）`);
    assert.ok(sc.expect.test(String(errors[0].message || '')), `${sc.name}：error 文案应含 ${sc.expect}（实际：${errors[0].message}）`);
    await sleep(80);
    const tasksResp = await (await fetch(base + '/api/tasks')).json();
    assert.equal(tasksResp.running, 0, `${sc.name}：/api/tasks.running 必须归零`);
    const task = tasksResp.tasks.find((t) => t.message === message.slice(0, 40));
    assert.ok(task, `${sc.name}：任务应仍可在 /api/tasks 中查到（收尾不是删除）`);
    assert.equal(task.status, 'failed', `${sc.name}：任务终态必须是 failed`);
    // 忙状态：true 一次、false 一次（重复收尾不得二次通知）
    assert.deepEqual(busyCalls, [true, false], `${sc.name}：onBusy 必须恰好 true→false（实际 ${JSON.stringify(busyCalls)}）`);
    // 5s 进度计时器必须被清
    const created = progressIntervalsSince(beforeIntervals);
    assert.ok(created.length >= 1, `${sc.name}：应创建过 5s 进度计时器`);
    assert.ok(created.every((r) => r.cleared), `${sc.name}：finishChat 必须 clearInterval(progressTimer)`);
    // claim 释放：同一会话再来一次不得被判「已有任务在运行」
    const second = await chat({ file, message: `after-${sc.tag}` });
    const busyErr = second.events.find((e) => e.type === 'error' && /已有任务在运行/.test(String(e.message || '')));
    assert.equal(busyErr, undefined, `${sc.name}：会话 claim 必须释放（第二次同会话被误判忙）`);
    await sleep(80);
    const after = await (await fetch(base + '/api/tasks')).json();
    assert.equal(after.running, 0, `${sc.name}：第二次收尾后 running 必须归零`);
    assert.equal(busyCalls.at(-1), false, `${sc.name}：第二次收尾后忙状态必须恢复 false`);
    ok(`${sc.name}：error/failed/running=0/onBusy true→false/timer 清/claim 释放`);
  }

  // ③-1 工作空间锁：报告原样复现（活 pid 的 lock 不可回收 → setSessionWorkspace 超时）
  await faultScenario({
    name: '工作空间锁',
    tag: 'ws-lock',
    setup() {
      fs.writeFileSync(path.join(home, 'session-workspaces.json.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    },
    teardown() {
      try {
        fs.unlinkSync(path.join(home, 'session-workspaces.json.lock'));
      } catch {}
    },
    expect: /获取文件锁超时/,
  });

  // ③-2 会话文件锁/落盘：appendMessages 写失败（EACCES 注入）
  await faultScenario({
    name: '会话落盘',
    tag: 'append',
    setup() {
      fs.writeFileSync(path.join(home, 'sessions', 'sess-append.jsonl'), JSON.stringify({ role: 'user', content: 'prior append', ts: new Date().toISOString() }) + '\n');
      const target = path.join(home, 'sessions', 'sess-append.jsonl');
      const orig = fs.appendFileSync;
      fs.appendFileSync = /** @type {any} */ (
        function (/** @type {any} */ file, ...rest) {
          if (path.resolve(String(file)) === path.resolve(target)) {
            const e = /** @type {any} */ (new Error('EACCES: permission denied（注入：会话文件不可写）'));
            e.code = 'EACCES';
            throw e;
          }
          return orig.call(fs, file, ...rest);
        }
      );
      scRestoreAppend = () => {
        fs.appendFileSync = orig;
      };
    },
    async teardown() {
      if (scRestoreAppend) scRestoreAppend();
    },
    expect: /对话失败：.*EACCES/,
  });

  // ③-3 Provider 创建/取用：凭证文件在回合发起时不可读 → 943 行的 apiKey 预检抛错，
  // 走 handleChat 的 Provider try/catch（报告 :941-946 的边界）。
  const credPath = path.join(home, 'credentials.json');
  const credRaw = fs.readFileSync(credPath, 'utf8');
  await faultScenario({
    name: 'Provider 创建',
    tag: 'provider',
    setup() {
      fs.rmSync(credPath, { force: true });
    },
    async teardown() {
      fs.writeFileSync(credPath, credRaw, { mode: 0o600 });
    },
    expect: /模型 test-model 不可用/,
  });

  // ③-4 路由/建会话阶段：sessions 目录被一个普通文件占据 → createSession 抛错
  await faultScenario({
    name: '建会话（路由早期）',
    tag: 'create',
    setup() {
      // 该场景不使用已有会话文件：临时把 sessions 目录换成文件
      fs.rmSync(path.join(home, 'sessions'), { recursive: true, force: true });
      fs.writeFileSync(path.join(home, 'sessions'), 'not a directory');
    },
    async teardown() {
      fs.rmSync(path.join(home, 'sessions'), { force: true });
      fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    },
    expect: /对话失败：/,
  });

  ok(`M-03 共 ${scenarioNo} 个早期异常故障点全部完整收尾`);

  // =========================================================================
  // ④ 独立子进程：真实 CLI 进程存活（H-01 的直接证据）
  // =========================================================================
  heading('4. 真实 CLI 进程存活（H-01）');
  {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(srcDir, 'cli.js'), 'web', String(port)], {
      cwd: root,
      env: { ...process.env, MINGDAO_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const deadline = Date.now() + 20000;
    while (!out.includes(`地址: http://127.0.0.1:${port}`) && Date.now() < deadline && child.exitCode === null) {
      await sleep(100);
    }
    try {
      assert.ok(out.includes(`地址: http://127.0.0.1:${port}`), `CLI 子进程应在 20s 内就绪\nstdout=${out}\nstderr=${err}`);
      for (const text of [
        `GET http://[::1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
        `GET http://127.0.0.1:99999/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
        `GET http://127.0.0.1:${port}/api/state HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      ]) {
        const r = await rawRequest(port, text);
        assertTargetRejected(r, 'CLI 子进程畸形目标');
      }
      await sleep(250);
      assert.equal(child.exitCode, null, `CLI 进程必须存活（实际退出码 ${child.exitCode}，stderr=${err.slice(-800)}）`);
      const st = await fetch(`http://127.0.0.1:${port}/api/state`);
      assert.equal(st.status, 200, 'CLI 进程存活后 /api/state 必须 200');
      const page = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(page.status, 200, 'CLI 进程存活后静态页必须 200');
      ok('CLI 子进程收到畸形目标后仍存活，/api/state 与静态页 200');
    } finally {
      try {
        child.kill('SIGTERM');
      } catch {}
      await Promise.race([new Promise((r) => child.once('close', r)), sleep(3000)]);
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    }
  }
} finally {
  // 清理：未清的 5s 计时器会拖住进程；恢复全局计时器
  for (const [id, rec] of intervals) {
    if (!rec.cleared) {
      try {
        realClearInterval(id);
      } catch {}
    }
  }
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  try {
    await Promise.race([new Promise((r) => (srv ? srv.close(r) : r(undefined))), sleep(2000)]);
  } catch {}
  try {
    await Promise.race([new Promise((r) => mock.close(r)), sleep(2000)]);
  } catch {}
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {}
}

/** 取一个可 bind 的随机端口（避开 Linux 临时端口段，与 e2e-web 同一做法）。 */
async function freePort() {
  for (let i = 0; i < 8; i++) {
    const p = 20000 + Math.floor(Math.random() * 12000);
    const okBind = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (okBind) return p;
  }
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

console.log(`\n✓ web-robustness：${passed} 项通过`);
process.exit(0);
