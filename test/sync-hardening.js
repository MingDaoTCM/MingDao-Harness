// 同步服务加固回归（v0.6.29，第三方审计 H-02 / H-03 / M-01 / M-02 / M-14）。
//
//   node test/sync-hardening.js
//
// 这套件只覆盖 `src/sync-server.js` 的四个安全/一致性问题，刻意**不**塞进 smoke.js：
//   ① H-02 损坏状态：截断 JSON / 空文件 / 数组 / 权限错误 / 不存在，只有"不存在"可初始化；
//      其余写接口必须 5xx、原文件字节不变、有**不重名**备份（二次损坏不得覆盖第一份备份）。
//      另对 users/devices/meta/shares/accepted 各注入一次 schema 违例，写入必须被拒。
//   ② H-03 配对/改密 TOCTOU：用可控 scrypt 屏障精确复现"旧密码配对先验证、改密先完成、
//      配对后入锁"；配对必须 401/409、不得新增设备；并发改密只能一个成功。
//   ③ M-01 畸形 request-target：原始 socket 发 `GET http://[::1 HTTP/1.1`，必须快速 400/关闭，
//      随后 /healthz 仍 200，活动连接数不随重复请求增长。
//   ④ M-02 账号限流：多来源 IP 对同一账号共享账号桶（任一超限即拒），单 IP 来源桶仍生效，
//      不同账号互不影响，成功认证清零。
//   ⑤ M-14 安全默认：默认只监听 127.0.0.1、注册默认 closed（仅"未显式配置 + 监听回环"时
//      允许回环来源自助注册作为本机首启缓冲）；显式 closed 连回环也拒绝。
//
// 说明：本机 macOS 默认没有 127.0.0.0/8 别名（绑 127.0.0.2 会 EADDRNOTAVAIL），因此多来源 IP
// 通过 `SYNC_TRUST_PROXY=1` + `X-Forwarded-For` 模拟——这正是限流在生产可信反代下看到的身份来源。

process.env.SYNC_TRUST_PROXY = '1';

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 可控 scrypt 屏障（H-03） ----------
// sync-server 在模块顶层 `promisify(crypto.scrypt)`，所以必须在动态 import 之前替换。
// 只拦"指定密码"的第一次调用：配对请求在锁外读到用户后开始验证 → 被挂起；
// 此后的改密请求用同一旧密码验证，但闸门已放行，于是能先入锁完成。
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

const { runSyncServer } = await import(pathToFileURL(path.join(srcDir, 'sync-server.js')).href);

// ---------- 小工具 ----------
/**
 * @param {number} port
 * @param {string} method
 * @param {string} pathname
 * @param {{ body?: any, token?: string, xff?: string, timeoutMs?: number }} [opts]
 */
function request(port, method, pathname, opts = {}) {
  const { body, token, xff, timeoutMs = 4000 } = opts;
  const data = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    /** @type {any} */
    const headers = { Connection: 'close' };
    if (data !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    if (xff) headers['X-Forwarded-For'] = xff;
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

/** @param {number} port @param {string} pathname @param {any} body @param {string} [xff] */
const post = (port, pathname, body, xff) => request(port, 'POST', pathname, { body, xff });
/** @param {number} port @param {string} pathname @param {string} token @param {any} [body] */
const postAuth = (port, pathname, token, body = {}) => request(port, 'POST', pathname, { body, token });

/**
 * 原始 socket 请求（M-01）：返回首行与是否快速关闭。
 * @param {number} port
 * @param {string} payload
 * @param {number} [timeoutMs]
 */
function rawRequest(port, payload, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload));
    let text = '';
    let done = false;
    const finish = (/** @type {'closed'|'timeout'|'error'} */ how) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ how, elapsed: Date.now() - t0, firstLine: (text.split('\r\n')[0] || '').trim(), text });
    };
    socket.on('data', (d) => (text += d));
    socket.on('close', () => finish('closed'));
    socket.on('error', () => finish('error'));
    setTimeout(() => finish('timeout'), timeoutMs);
  });
}

/** @param {any} srv @returns {Promise<number>} */
const activeConnections = (srv) => new Promise((resolve) => srv.getConnections((/** @type {any} */ _e, /** @type {number} */ n) => resolve(n)));

/**
 * 起一个同步服务（顺序执行；sync-server 的数据目录是模块级全局，不能并发起两个）。
 * @template T
 * @param {(ctx: { dir: string, port: number, srv: any }) => Promise<T>} fn
 * @param {{ host?: string, dataDir?: string }} [opts]
 * @returns {Promise<T>}
 */
async function withServer(fn, opts = {}) {
  const dir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-sync-hard-'));
  const srv = runSyncServer({ port: 0, host: opts.host || '127.0.0.1', dataDir: dir });
  await new Promise((resolve, reject) => {
    srv.once('listening', resolve);
    srv.once('error', reject);
  });
  const port = srv.address().port;
  try {
    return await fn({ dir, port, srv });
  } finally {
    srv.closeAllConnections?.();
    await new Promise((resolve) => srv.close(() => resolve(undefined)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {string} name */
const fileOf = (dir, name) => path.join(dir, name);
/** @param {string} dir @param {string} base */
const backupsOf = (dir, base) => fs.readdirSync(dir).filter((f) => f.startsWith(base + '.corrupt-')).sort();
/** @param {string} p */
const readBuf = (p) => fs.readFileSync(p);
/** @param {string} p */
const readText = (p) => fs.readFileSync(p, 'utf8');
/** @param {string} p @param {string} s */
const writeText = (p, s) => fs.writeFileSync(p, s);

/** @param {string} username @param {string} password @param {string} [xff] */
async function registerVia(port, username, password, xff) {
  return post(port, '/api/register', { username, password }, xff);
}
/** @param {string} username @param {string} password @param {string} deviceName @param {string} [xff] */
async function pairVia(port, username, password, deviceName, xff) {
  return post(port, '/api/pair', { username, password, deviceName }, xff);
}

// 让两次"同秒损坏"尽量落在同一秒内：等到秒边界后立刻发两个本地请求。
async function atSecondStart() {
  await sleep(1000 - (Date.now() % 1000) + 5);
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

// =====================================================================
// ① H-02：损坏状态只允许"不存在"初始化
// =====================================================================
/**
 * 跑一种 users.json 损坏形态：写接口必须 5xx + 原字节不变 + 备份。
 * @param {string} label
 * @param {(p: string) => void} corrupt
 * @param {{ expectBackup?: boolean, unreadable?: boolean }} [opts]
 */
async function expectCorruptWriteRejected(label, corrupt, opts = {}) {
  await withServer(async ({ dir, port }) => {
    const usersPath = fileOf(dir, 'users.json');
    corrupt(usersPath);
    const before = opts.unreadable ? null : readBuf(usersPath);
    const res = await registerVia(port, 'newuser', 'password123', '127.0.0.61');
    assert.equal(res.status, 500, `${label}：写接口必须失败（实际 ${res.status} ${res.text}）`);
    assert.equal(res.json?.code, 'STATE_CORRUPT', `${label}：错误体必须明确标注 STATE_CORRUPT`);
    assert.equal(res.json?.file, 'users.json', `${label}：错误体应指出损坏文件`);
    if (opts.unreadable) {
      fs.chmodSync(usersPath, 0o600);
    }
    const after = readBuf(usersPath);
    if (before) assert.deepEqual(after, before, `${label}：原文件字节不得被改动`);
    const backups = backupsOf(dir, 'users.json');
    assert.ok(backups.length >= 1, `${label}：必须留下不重名备份（实际 0 份）`);
    fs.chmodSync(path.join(dir, backups[0]), 0o600);
    const backup = readBuf(path.join(dir, backups[0]));
    assert.deepEqual(backup, after, `${label}：备份必须与原件字节一致`);
  });
}

await test('H-02 截断 JSON：注册 500、原字节不变、有备份', () =>
  expectCorruptWriteRejected('截断 JSON', (p) => writeText(p, '{"alice":{"salt":"s","hash":"h"}'))
);
await test('H-02 空文件：注册 500、原字节不变、有备份', () => expectCorruptWriteRejected('空文件', (p) => writeText(p, '')));
await test('H-02 顶层数组：注册 500、原字节不变、有备份', () =>
  expectCorruptWriteRejected('顶层数组', (p) => writeText(p, '[{"alice":{"salt":"s","hash":"h"}}]'))
);
await test('H-02 权限错误（不可读）：注册 500、原字节不变、硬链接备份', async () => {
  let readableAfterChmod = true;
  try {
    await withServer(async ({ dir, port }) => {
      const usersPath = fileOf(dir, 'users.json');
      writeText(usersPath, '{"alice":{"salt":"s","hash":"h"}}');
      const before = readBuf(usersPath);
      fs.chmodSync(usersPath, 0o000);
      try {
        fs.readFileSync(usersPath);
      } catch {
        readableAfterChmod = false;
      }
      if (readableAfterChmod) {
        fs.chmodSync(usersPath, 0o600);
        return; // Windows / root：chmod 不生效，跳过（不伪造结论）
      }
      const res = await registerVia(port, 'newuser', 'password123', '127.0.0.61');
      assert.equal(res.status, 500, `权限错误：写接口必须失败（实际 ${res.status}）`);
      assert.equal(res.json?.code, 'STATE_CORRUPT');
      fs.chmodSync(usersPath, 0o600);
      assert.deepEqual(readBuf(usersPath), before, '权限错误：原文件字节不得被改动');
      const backups = backupsOf(dir, 'users.json');
      assert.ok(backups.length >= 1, '权限错误：也必须留下备份（硬链接，原件不可读时仍可备份）');
      fs.chmodSync(path.join(dir, backups[0]), 0o600);
      assert.deepEqual(readBuf(path.join(dir, backups[0])), before, '权限错误：备份字节必须与原件一致');
    });
  } finally {
    if (readableAfterChmod) console.log('   （平台不支持 000 权限：该用例记为跳过，不计失败）');
  }
});
await test('H-02 文件不存在：注册 200（唯一允许的初始化路径）', async () => {
  await withServer(async ({ dir, port }) => {
    assert.ok(!fs.existsSync(fileOf(dir, 'users.json')), '（前置）users.json 不存在');
    const res = await registerVia(port, 'firstuser', 'password123', '127.0.0.62');
    assert.equal(res.status, 200, res.text);
    const users = JSON.parse(readText(fileOf(dir, 'users.json')));
    assert.ok(users.firstuser, '首次注册应正常初始化 users.json');
    assert.equal(users.firstuser.credentialVersion, 0, '新用户 credentialVersion 从 0 开始');
    assert.equal(backupsOf(dir, 'users.json').length, 0, '正常初始化不应产生损坏备份');
  });
});
await test('H-02 users schema 违例（salt 非字符串）：写接口 500 + 备份', () =>
  expectCorruptWriteRejected('users schema', (p) => writeText(p, '{"alice":{"salt":123,"hash":"h"}}'))
);

// 读侧校验的独立证据：下面两条路径**不会写回** users/meta，若只靠 writeState 的二次校验，
// 读侧校验被绕过时它们会返回 401/200 而不是 500（正是变异 ③ 要抓的逃逸）。
await test('H-02 users schema 违例：配对必须 500（读侧校验，不得退化成 401）', async () => {
  await withServer(async ({ dir, port }) => {
    writeText(fileOf(dir, 'users.json'), '{"alice":{"salt":123,"hash":"h"}}');
    const res = await pairVia(port, 'alice', 'password123', 'd1', '127.0.0.71');
    assert.equal(res.status, 500, `users schema：配对必须 500（实际 ${res.status} ${res.text}）`);
    assert.equal(res.json?.code, 'STATE_CORRUPT');
  });
});

await test('H-02 meta schema 违例：会话列表必须 500（读侧校验，不得退化成 200）', async () => {
  await withServer(async ({ dir, port }) => {
    assert.equal((await registerVia(port, 'alice', 'password123', '127.0.0.72')).status, 200);
    const pair = await pairVia(port, 'alice', 'password123', 'd1', '127.0.0.72');
    assert.equal((await postAuth(port, '/api/sessions/push', pair.json.token, { name: 's.jsonl', content: '{"x":1}\n' })).status, 200);
    const metaPath = path.join(dir, 'data', 'alice', 'meta.json');
    writeText(metaPath, '{"s.jsonl":{"mtime":"x","size":1}}');
    const res = await postAuth(port, '/api/sessions/list', pair.json.token);
    assert.equal(res.status, 500, `meta schema：会话列表必须 500（实际 ${res.status} ${res.text}）`);
    assert.equal(res.json?.code, 'STATE_CORRUPT');
  });
});

await test('H-02 devices schema 违例：配对 500 + 备份、原文件不变', async () => {
  await withServer(async ({ dir, port }) => {
    assert.equal((await registerVia(port, 'alice', 'password123', '127.0.0.63')).status, 200);
    assert.equal((await pairVia(port, 'alice', 'password123', 'd1', '127.0.0.63')).status, 200);
    const devicesPath = fileOf(dir, 'devices.json');
    writeText(devicesPath, '{"alice":{"d1":{"tokenHash":42}}}');
    const before = readBuf(devicesPath);
    const res = await pairVia(port, 'alice', 'password123', 'd2', '127.0.0.63');
    assert.equal(res.status, 500, `devices schema：配对必须失败（实际 ${res.status}）`);
    assert.equal(res.json?.code, 'STATE_CORRUPT');
    assert.deepEqual(readBuf(devicesPath), before, 'devices schema：原文件字节不得被改动');
    assert.ok(backupsOf(dir, 'devices.json').length >= 1, 'devices schema：必须有备份');
  });
});

await test('H-02 meta schema 违例：推送 500 + 备份、原文件不变', async () => {
  await withServer(async ({ dir, port }) => {
    assert.equal((await registerVia(port, 'alice', 'password123', '127.0.0.64')).status, 200);
    const pair = await pairVia(port, 'alice', 'password123', 'd1', '127.0.0.64');
    const token = pair.json.token;
    assert.equal((await postAuth(port, '/api/sessions/push', token, { name: 's.jsonl', content: '{"x":1}\n' })).status, 200);
    const metaPath = path.join(dir, 'data', 'alice', 'meta.json');
    writeText(metaPath, '{"s.jsonl":{"mtime":"x","size":1}}');
    const before = readBuf(metaPath);
    const res = await postAuth(port, '/api/sessions/push', token, { name: 's.jsonl', content: '{"x":2}\n' });
    assert.equal(res.status, 500, `meta schema：推送必须失败（实际 ${res.status}）`);
    assert.equal(res.json?.code, 'STATE_CORRUPT');
    assert.deepEqual(readBuf(metaPath), before, 'meta schema：原文件字节不得被改动');
    assert.ok(fs.readdirSync(path.join(dir, 'data', 'alice')).some((f) => f.startsWith('meta.json.corrupt-')), 'meta schema：必须有备份');
  });
});

await test('H-02 shares schema 违例：创建分享 500 + 备份、原文件不变', async () => {
  await withServer(async ({ dir, port }) => {
    assert.equal((await registerVia(port, 'alice', 'password123', '127.0.0.65')).status, 200);
    const pair = await pairVia(port, 'alice', 'password123', 'd1', '127.0.0.65');
    const token = pair.json.token;
    assert.equal((await postAuth(port, '/api/sessions/push', token, { name: 's.jsonl', content: '{"x":1}\n' })).status, 200);
    assert.equal((await postAuth(port, '/api/share/create', token, { name: 's.jsonl' })).status, 200);
    const sharesPath = fileOf(dir, 'shares.json');
    writeText(sharesPath, '{"dead":{"owner":42,"name":"s.jsonl"}}');
    const before = readBuf(sharesPath);
    const res = await postAuth(port, '/api/share/create', token, { name: 's.jsonl' });
    assert.equal(res.status, 500, `shares schema：创建分享必须失败（实际 ${res.status}）`);
    assert.equal(res.json?.code, 'STATE_CORRUPT');
    assert.deepEqual(readBuf(sharesPath), before, 'shares schema：原文件字节不得被改动');
    assert.ok(backupsOf(dir, 'shares.json').length >= 1, 'shares schema：必须有备份');
  });
});

await test('H-02 accepted schema 违例：接受分享 500 + 备份、原文件不变', async () => {
  await withServer(async ({ dir, port }) => {
    assert.equal((await registerVia(port, 'alice', 'password123', '127.0.0.66')).status, 200);
    assert.equal((await registerVia(port, 'bob', 'password123', '127.0.0.66')).status, 200);
    const pa = await pairVia(port, 'alice', 'password123', 'a1', '127.0.0.66');
    const pb = await pairVia(port, 'bob', 'password123', 'b1', '127.0.0.66');
    assert.equal((await postAuth(port, '/api/sessions/push', pa.json.token, { name: 's.jsonl', content: '{"x":1}\n' })).status, 200);
    const share = await postAuth(port, '/api/share/create', pa.json.token, { name: 's.jsonl' });
    assert.equal(share.status, 200);
    assert.equal((await postAuth(port, '/api/share/accept', pb.json.token, { shareId: share.json.shareId })).status, 200);
    const acceptedPath = fileOf(dir, 'accepted.json');
    writeText(acceptedPath, '{"bob":{"deadbeef":{"owner":"alice","name":"s.jsonl"}}}');
    const before = readBuf(acceptedPath);
    const res = await postAuth(port, '/api/share/accept', pb.json.token, { shareId: share.json.shareId });
    assert.equal(res.status, 500, `accepted schema：接受分享必须失败（实际 ${res.status}）`);
    assert.equal(res.json?.code, 'STATE_CORRUPT');
    assert.deepEqual(readBuf(acceptedPath), before, 'accepted schema：原文件字节不得被改动');
    assert.ok(backupsOf(dir, 'accepted.json').length >= 1, 'accepted schema：必须有备份');
  });
});

await test('H-02 二次损坏：同一秒内两份备份都不被覆盖', async () => {
  await withServer(async ({ dir, port }) => {
    const usersPath = fileOf(dir, 'users.json');
    await atSecondStart();
    writeText(usersPath, '{"first":');
    assert.equal((await registerVia(port, 'u1', 'password123', '127.0.0.67')).status, 500);
    writeText(usersPath, '{"second":');
    assert.equal((await registerVia(port, 'u2', 'password123', '127.0.0.67')).status, 500);
    const backups = backupsOf(dir, 'users.json');
    assert.ok(backups.length >= 2, `两次不同损坏必须有两份备份（实际 ${backups.length} 份：${backups.join(', ')}）`);
    const contents = backups.map((b) => readText(path.join(dir, b)));
    assert.ok(contents.includes('{"first":'), '第一份备份的内容不得被第二份覆盖');
    assert.ok(contents.includes('{"second":'), '第二份损坏也必须留档');
  });
});

// =====================================================================
// ② H-03：配对 / 改密 TOCTOU
// =====================================================================
await test('H-03 旧密码配对先验证、改密先完成：配对 401/409、无新设备、旧 token 失效', async () => {
  await withServer(async ({ dir, port }) => {
    assert.equal((await registerVia(port, 'alice', 'race-old-pass', '127.0.0.68')).status, 200);
    const first = await pairVia(port, 'alice', 'race-old-pass', 'd1', '127.0.0.68');
    assert.equal(first.status, 200, first.text);
    const token1 = first.json.token;
    assert.ok(token1, '（前置）第一台设备应拿到 token');

    const gate = armScryptGate('race-old-pass');
    // 旧密码配对：读到 users 后开始 scrypt → 被闸门挂住（还没入写锁）
    const racePair = pairVia(port, 'alice', 'race-old-pass', 'd2', '127.0.0.68').catch((e) => ({ status: -1, text: String(e), json: null }));
    try {
      await gate.started;
      // 改密先完成：此时配对仍停在锁外验证
      const changed = await postAuth(port, '/api/password', token1, { oldPassword: 'race-old-pass', newPassword: 'race-new-pass' });
      assert.equal(changed.status, 200, `改密应成功：${changed.text}`);
    } finally {
      gate.release();
    }
    const race = await racePair;
    assert.ok([401, 409].includes(race.status), `竞态配对必须被拒（实际 ${race.status} ${race.text}）`);
    assert.ok(!race.json?.token, '竞态配对不得返回新 token');

    const users = JSON.parse(readText(fileOf(dir, 'users.json')));
    assert.equal(users.alice.credentialVersion, 1, '改密后 credentialVersion 必须 +1');
    const devices = JSON.parse(readText(fileOf(dir, 'devices.json')));
    assert.deepEqual(Object.keys(devices.alice || {}), [], '改密后不得留下任何设备（竞态配对也没能新增）');
    assert.equal((await postAuth(port, '/api/devices', token1)).status, 401, '改密后旧 token 必须 401');
    assert.equal((await pairVia(port, 'alice', 'race-old-pass', 'd3', '127.0.0.68')).status, 401, '旧密码不得再配对');
    assert.equal((await pairVia(port, 'alice', 'race-new-pass', 'd3', '127.0.0.68')).status, 200, '新密码正常配对不应受影响');
  });
});

await test('H-03 并发改密：只一个成功，另一个 409，且只有一个新密码可用', async () => {
  await withServer(async ({ dir, port }) => {
    assert.equal((await registerVia(port, 'bob', 'oldpass123', '127.0.0.69')).status, 200);
    const pair = await pairVia(port, 'bob', 'oldpass123', 'd1', '127.0.0.69');
    const token = pair.json.token;
    const [a, b] = await Promise.all([
      postAuth(port, '/api/password', token, { oldPassword: 'oldpass123', newPassword: 'newpassAAA' }),
      postAuth(port, '/api/password', token, { oldPassword: 'oldpass123', newPassword: 'newpassBBB' }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], `并发改密必须一个 200、一个 409（实际 ${statuses.join('/')}）`);
    const users = JSON.parse(readText(fileOf(dir, 'users.json')));
    assert.equal(users.bob.credentialVersion, 1, '只能成功一次：版本只能 +1');
    const winnerA = (await pairVia(port, 'bob', 'newpassAAA', 'd2', '127.0.0.69')).status;
    const winnerB = (await pairVia(port, 'bob', 'newpassBBB', 'd3', '127.0.0.69')).status;
    assert.deepEqual([winnerA, winnerB].sort(), [200, 401], `只有一个新密码可用（实际 ${winnerA}/${winnerB}）`);
  });
});

await test('H-03 旧记录缺 credentialVersion 视为 0：改密成功并写入 1', async () => {
  await withServer(async ({ dir, port }) => {
    assert.equal((await registerVia(port, 'carol', 'legacypass1', '127.0.0.70')).status, 200);
    const pair = await pairVia(port, 'carol', 'legacypass1', 'd1', '127.0.0.70');
    const usersPath = fileOf(dir, 'users.json');
    const users = JSON.parse(readText(usersPath));
    delete users.carol.credentialVersion; // 模拟 v0.6.28 之前的记录
    writeText(usersPath, JSON.stringify(users, null, 2) + '\n');
    const res = await postAuth(port, '/api/password', pair.json.token, { oldPassword: 'legacypass1', newPassword: 'legacypass2' });
    assert.equal(res.status, 200, res.text);
    const after = JSON.parse(readText(usersPath));
    assert.equal(after.carol.credentialVersion, 1, '缺失版本按 0 处理，成功后写 1');
  });
});

// =====================================================================
// ③ M-01：畸形 request-target
// =====================================================================
await test('M-01 畸形 request-target：快速 400/关闭，不悬挂', async () => {
  await withServer(async ({ port }) => {
    // Node 的 HTTP parser 接受这个 absolute-form，而 `new URL` 会抛（H-01/H-02 审计同款探针）
    const payload = 'GET http://[::1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n';
    for (let i = 0; i < 6; i++) {
      const r = await rawRequest(port, payload, 1500);
      assert.notEqual(r.how, 'timeout', `第 ${i + 1} 次畸形请求不得悬挂（旧实现等到客户端超时）`);
      assert.ok(r.elapsed < 1000, `第 ${i + 1} 次畸形请求应快速响应（实际 ${r.elapsed}ms）`);
      assert.ok(/^HTTP\/1\.1 400/.test(r.firstLine), `第 ${i + 1} 次必须回 400（实际首行 ${JSON.stringify(r.firstLine)}）`);
    }
    const health = await request(port, 'GET', '/healthz');
    assert.equal(health.status, 200, '畸形请求之后 /healthz 必须仍 200');
    assert.equal(health.json.service, 'mingdao-sync');
  });
});

await test('M-01 20 次畸形请求后活动连接不增长', async () => {
  await withServer(async ({ port, srv }) => {
    const payload = 'GET http://[::1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n';
    const before = await activeConnections(srv);
    for (let i = 0; i < 20; i++) {
      const r = await rawRequest(port, payload, 1500);
      assert.notEqual(r.how, 'timeout', `第 ${i + 1} 次超时`);
      assert.ok(/^HTTP\/1\.1 400/.test(r.firstLine), `第 ${i + 1} 次不是 400：${r.firstLine}`);
    }
    await sleep(100);
    const after = await activeConnections(srv);
    assert.ok(after <= before + 1, `活动连接不得随畸形请求增长（before=${before}, after=${after}）`);
  });
});

// =====================================================================
// ④ M-02：账号限流跨 IP
// =====================================================================
await test('M-02 多 IP 同账号共享账号桶：第 6 次跨 IP 即 429', async () => {
  await withServer(async ({ port }) => {
    assert.equal((await registerVia(port, 'victim', 'password123', '127.0.0.71')).status, 200);
    assert.equal((await registerVia(port, 'bob', 'password123', '127.0.0.71')).status, 200);
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await pairVia(port, 'victim', 'wrongpass', 'x', '203.0.113.21')).status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401], `前 5 次应为 401（实际 ${statuses.join(',')}）`);
    const cross = await pairVia(port, 'victim', 'wrongpass', 'x', '203.0.113.22');
    assert.equal(cross.status, 429, `换一个来源 IP 后第 6 次必须 429（旧实现是 401，可无限换 IP 爆破）`);
    assert.ok(cross.json?.retryAfterMs > 0, '429 应给出剩余退避时间');
    const correctWhileLocked = await pairVia(port, 'victim', 'password123', 'x', '203.0.113.23');
    assert.equal(correctWhileLocked.status, 429, '账号桶锁定期内即使密码正确也应拒绝');
    const other = await pairVia(port, 'bob', 'wrongpass', 'x', '203.0.113.23');
    assert.equal(other.status, 401, '不同账号的失败互不影响（不得被 victim 的锁连坐）');
  });
});

await test('M-02 单 IP 来源桶仍生效：同一 IP 第 11 次 429', async () => {
  await withServer(async ({ port }) => {
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      // 每次不同账号 → 不会触发账号桶，只测来源桶
      statuses.push((await pairVia(port, `u${i}`, 'wrongpass', 'x', '203.0.113.30')).status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(404), `前 10 次应是"用户不存在"404（实际 ${statuses.slice(0, 10).join(',')}）`);
    assert.equal(statuses[10], 429, `同一来源第 11 次必须 429（实际 ${statuses[10]}）`);
  });
});

await test('M-02 不同账号互不影响 + 成功认证清零账号桶', async () => {
  await withServer(async ({ port }) => {
    assert.equal((await registerVia(port, 'dave', 'password123', '127.0.0.72')).status, 200);
    assert.equal((await registerVia(port, 'erin', 'password123', '127.0.0.72')).status, 200);
    // dave 先失败 4 次（未到阈值）
    for (let i = 0; i < 4; i++) {
      assert.equal((await pairVia(port, 'dave', 'wrongpass', 'x', '203.0.113.40')).status, 401);
    }
    // erin 完全不受影响
    assert.equal((await pairVia(port, 'erin', 'wrongpass', 'x', '203.0.113.41')).status, 401);
    // dave 成功一次 → 清零
    assert.equal((await pairVia(port, 'dave', 'password123', 'd1', '203.0.113.42')).status, 200);
    // 再失败 4 次仍不到阈值（若未清零，累计 8 次会 429）
    for (let i = 0; i < 4; i++) {
      assert.equal((await pairVia(port, 'dave', 'wrongpass', 'x', '203.0.113.43')).status, 401, '成功认证后账号桶必须清零');
    }
  });
});

// =====================================================================
// ⑤ M-14：安全默认
// =====================================================================
/**
 * 直接跑 `node src/sync-server.js`，从启动日志里拿真实端口。
 * @param {Record<string,string>} extraEnv
 */
async function startServerChild(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-sync-child-'));
  const child = spawn(process.execPath, [path.join(srcDir, 'sync-server.js')], {
    env: { ...process.env, SYNC_PORT: '0', SYNC_DATA_DIR: dir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
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
    throw new Error(`子进程未在 5s 内就绪：${out}`);
  }
  return { child, dir, port, out: () => out, stop, host: (out.match(/已启动 http\S*:\/\/([^:]+):/) || [])[1] };
}

await test('M-14 默认监听 127.0.0.1 + 注册 closed（回环首启可自助注册）', async () => {
  const child = await startServerChild({});
  try {
    assert.equal(child.host, '127.0.0.1', `默认监听地址必须是 127.0.0.1（实际 ${child.host}）`);
    assert.ok(/注册：closed/.test(child.out()), '启动日志必须明确写出注册默认 closed');
    assert.ok(/本机回环/.test(child.out()), '启动日志必须说明回环首启例外');
    const res = await post(child.port, '/api/register', { username: 'localboot', password: 'password123' }, '127.0.0.51');
    assert.equal(res.status, 200, `默认本机首启应可注册（实际 ${res.status} ${res.text}）`);
  } finally {
    await child.stop();
  }
});

await test('M-14 绑定非回环地址（0.0.0.0）时默认拒绝自助注册', async () => {
  await withServer(
    async ({ port }) => {
      const res = await registerVia(port, 'remoteuser', 'password123', '127.0.0.52');
      assert.equal(res.status, 403, `非回环绑定默认必须拒绝注册（实际 ${res.status} ${res.text}）`);
      assert.ok(/注册已关闭/.test(res.json?.error || ''), '错误信息应说明注册已关闭');
    },
    { host: '0.0.0.0' }
  );
});

await test('M-14 显式 MINGDAO_SYNC_REGISTRATION=closed：回环也拒绝', async () => {
  const child = await startServerChild({ MINGDAO_SYNC_REGISTRATION: 'closed' });
  try {
    const res = await post(child.port, '/api/register', { username: 'loopuser', password: 'password123' }, '127.0.0.53');
    assert.equal(res.status, 403, `显式 closed 必须连回环也拒绝（实际 ${res.status}）`);
  } finally {
    await child.stop();
  }
});

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
console.log(`\n同步加固：${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log('失败项：');
  for (const r of failed) console.log(` - ${r.name}: ${String(r.error?.message || r.error)}`);
  process.exit(1);
}
