// 同步服务「注册边界 + 锁纪律 + 数据面配额 + WebUI 权限」加固回归（v0.6.30 第三方核验 N-10 / N-15 / N-16 / N-17 / N-3 / H-11）。
//
//   node test/sync-registration-hardening.js
//
// 这套件刻意**不**塞进 smoke.js，只覆盖本轮四条修复：
//   F1（N-10）默认 closed 不再从请求推断「本机来源」：
//      ① 伪造 X-Forwarded-For: 127.0.0.1 不能注册；② 文档推荐的「回环监听 + nginx 反代」形态下
//      外部客户端（socket 恒为 127.0.0.1）也不能注册；③ 只有显式
//      MINGDAO_SYNC_ALLOW_LOOPBACK_REGISTRATION=1 + 本机**直连**（无代理配置、无转发头）才放行；
//      ④ SYNC_TRUST_PROXY_HOPS=1 按右起第 1 跳取来源（左起第一段是客户端自填）；⑤ 未设
//      TRUST_PROXY 时完全忽略 XFF，轮换 XFF 12 次仍被来源桶限流。
//   F2（N-15/N-16/N-17）锁纪律与账号桶：
//      ① 注册的 scrypt 在锁外（锁内 await hash 时，并发的 pair 会被拖住）；
//      ② users.json 只允许一把互斥锁（没有第二个 registerLock）；
//      ③ 账号桶只对已存在账号计数：不存在的用户名重复打不会 429；
//      ④ 账号锁定退避有上限、成功即清零，真实用户不会被永久锁死。
//   F3（N-3）数据面配额：/api/sessions/push 与 /api/sessions/pull 有每账号每分钟请求上限
//      与每日字节配额（SYNC_QUOTA_MB_PER_DAY），超限 429 且 usedBytes/limitBytes/resetAt 可见。
//   F4（H-11）无令牌 WebUI 不得把权限改成 auto（只允许 ask/readonly），有令牌不受限；
//      /api/state 暴露 permissionAutoAllowed / permissionNote，使限制在界面上可见。
//
// 为什么 F1/F3 用子进程、F2 用进程内：F1 需要按场景切换 TRUST_PROXY / HOPS / 注册开关（模块级
// 常量在 import 时固化）；F3 的配额上限同样在 import 时固化。F2 需要替换 crypto.scrypt 制造
// 可控的「锁外 hash」屏障，只能在进程内做。

process.env.MINGDAO_HOME = process.env.MINGDAO_HOME || '';
process.env.SYNC_TRUST_PROXY = '1'; // F2 用 XFF 模拟多来源 IP（本机 macOS 没有 127.0.0.0/8 别名）
process.env.MINGDAO_SYNC_REGISTRATION = 'open'; // F2 只测注册之后的锁/账号逻辑，注册入口显式开放

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const syncServerPath = path.join(srcDir, 'sync-server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 可控 scrypt 屏障（N-15） ----------
// sync-server 在模块顶层 promisify(crypto.scrypt)，所以必须在动态 import 之前替换。
const realScrypt = crypto.scrypt;
/** @type {null | { password: string, started: () => void, released: Promise<void> }} */
let scryptGate = null;
// @ts-ignore 运行时替换内置回调函数（只影响本测试进程）
crypto.scrypt = (...args) => {
  const password = String(args[0]);
  if (scryptGate && scryptGate.password === password) {
    const g = scryptGate;
    scryptGate = null;
    g.started();
    void g.released.then(() => realScrypt.apply(crypto, args));
    return;
  }
  return realScrypt.apply(crypto, args);
};
/** @param {string} password */
function armScryptGate(password) {
  /** @type {any} */
  let startedResolve;
  const started = new Promise((r) => {
    startedResolve = r;
  });
  /** @type {any} */
  let releaseResolve;
  const released = new Promise((r) => {
    releaseResolve = r;
  });
  scryptGate = { password, started: startedResolve, released };
  return { started, release: () => releaseResolve() };
}

const { runSyncServer } = await import(pathToFileURL(syncServerPath).href);

// ---------- 小工具 ----------
/**
 * @param {number} port
 * @param {string} method
 * @param {string} pathname
 * @param {{ body?: any, token?: string, xff?: string, headers?: Record<string,string>, timeoutMs?: number }} [opts]
 */
function request(port, method, pathname, opts = {}) {
  const { body, token, xff, headers: extraHeaders, timeoutMs = 8000 } = opts;
  const data = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    /** @type {any} */
    const headers = { Connection: 'close', ...(extraHeaders || {}) };
    if (data !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    if (xff !== undefined) headers['X-Forwarded-For'] = xff;
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        /** @type {any} */
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {}
        resolve({ status: Number(res.statusCode), text, json });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
/** @param {number} port @param {string} pathname @param {any} body @param {Record<string,string>} [headers] */
const post = (port, pathname, body, headers = {}) => request(port, 'POST', pathname, { body, headers });
/** @param {number} port @param {string} pathname @param {string} token @param {any} [body] */
const postAuth = (port, pathname, token, body = {}) => request(port, 'POST', pathname, { body, token });

let ipSeq = 0;
/** 每个请求一个独立来源 IP（避免来源桶在用例之间互相污染；198.18.0.0/15 是基准测试网段）。 */
const nextIp = () => `198.18.${Math.floor(ipSeq / 240)}.${(ipSeq++ % 240) + 1}`;

/**
 * 起一个进程内同步服务（顺序执行；数据目录是模块级全局，不能并发起两个）。
 * @template T
 * @param {(ctx: { dir: string, port: number }) => Promise<T>} fn
 * @param {{ host?: string }} [opts]
 * @returns {Promise<T>}
 */
async function withServer(fn, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-sync-reg-hard-'));
  const srv = runSyncServer({ port: 0, host: opts.host || '127.0.0.1', dataDir: dir });
  await new Promise((resolve, reject) => {
    srv.once('listening', resolve);
    srv.once('error', reject);
  });
  const port = srv.address().port;
  try {
    return await fn({ dir, port });
  } finally {
    srv.closeAllConnections?.();
    await new Promise((resolve) => srv.close(() => resolve(undefined)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {string} dir @param {string} username @param {string} [password] */
async function setupUser(port, username, password = 'password123') {
  const r = await request(port, 'POST', '/api/register', { body: { username, password }, xff: nextIp() });
  assert.equal(r.status, 200, `前置注册 ${username} 应成功（实际 ${r.status} ${r.text}）`);
  const p = await request(port, 'POST', '/api/pair', { body: { username, password, deviceName: 'dev' }, xff: nextIp() });
  assert.equal(p.status, 200, `前置配对 ${username} 应成功（实际 ${p.status} ${p.text}）`);
  return p.json.token;
}

/**
 * 独立子进程起一个同步服务（按场景切换模块级 env）。
 * @param {Record<string, string>} extraEnv
 */
async function startSyncChild(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-sync-child-'));
  const env = { ...process.env, SYNC_DATA_DIR: dir, SYNC_PORT: '0', SYNC_HOST: '127.0.0.1' };
  for (const k of ['SYNC_TRUST_PROXY', 'SYNC_TRUST_PROXY_HOPS', 'MINGDAO_SYNC_REGISTRATION', 'MINGDAO_SYNC_ALLOW_LOOPBACK_REGISTRATION']) {
    delete env[k];
  }
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, [syncServerPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  let port = 0;
  for (let i = 0; i < 120 && !port; i++) {
    const m = out.match(/已启动 http\S*:\/\/([^:]+):(\d+)/);
    if (m) port = Number(m[2]);
    else await sleep(50);
  }
  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('close', r));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  if (!port) {
    await stop();
    throw new Error(`同步服务子进程未在 6s 内就绪：${out.slice(-1000)}`);
  }
  return { child, dir, port, out: () => out, stop };
}

// ---------- 测试框架 ----------
/** @type {{ name: string, ok: boolean, error?: any }[]} */
const results = [];
/**
 * @param {string} name
 * @param {() => Promise<void> | void} fn
 */
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✅ ${name}`);
  } catch (/** @type {any} */ e) {
    results.push({ name, ok: false, error: e });
    console.log(`❌ ${name}\n   ${String(e?.message || e).split('\n').join('\n   ')}`);
  }
}

const readSrc = (/** @type {string} */ name) => fs.readFileSync(path.join(root, name), 'utf8');
/** 结构守卫只看**代码**：注释里提到旧标识符/旧做法不算违规。 */
const stripComments = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const syncSrc = readSrc('src/sync-server.js');
const syncCode = stripComments(syncSrc);

// =====================================================================
// F1（N-10）：默认 closed 不可被请求头 / 回环反代击穿
// =====================================================================
await test('F1-1 伪造 XFF=127.0.0.1 与真实外网 XFF 都必须 403（poc-m14）', async () => {
  const s = await startSyncChild({ SYNC_TRUST_PROXY: '1' });
  try {
    const forged = await request(s.port, 'POST', '/api/register', {
      body: { username: 'poc_alice', password: 'alicepass123' },
      xff: '127.0.0.1',
    });
    assert.equal(forged.status, 403, `伪造 XFF=127.0.0.1 必须被拒（实际 ${forged.status} ${forged.text}）`);
    assert.ok(/注册已关闭/.test(forged.json?.error || ''), '错误信息应说明注册已关闭');
    const real = await request(s.port, 'POST', '/api/register', {
      body: { username: 'poc_bob', password: 'bobpass12345' },
      xff: '8.8.8.8',
    });
    assert.equal(real.status, 403, `真实外网 XFF 必须是 403（实际 ${real.status}）`);
  } finally {
    await s.stop();
  }
});

await test('F1-2 回环监听 + nginx 反代（无 XFF，socket 恒 127.0.0.1）必须 403（poc-m14b）', async () => {
  const s = await startSyncChild({ SYNC_HOST: '127.0.0.1' });
  try {
    const r = await post(s.port, '/api/register', { username: 'poc_dave', password: 'davepass1234' });
    assert.equal(r.status, 403, `反代形态下外部客户端必须被拒（实际 ${r.status} ${r.text}）`);
    assert.ok(/注册已关闭/.test(r.json?.error || ''), '错误信息应说明注册已关闭');
  } finally {
    await s.stop();
  }
});

await test('F1-3 默认本机直连也不再隐式放行（必须显式声明）', async () => {
  const s = await startSyncChild({});
  try {
    const r = await post(s.port, '/api/register', { username: 'localboot', password: 'password123' });
    assert.equal(r.status, 403, `未显式开启豁免时本机直连也必须 403（实际 ${r.status} ${r.text}）`);
    assert.ok(/MINGDAO_SYNC_ALLOW_LOOPBACK_REGISTRATION/.test(s.out()), '启动日志必须给出显式开关名称');
  } finally {
    await s.stop();
  }
});

await test('F1-4 显式 ALLOW_LOOPBACK_REGISTRATION=1 + 本机直连 → 200', async () => {
  const s = await startSyncChild({ MINGDAO_SYNC_ALLOW_LOOPBACK_REGISTRATION: '1' });
  try {
    const r = await post(s.port, '/api/register', { username: 'localok', password: 'password123' });
    assert.equal(r.status, 200, `显式允许后本机直连应可注册（实际 ${r.status} ${r.text}）`);
    assert.equal(r.json?.ok, true, '响应必须是 ok:true');
    assert.ok(/MINGDAO_SYNC_ALLOW_LOOPBACK_REGISTRATION=1/.test(s.out()), '启动日志必须写明显式开关已生效');
    assert.ok(/仅.*直连|直连/.test(s.out()), '启动日志必须说明仅直连生效');
  } finally {
    await s.stop();
  }
});

await test('F1-5 显式允许 + TRUST_PROXY + XFF：经代理进来的请求仍 403', async () => {
  const s = await startSyncChild({
    MINGDAO_SYNC_ALLOW_LOOPBACK_REGISTRATION: '1',
    SYNC_TRUST_PROXY: '1',
  });
  try {
    const r = await request(s.port, 'POST', '/api/register', {
      body: { username: 'viaproxy', password: 'password123' },
      xff: '127.0.0.1',
    });
    assert.equal(r.status, 403, `显式允许也只限直连：带 XFF/代理配置时必须 403（实际 ${r.status} ${r.text}）`);
  } finally {
    await s.stop();
  }
});

await test('F1-6 显式允许 + 本机直连但携带转发头 → 403（不得用请求头自称直连）', async () => {
  const s = await startSyncChild({ MINGDAO_SYNC_ALLOW_LOOPBACK_REGISTRATION: '1' });
  try {
    const r = await request(s.port, 'POST', '/api/register', {
      body: { username: 'spoofdirect', password: 'password123' },
      xff: '127.0.0.1',
    });
    assert.equal(r.status, 403, `带任何转发头都不算直连（实际 ${r.status} ${r.text}）`);
  } finally {
    await s.stop();
  }
});

await test('F1-7 SYNC_TRUST_PROXY_HOPS=1 取右起第 1 跳：轮换左侧段仍被来源桶限流', async () => {
  const s = await startSyncChild({ SYNC_TRUST_PROXY_HOPS: '1' });
  try {
    /** @type {number[]} */
    const codes = [];
    for (let i = 0; i < 12; i++) {
      const r = await request(s.port, 'POST', '/api/register', {
        body: { username: `hopuser${i}`, password: 'password123' },
        xff: `10.0.${i}.1, 203.0.113.9`, // 左侧（客户端自填）每次不同，右起第 1 跳固定
      });
      codes.push(r.status);
    }
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(403), `前 10 次应是 403（实际 ${codes.join(',')}）`);
    assert.equal(codes[10], 429, `左起段轮换不得重置来源桶：第 11 次必须 429（实际 ${codes[10]}）`);
    assert.equal(codes[11], 429, `第 12 次必须 429（实际 ${codes[11]}）`);
  } finally {
    await s.stop();
  }
});

await test('F1-8 SYNC_TRUST_PROXY_HOPS=1 不取左起第一段：左侧固定、右侧轮换 → 全部 403', async () => {
  const s = await startSyncChild({ SYNC_TRUST_PROXY_HOPS: '1' });
  try {
    /** @type {number[]} */
    const codes = [];
    for (let i = 0; i < 12; i++) {
      const r = await request(s.port, 'POST', '/api/register', {
        body: { username: `leftfix${i}`, password: 'password123' },
        xff: `198.51.100.1, 203.0.113.${i + 1}`, // 左起固定、右起每次不同
      });
      codes.push(r.status);
    }
    assert.ok(codes.every((c) => c === 403), `按右起取来源时左起固定不应触发限流（实际 ${codes.join(',')}）`);
  } finally {
    await s.stop();
  }
});

await test('F1-9 未设 TRUST_PROXY 时完全忽略 XFF：轮换 XFF 12 次仍被限流', async () => {
  const s = await startSyncChild({});
  try {
    /** @type {number[]} */
    const codes = [];
    for (let i = 0; i < 12; i++) {
      const r = await request(s.port, 'POST', '/api/register', {
        body: { username: `xffrot${i}`, password: 'password123' },
        xff: `8.8.${i}.${i + 1}`,
      });
      codes.push(r.status);
    }
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(403), `前 10 次应是 403（实际 ${codes.join(',')}）`);
    assert.equal(codes[10], 429, `未设 TRUST_PROXY 时 XFF 必须被忽略：第 11 次必须 429（实际 ${codes[10]}）`);
    assert.equal(codes[11], 429, `第 12 次必须 429（实际 ${codes[11]}）`);
  } finally {
    await s.stop();
  }
});

await test('F1-10 显式 MINGDAO_SYNC_REGISTRATION=closed + 允许开关：显式 closed 优先，仍 403', async () => {
  const s = await startSyncChild({
    MINGDAO_SYNC_REGISTRATION: 'closed',
    MINGDAO_SYNC_ALLOW_LOOPBACK_REGISTRATION: '1',
  });
  try {
    const r = await post(s.port, '/api/register', { username: 'explicitclosed', password: 'password123' });
    assert.equal(r.status, 403, `显式 closed 必须连本机也拒绝（实际 ${r.status} ${r.text}）`);
  } finally {
    await s.stop();
  }
});

await test('F1-11 首启一次性引导码：无码 403 / 有效码 200 / 旧码轮换后失效', async () => {
  const s = await startSyncChild({});
  const codeFile = path.join(os.tmpdir(), `mingdao-sync-bootstrap-${s.port}.txt`);
  try {
    for (let i = 0; i < 40 && !fs.existsSync(codeFile); i++) await sleep(50);
    assert.ok(fs.existsSync(codeFile), '默认 closed 首次启动（无账号）应生成 0600 本机引导码文件');
    const code = fs.readFileSync(codeFile, 'utf8').trim();
    assert.match(code, /^[a-f0-9]{32}$/i, `引导码格式应是一次性随机码（实际 ${code.slice(0, 12)}…）`);
    const noCode = await post(s.port, '/api/register', { username: 'boot_nocode', password: 'password123' });
    assert.equal(noCode.status, 403, `没有引导码必须 403（实际 ${noCode.status}）`);
    const withCode = await post(s.port, '/api/register', { username: 'boot_ok', password: 'password123', inviteCode: code });
    assert.equal(withCode.status, 200, `本机直连 + 有效引导码应可注册（实际 ${withCode.status} ${withCode.text}）`);
    const rotated = fs.readFileSync(codeFile, 'utf8').trim();
    assert.notEqual(rotated, code, '注册成功后引导码必须轮换（旧码立即失效）');
    const stale = await post(s.port, '/api/register', { username: 'boot_stale', password: 'password123', inviteCode: code });
    assert.equal(stale.status, 403, `旧引导码不得重复使用（实际 ${stale.status}）`);
    const fresh = await post(s.port, '/api/register', { username: 'boot_newcode', password: 'password123', inviteCode: rotated });
    assert.equal(fresh.status, 200, `轮换后的新码应可继续首启（实际 ${fresh.status}）`);
  } finally {
    await s.stop();
    try {
      fs.unlinkSync(codeFile);
    } catch {}
  }
});

await test('F1-12 首启引导码只对直连有效：经代理/带 XFF 的请求即使有码也 403', async () => {
  const s = await startSyncChild({ SYNC_TRUST_PROXY: '1' });
  const codeFile = path.join(os.tmpdir(), `mingdao-sync-bootstrap-${s.port}.txt`);
  try {
    for (let i = 0; i < 40 && !fs.existsSync(codeFile); i++) await sleep(50);
    const code = fs.readFileSync(codeFile, 'utf8').trim();
    const r = await request(s.port, 'POST', '/api/register', {
      body: { username: 'boot_proxied', password: 'password123', inviteCode: code },
      xff: '203.0.113.77',
    });
    assert.equal(r.status, 403, `引导码不得被代理来源使用（实际 ${r.status} ${r.text}）`);
  } finally {
    await s.stop();
    try {
      fs.unlinkSync(codeFile);
    } catch {}
  }
});

// =====================================================================
// F2（N-15 / N-16 / N-17）：锁纪律与账号桶
// =====================================================================
await test('F2-1 doRegister 的 scrypt 在锁外：hash 被挂起时并发 pair 不被拖住', async () => {
  await withServer(async ({ port }) => {
    const token = await setupUser(port, 'gateholder');
    assert.ok(token, '前置：gateholder 应拿到设备 token');
    const gate = armScryptGate('gatedpass123');
    const regP = request(port, 'POST', '/api/register', {
      body: { username: 'gateduser', password: 'gatedpass123' },
      xff: nextIp(),
    });
    await gate.started;
    const pairP = request(port, 'POST', '/api/pair', {
      body: { username: 'gateholder', password: 'password123', deviceName: 'concurrent' },
      xff: nextIp(),
    });
    /** @type {any} */
    let raced;
    try {
      raced = await Promise.race([pairP, sleep(1500).then(() => ({ timeout: true }))]);
    } finally {
      gate.release();
    }
    const reg = await regP;
    const pair = raced.timeout ? await pairP : raced;
    assert.ok(!raced.timeout, '锁内 await hash 会拖住并发写：配对应在 1.5s 内完成（scrypt 必须在锁外）');
    assert.equal(pair.status, 200, `并发配对应成功（实际 ${pair.status} ${pair.text}）`);
    assert.equal(reg.status, 200, `放行后注册应成功（实际 ${reg.status} ${reg.text}）`);
  });
});

await test('F2-2 结构守卫：doRegister 先算 hash、后进 withWriteLock', async () => {
  const start = syncCode.indexOf('async function doRegister');
  const end = syncCode.indexOf('async function doPair');
  assert.ok(start >= 0 && end > start, '源码里应能定位 doRegister');
  const body = syncCode.slice(start, end);
  const hashAt = body.indexOf('await hashPassword');
  const lockAt = body.indexOf('withWriteLock');
  assert.ok(hashAt >= 0, 'doRegister 必须在锁外计算密码哈希');
  assert.ok(lockAt >= 0, 'doRegister 必须使用统一的 withWriteLock');
  assert.ok(hashAt < lockAt, 'doRegister 的 hash 必须早于 withWriteLock（锁内不得 await CPU 等待）');
});

await test('F2-3 结构守卫：users.json 只允许一把互斥锁（不得再有 registerLock）', async () => {
  assert.ok(!/registerLock/.test(syncCode), 'users.json 只允许一把互斥锁：源码不得再出现 registerLock');
  const lockDefs = syncCode.match(/let\s+writeLock\s*=\s*null;/g) || [];
  assert.equal(lockDefs.length, 1, `写互斥量必须只有一个（实际 ${lockDefs.length} 个）`);
});

await test('F2-4 并发同名注册：恰好一个 200、一个 409，users.json 只有一条', async () => {
  await withServer(async ({ dir, port }) => {
    const body = { username: 'sameuser', password: 'password123' };
    const [a, b] = await Promise.all([
      request(port, 'POST', '/api/register', { body, xff: nextIp() }),
      request(port, 'POST', '/api/register', { body, xff: nextIp() }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], `并发同名注册必须一成一败（实际 ${a.status}/${b.status}）`);
    const users = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'));
    assert.equal(Object.keys(users).filter((k) => k === 'sameuser').length, 1, 'users.json 不得出现重复同名条目');
  });
});

await test('F2-5 并发不同名注册：全部 200 且 users.json 无丢失（单锁读改写）', async () => {
  await withServer(async ({ dir, port }) => {
    const names = Array.from({ length: 8 }, (_, i) => `batchuser${i}`);
    const rs = await Promise.all(
      names.map((username) => request(port, 'POST', '/api/register', { body: { username, password: 'password123' }, xff: nextIp() }))
    );
    assert.ok(rs.every((r) => r.status === 200), `并发注册应全部成功（实际 ${rs.map((r) => r.status).join(',')}）`);
    const users = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'));
    for (const name of names) assert.ok(users[name], `users.json 不得丢失并发注册的 ${name}`);
  });
});

await test('F2-6 N-17③ 不存在的用户名只走来源桶：跨 IP 重复 8 次全部 404、绝不 429', async () => {
  await withServer(async ({ port }) => {
    /** @type {number[]} */
    const codes = [];
    for (let i = 0; i < 8; i++) {
      const r = await request(port, 'POST', '/api/pair', {
        body: { username: 'ghostuser', password: 'whatever123', deviceName: 'x' },
        xff: nextIp(),
      });
      codes.push(r.status);
    }
    assert.ok(!codes.includes(429), `不存在的账号不得进入账号桶（实际 ${codes.join(',')}）`);
    assert.ok(codes.every((c) => c === 404), `应全部返回 404（实际 ${codes.join(',')}）`);
  });
});

await test('F2-7 N-17① 已存在账号：5 次错误后第 6 次（跨 IP）429', async () => {
  await withServer(async ({ port }) => {
    await setupUser(port, 'victimacct');
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const r = await request(port, 'POST', '/api/pair', {
        body: { username: 'victimacct', password: 'wrongpass123', deviceName: 'x' },
        xff: nextIp(),
      });
      codes.push(r.status);
    }
    assert.deepEqual(codes, [401, 401, 401, 401, 401], `前 5 次应为 401（实际 ${codes.join(',')}）`);
    const sixth = await request(port, 'POST', '/api/pair', {
      body: { username: 'victimacct', password: 'wrongpass123', deviceName: 'x' },
      xff: nextIp(),
    });
    assert.equal(sixth.status, 429, `第 6 次必须 429（实际 ${sixth.status} ${sixth.text}）`);
    assert.ok(sixth.json?.retryAfterMs > 0, '429 应给出剩余退避时间');
  });
});

await test('F2-8 N-17② 锁定有上限且成功即清零：退避过后正确密码可恢复', async () => {
  await withServer(async ({ port }) => {
    await setupUser(port, 'recoveruser');
    for (let i = 0; i < 5; i++) {
      await request(port, 'POST', '/api/pair', {
        body: { username: 'recoveruser', password: 'wrongpass123', deviceName: 'x' },
        xff: nextIp(),
      });
    }
    const locked = await request(port, 'POST', '/api/pair', {
      body: { username: 'recoveruser', password: 'wrongpass123', deviceName: 'x' },
      xff: nextIp(),
    });
    assert.equal(locked.status, 429, `退避期内应 429（实际 ${locked.status}）`);
    const wait = Number(locked.json?.retryAfterMs || 0);
    assert.ok(wait > 0 && wait <= 60000, `账号退避必须有上限（实际 retryAfterMs=${wait}）`);
    await sleep(wait + 150);
    const ok = await request(port, 'POST', '/api/pair', {
      body: { username: 'recoveruser', password: 'password123', deviceName: 'recovered' },
      xff: nextIp(),
    });
    assert.equal(ok.status, 200, `退避到期后正确密码必须能恢复（实际 ${ok.status} ${ok.text}）`);
    const after = [];
    for (let i = 0; i < 4; i++) {
      const r = await request(port, 'POST', '/api/pair', {
        body: { username: 'recoveruser', password: 'wrongpass123', deviceName: 'x' },
        xff: nextIp(),
      });
      after.push(r.status);
    }
    assert.deepEqual(after, [401, 401, 401, 401], `成功认证后账号桶必须清零（实际 ${after.join(',')}）`);
  });
});

await test('F2-9 结构守卫：账号锁定退避上限必须是 60s（不得退回 5min 永久锁死）', async () => {
  assert.ok(/const ACCOUNT_BACKOFF_MAX_MS = 60 \* 1000;/.test(syncSrc), '账号锁定退避上限必须是 60s（ACCOUNT_BACKOFF_MAX_MS）');
  assert.ok(/只有\*\*已存在\*\*的账号/.test(syncSrc), '源码必须写明账号桶只对已存在账号计数');
});

// =====================================================================
// F3（N-3）：数据面每账号请求上限 + 每日字节配额
// =====================================================================
/** @param {number} port @param {string} username */
async function registerAndPairChild(port, username) {
  const r = await post(port, '/api/register', { username, password: 'password123' });
  assert.equal(r.status, 200, `前置注册应成功（实际 ${r.status} ${r.text}）`);
  const p = await post(port, '/api/pair', { username, password: 'password123', deviceName: 'dev' });
  assert.equal(p.status, 200, `前置配对应成功（实际 ${p.status} ${p.text}）`);
  return p.json.token;
}

await test('F3-1 push 每账号每分钟请求上限：第 6 次 429 且说明可见', async () => {
  const s = await startSyncChild({
    MINGDAO_SYNC_REGISTRATION: 'open',
    SYNC_REQUESTS_PER_MIN: '5',
  });
  try {
    const token = await registerAndPairChild(s.port, 'pushlimit');
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const r = await postAuth(s.port, '/api/sessions/push', token, { name: `p${i}.jsonl`, content: 'x' });
      codes.push(r.status);
    }
    assert.deepEqual(codes, [200, 200, 200, 200, 200], `前 5 次应 200（实际 ${codes.join(',')}）`);
    const sixth = await postAuth(s.port, '/api/sessions/push', token, { name: 'p6.jsonl', content: 'x' });
    assert.equal(sixth.status, 429, `第 6 次必须 429（实际 ${sixth.status} ${sixth.text}）`);
    assert.equal(sixth.json?.code, 'ACCOUNT_RATE_LIMIT', '429 必须带可见错误码');
    assert.ok(/每分钟最多 5 次/.test(sixth.json?.error || ''), '429 文案必须说明上限值');
    assert.ok(sixth.json?.retryAfterMs > 0, '429 必须给出 retryAfterMs');
  } finally {
    await s.stop();
  }
});

await test('F3-2 pull 共用同一账号请求桶：超限后 pull 同样 429', async () => {
  const s = await startSyncChild({ MINGDAO_SYNC_REGISTRATION: 'open', SYNC_REQUESTS_PER_MIN: '5' });
  try {
    const token = await registerAndPairChild(s.port, 'pulllimit');
    for (let i = 0; i < 5; i++) {
      const r = await postAuth(s.port, '/api/sessions/push', token, { name: `q${i}.jsonl`, content: 'x' });
      assert.equal(r.status, 200, `前置 push ${i} 应 200（实际 ${r.status}）`);
    }
    const pull = await postAuth(s.port, '/api/sessions/pull', token, { name: 'q0.jsonl' });
    assert.equal(pull.status, 429, `push/pull 必须共用每账号请求桶（实际 ${pull.status} ${pull.text}）`);
    assert.equal(pull.json?.code, 'ACCOUNT_RATE_LIMIT', 'pull 429 同样要有可见错误码');
  } finally {
    await s.stop();
  }
});

await test('F3-3 每日字节配额：第二次 600KB push 429，usedBytes/limitBytes/resetAt 可见', async () => {
  const s = await startSyncChild({ MINGDAO_SYNC_REGISTRATION: 'open', SYNC_QUOTA_MB_PER_DAY: '1' });
  try {
    const token = await registerAndPairChild(s.port, 'quotauser');
    const big = 'y'.repeat(600 * 1024);
    const first = await postAuth(s.port, '/api/sessions/push', token, { name: 'big1.jsonl', content: big });
    assert.equal(first.status, 200, `第一次 600KB push 应成功（实际 ${first.status} ${first.text}）`);
    const second = await postAuth(s.port, '/api/sessions/push', token, { name: 'big2.jsonl', content: big });
    assert.equal(second.status, 429, `超出每日 1MB 配额必须 429（实际 ${second.status}）`);
    assert.equal(second.json?.code, 'DAILY_QUOTA_EXCEEDED', '429 必须带 DAILY_QUOTA_EXCEEDED');
    assert.ok(/配额/.test(second.json?.error || ''), '429 文案必须说明配额');
    assert.equal(second.json?.limitBytes, 1024 * 1024, `limitBytes 应为 1MB（实际 ${second.json?.limitBytes}）`);
    assert.ok(second.json?.usedBytes >= 600 * 1024, `usedBytes 应已计入前一次（实际 ${second.json?.usedBytes}）`);
    assert.ok(typeof second.json?.resetAt === 'string' && second.json.resetAt.includes('T'), '必须给出配额重置时间 resetAt');
  } finally {
    await s.stop();
  }
});

await test('F3-4 pull 的字节也计入每日配额：push 600KB 后 pull 600KB → 429', async () => {
  const s = await startSyncChild({ MINGDAO_SYNC_REGISTRATION: 'open', SYNC_QUOTA_MB_PER_DAY: '1' });
  try {
    const token = await registerAndPairChild(s.port, 'pullquota');
    const big = 'z'.repeat(600 * 1024);
    const push = await postAuth(s.port, '/api/sessions/push', token, { name: 'big.jsonl', content: big });
    assert.equal(push.status, 200, `前置 push 应 200（实际 ${push.status} ${push.text}）`);
    const pull = await postAuth(s.port, '/api/sessions/pull', token, { name: 'big.jsonl' });
    assert.equal(pull.status, 429, `pull 也必须计入每日字节配额（实际 ${pull.status} ${pull.text}）`);
    assert.equal(pull.json?.code, 'DAILY_QUOTA_EXCEEDED', 'pull 超配额必须带 DAILY_QUOTA_EXCEEDED');
    assert.ok(pull.json?.requestedBytes >= 600 * 1024, 'pull 429 必须给出本次请求字节数');
  } finally {
    await s.stop();
  }
});

await test('F3-5 默认值登记：请求 60 次/分钟、配额 512MB/日可被环境变量覆盖', async () => {
  assert.ok(/positiveNumberEnv\('SYNC_REQUESTS_PER_MIN', 60\)/.test(syncSrc), '每账号每分钟请求默认值必须是 60');
  assert.ok(/positiveNumberEnv\('SYNC_QUOTA_MB_PER_DAY', 512\)/.test(syncSrc), '每日字节配额默认值必须是 512MB');
  assert.ok(/if \(DAILY_QUOTA_BYTES <= 0\) return null;/.test(syncSrc), 'SYNC_QUOTA_MB_PER_DAY=0 必须显式表示关闭配额');
});

// =====================================================================
// F4（H-11）：无令牌 WebUI 不得把权限改成 auto
// =====================================================================
process.env.MINGDAO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-web-reg-hard-'));
const webHome = process.env.MINGDAO_HOME;
/** @param {string} permission */
function writeWebConfig(permission) {
  fs.writeFileSync(path.join(webHome, 'config.json'), JSON.stringify({ model: 'deepseek-chat', permission }));
}
const { runWebServer } = await import(pathToFileURL(path.join(srcDir, 'web', 'server.js')).href);

/**
 * @template T
 * @param {(ctx: { port: number }) => Promise<T>} fn
 * @param {{ authToken?: string }} [opts]
 */
async function withWeb(fn, opts = {}) {
  writeWebConfig('ask');
  const srv = await runWebServer({ host: '127.0.0.1', port: 0, authToken: opts.authToken });
  const port = srv.address().port;
  try {
    return await fn({ port });
  } finally {
    srv.closeAllConnections?.();
    await new Promise((resolve) => srv.close(() => resolve(undefined)));
  }
}
/** @param {number} port @param {string} pathname @param {any} body @param {string} [token] */
async function webPost(port, pathname, body, token) {
  /** @type {any} */
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-MingDao-Token'] = token;
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) });
  let json = null;
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, json };
}
/** @param {number} port @param {string} pathname @param {string} [token] */
async function webGet(port, pathname, token) {
  /** @type {any} */
  const headers = {};
  if (token) headers['X-MingDao-Token'] = token;
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
  let json = null;
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, json };
}
const webConfigOnDisk = () => JSON.parse(fs.readFileSync(path.join(webHome, 'config.json'), 'utf8'));

await test('F4-1 无令牌 WebUI：permission=auto 必须 403，配置不得落盘', async () => {
  await withWeb(async ({ port }) => {
    const r = await webPost(port, '/api/config', { permission: 'auto' });
    assert.equal(r.status, 403, `无令牌时 auto 必须被拒（实际 ${r.status} ${JSON.stringify(r.json)}）`);
    assert.equal(r.json?.code, 'PERMISSION_AUTO_REQUIRES_TOKEN', '拒绝必须带可见错误码');
    assert.ok(/访问令牌/.test(r.json?.error || ''), '错误信息必须说明需要访问令牌');
    assert.equal(webConfigOnDisk().permission, 'ask', '被拒绝的 auto 不得写入 config.json');
  });
});

await test('F4-2 无令牌 WebUI：ask / readonly 仍可切换', async () => {
  await withWeb(async ({ port }) => {
    const ask = await webPost(port, '/api/config', { permission: 'ask' });
    assert.equal(ask.status, 200, `ask 应允许（实际 ${ask.status}）`);
    const ro = await webPost(port, '/api/config', { permission: 'readonly' });
    assert.equal(ro.status, 200, `readonly 应允许（实际 ${ro.status}）`);
    assert.equal(webConfigOnDisk().permission, 'readonly', 'readonly 必须落盘');
  });
});

await test('F4-3 /api/state 让限制在界面上可见：permissionAutoAllowed=false + 原因', async () => {
  await withWeb(async ({ port }) => {
    const st = await webGet(port, '/api/state');
    assert.equal(st.status, 200, `state 应 200（实际 ${st.status}）`);
    assert.equal(st.json?.permissionAutoAllowed, false, '无令牌时 state.permissionAutoAllowed 必须是 false');
    assert.ok(/访问令牌/.test(st.json?.permissionNote || ''), 'state.permissionNote 必须说明原因');
    assert.ok(Array.isArray(st.json?.permissions) && st.json.permissions.includes('auto'), '权限枚举仍应完整（由 permissionAutoAllowed 表达限制）');
  });
});

await test('F4-4 已配置访问令牌：auto 不受限且 state 标记允许', async () => {
  await withWeb(
    async ({ port }) => {
      const r = await webPost(port, '/api/config', { permission: 'auto' }, 'test-token-123456');
      assert.equal(r.status, 200, `有令牌时 auto 应允许（实际 ${r.status} ${JSON.stringify(r.json)}）`);
      assert.equal(webConfigOnDisk().permission, 'auto', 'auto 必须落盘');
      const st = await webGet(port, '/api/state', 'test-token-123456');
      assert.equal(st.json?.permissionAutoAllowed, true, '有令牌时 state.permissionAutoAllowed 必须是 true');
      assert.equal(st.json?.permissionNote, null, '有令牌时不应显示限制说明');
    },
    { authToken: 'test-token-123456' }
  );
});

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
console.log(`\n同步注册/配额/权限加固：${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log('失败项：');
  for (const r of failed) console.log(` - ${r.name}: ${String(r.error?.message || r.error)}`);
  process.exit(1);
}
process.exit(0);
