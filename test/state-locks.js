// 持久状态「锁 + 原子写」回归套件（v0.7.0 §1.3，6 类无锁/非原子写入）。
//
// 这六处缺陷的共同形态：单进程顺序调用永远看不出问题，只有**真并发 / 写中崩溃 / 权限失败**才暴露；
// 一旦暴露就是用户能直接感知的数据丢失——「我明明填了 Key 却变回去了」「学到的预算莫名丢失」
// 「模型名自己退回旧版本」。所以本套件的并发场景一律用**真子进程 + READY/GO 屏障**，
// 不用同进程顺序调用假装并发；崩溃场景在子进程里真的 `SIGKILL` 于写中。
//
// ① config：16 路真子进程 load→改一个键→saveConfig，终态 16 个键必须都在（旧实现必丢）；
// ② credentials：并发 setStoredKey 两个 provider，两把 Key 都必须在；
// ③ model-cache：写一半被 kill -9 后，目标文件必须仍可解析（或不存在），绝不半截；
// ④ endpoint-limits：两个进程并发学习不同 baseUrl，所有学习值都必须在（按端点合并，不整表覆盖）；
// ⑤ ledger：并发 append 100 条 → 恰好 100 行且每行可解析；外部持锁时写不进去；
// ⑥ egress：并发 50 条 → 恰好 50 行；外部持锁时不写入；
// ⑦ 六条写路径注入 EACCES → 都必须有可见 warn、都只返回失败而不崩。
//
// 运行：node test/state-locks.js（不依赖网络）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');

const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-state-locks-'));
process.env.MINGDAO_HOME = baseHome;
// 锁等待上限调小：本套件会故意制造「外部持锁」场景，等到默认 5s 只会拖慢失败反馈。
// 仍远大于并发写本身的临界区（单次写实测 < 5ms）。
process.env.MINGDAO_LOCK_TIMEOUT_MS = '3000';
process.env.MINGDAO_LOCK_STALE_MS = '2000';

const configUrl = pathToFileURL(path.join(srcDir, 'config.js')).href;
const credentialsUrl = pathToFileURL(path.join(srcDir, 'credentials.js')).href;
const providersUrl = pathToFileURL(path.join(srcDir, 'providers', 'index.js')).href;
const ledgerUrl = pathToFileURL(path.join(srcDir, 'ledger.js')).href;
const netGuardUrl = pathToFileURL(path.join(srcDir, 'net-guard.js')).href;

const { configPath, loadConfig, saveConfig, readModelCache, writeModelCache, updateModelCacheSync } = await import(configUrl);
const { credentialsPath, readCredentialsStrict, setStoredKey } = await import(credentialsUrl);
const { readEndpointLimits, endpointLimitsFile } = await import(providersUrl);
const { createLedger, ledgerDir } = await import(ledgerUrl);
const { recordEgress, egressLogFile } = await import(netGuardUrl);

let passed = 0;
const ok = (/** @type {string} */ name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

/** 每个场景用独立 home，避免前一场景的残留状态影响后一场景。 */
function freshHome(/** @type {string} */ name) {
  const dir = path.join(baseHome, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.env.MINGDAO_HOME = dir;
  return dir;
}

/** 行数（只数非空行）。 */
function lineCount(/** @type {string} */ file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * 子进程封装：READY 屏障 → 父进程发令（GO）→ 所有子进程同时开跑。
 * 不靠进程启动先后碰运气，否则「真并发」会退化成顺序调用。
 */
function startChild(/** @type {string} */ body, /** @type {Record<string, string>} */ extraEnv = {}) {
  const p = spawn(process.execPath, ['--input-type=module', '-e', body], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
  p.stdin.on('error', () => {});
  p.stdout.setEncoding('utf8');
  p.stderr.setEncoding('utf8');
  let out = '';
  let err = '';
  /** @type {() => void} */
  let readyResolve = () => {};
  /** @type {(e: Error) => void} */
  let readyReject = () => {};
  const ready = new Promise((resolve, reject) => {
    readyResolve = /** @type {any} */ (resolve);
    readyReject = reject;
  });
  p.stdout.on('data', (/** @type {string} */ c) => {
    out += c;
    if (out.includes('READY\n')) readyResolve();
  });
  p.stderr.on('data', (/** @type {string} */ c) => (err += c));
  const done = new Promise((resolve) => p.on('close', (code, signal) => resolve({ code, signal, out, err })));
  const timer = setTimeout(() => readyReject(new Error(`子进程 READY 超时\n${err}`)), 20000);
  timer.unref();
  return {
    p,
    ready: ready.then(() => clearTimeout(timer)),
    done,
    go() {
      try {
        p.stdin.write('GO\n');
        p.stdin.end();
      } catch {}
    },
    out: () => out,
    err: () => err,
  };
}

/** 无屏障的一次性子进程（崩溃注入 / 失败告警注入）。 */
function runChild(/** @type {string} */ body, /** @type {Record<string, string>} */ extraEnv = {}) {
  const p = spawn(process.execPath, ['--input-type=module', '-e', body], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
  p.stdout.setEncoding('utf8');
  p.stderr.setEncoding('utf8');
  let out = '';
  let err = '';
  p.stdout.on('data', (/** @type {string} */ c) => (out += c));
  p.stderr.on('data', (/** @type {string} */ c) => (err += c));
  const done = new Promise((resolve) => p.on('close', (code, signal) => resolve({ code, signal, out, err })));
  return done;
}

/** 在 deadline 内等 done（子进程卡住比失败更贵）。 */
function withDeadline(/** @type {Promise<any>} */ pr, /** @type {string} */ what, ms = 60000) {
  return Promise.race([
    pr,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} 超时（${ms}ms）`)), ms).unref()),
  ]);
}

/** 读 JSON 文件；读不出来返回 null（断言里自行区分「不存在」与「半截」）。 */
function readJsonOrNull(/** @type {string} */ file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ===========================================================================
// ① config：16 路真子进程并发 saveConfig（各写不同键）→ 所有键都在
// ===========================================================================
{
  const home = freshHome('config');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ provider: 'deepseek', probe: 'keep' }, null, 2) + '\n');
  const N = 16;
  const kids = [];
  for (let i = 0; i < N; i += 1) {
    const body = `
const fs = (await import('node:fs')).default;
const { loadConfig, saveConfig, configPath } = await import(${JSON.stringify(configUrl)});
const key = process.env.MDH_KEY;
const value = process.env.MDH_VALUE;
// 在「读配置」上注入 40ms 延迟：所有 16 路都会在同一个窗口里读到同一份旧快照。
// 有锁 → 写操作被串行化，后到者会重读；无锁/锁内不重读 → 后写者用旧快照覆盖前者（旧实现的必丢现场）。
const realRead = fs.readFileSync.bind(fs);
fs.readFileSync = (p, ...args) => {
  const r = realRead(p, ...args);
  if (String(p) === configPath()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  return r;
};
process.stdout.write('READY\\n');
await new Promise((resolve) => process.stdin.once('data', resolve));
const cfg = loadConfig() || {};
cfg[key] = value;
const r = saveConfig(cfg);
process.stdout.write('RESULT ' + JSON.stringify(r) + '\\n');
`;
    kids.push(startChild(body, { MDH_KEY: `concurrent_key_${i}`, MDH_VALUE: `value_${i}` }));
  }
  await Promise.all(kids.map((k) => withDeadline(k.ready, 'config READY')));
  for (const k of kids) k.go();
  const results = await Promise.all(kids.map((k) => withDeadline(k.done, 'config 子进程')));
  for (const [i, r] of results.entries()) {
    assert.equal(r.code, 0, `config 子进程 ${i} 必须正常退出：${r.err || r.out}`);
    assert.match(r.out, /RESULT \{"ok":true/, `config 子进程 ${i} 的 saveConfig 必须成功：${r.out}${r.err}`);
  }
  const disk = readJsonOrNull(path.join(home, 'config.json'));
  assert.ok(disk && typeof disk === 'object', 'config.json 必须是可解析的 JSON 对象');
  const missing = [];
  for (let i = 0; i < N; i += 1) {
    if (disk[`concurrent_key_${i}`] !== `value_${i}`) missing.push(i);
  }
  assert.deepEqual(
    missing,
    [],
    `E1：16 路并发 saveConfig 各写不同键，终态必须全部保留（锁内重读合并），实际丢了 ${missing.length} 个：${missing.join(',')}`
  );
  assert.equal(disk.provider, 'deepseek', 'E1：并发写不得把并发方没碰过的既有字段（provider）覆盖掉');
  assert.equal(disk.probe, 'keep', 'E1：并发写不得把并发方没碰过的既有字段（probe）覆盖掉');
  ok('config：16 路并发 saveConfig 全保留（锁内重读合并）');
}

// ===========================================================================
// ② credentials：并发 setKey 两个 provider → 两把都在
// ===========================================================================
{
  const home = freshHome('credentials');
  fs.writeFileSync(path.join(home, 'credentials.json'), '{}\n', { mode: 0o600 });
  const providersToSet = ['alpha', 'beta'];
  const kids = providersToSet.map((name) => {
    const body = `
const fs = (await import('node:fs')).default;
const { setStoredKey, credentialsPath } = await import(${JSON.stringify(credentialsUrl)});
// 与 ① 同一手法：拉宽「读 → 写」的窗口，让无锁的读-改-写必然互相覆盖。
const realRead = fs.readFileSync.bind(fs);
fs.readFileSync = (p, ...args) => {
  const r = realRead(p, ...args);
  if (String(p) === credentialsPath()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  return r;
};
process.stdout.write('READY\\n');
await new Promise((resolve) => process.stdin.once('data', resolve));
const r = setStoredKey(process.env.MDH_PROVIDER, process.env.MDH_KEY);
process.stdout.write('RESULT ' + JSON.stringify(r) + '\\n');
`;
    return startChild(body, { MDH_PROVIDER: name, MDH_KEY: `sk-${name}-0123456789` });
  });
  await Promise.all(kids.map((k) => withDeadline(k.ready, 'credentials READY')));
  for (const k of kids) k.go();
  const results = await Promise.all(kids.map((k) => withDeadline(k.done, 'credentials 子进程')));
  for (const [i, r] of results.entries()) {
    assert.equal(r.code, 0, `credentials 子进程 ${i} 必须正常退出：${r.err || r.out}`);
    assert.match(r.out, /RESULT \{"ok":true/, `credentials 子进程 ${i} 的 setStoredKey 必须成功：${r.out}${r.err}`);
  }
  const creds = readCredentialsStrict();
  assert.equal(creds.ok, true, `凭证库必须仍可解析：${creds.error || ''}`);
  assert.equal(creds.data.alpha, 'sk-alpha-0123456789', 'E2：并发 setKey 两个 provider 后两把 Key 都必须在（锁内重读）——alpha 丢了');
  assert.equal(creds.data.beta, 'sk-beta-0123456789', 'E2：并发 setKey 两个 provider 后两把 Key 都必须在（锁内重读）——beta 丢了');
  ok('credentials：并发 setKey 两个 provider 都保留');
}

// ===========================================================================
// ②b credentials：**损坏时必须拒绝写**（否则会静默清空其余凭据）
// ===========================================================================
// 缺陷形态（batch14 ⑦ 变异）：把 `readCredentialsStrict()` 换成宽松读，损坏时 return {}
// → `setStoredKey` 以为库是空的，写回时把用户其余 Key 全部清掉。旧断言只覆盖"并发不丢"，
// 没覆盖"损坏时停止写入"，因此该变异在 v0.7.0 全量里**逃逸**（实测）。
{
  const home = freshHome('credentials-corrupt');
  const file = path.join(home, 'credentials.json');
  const corrupt = '{"alpha": "sk-alpha-secret"'; // 截断的 JSON：解析必失败
  fs.writeFileSync(file, corrupt, { mode: 0o600 });
  const before = fs.readFileSync(file);
  const r = setStoredKey('beta', 'sk-beta-should-not-land');
  assert.equal(r.ok, false, `损坏的凭证库必须拒绝写入（必须拒绝写）：实际 ${JSON.stringify(r)}`);
  assert.match(String(r.error || ''), /已拒绝写/, `拒绝的原因必须说清"以免清空其余凭据"：${r.error}`);
  const after = fs.readFileSync(file);
  assert.deepEqual(after, before, '损坏时**原文件字节必须保持不变**（连备份/覆盖都不许做）');
  const strict = readCredentialsStrict();
  assert.equal(strict.ok, false, '损坏的凭证库严格读必须判失败（不能当空库）');
  ok('credentials：损坏时拒绝写入 + 原文件字节不变（不清空其余凭据）');
}

// ===========================================================================
// ③ model-cache：写中 kill -9 → 目标文件仍可解析（或不存在），绝不半截
// ===========================================================================
{
  freshHome('model-cache');
  const target = path.join(process.env.MINGDAO_HOME || '', 'model-cache.json');
  const body = `
const fs = (await import('node:fs')).default;
const { writeModelCache } = await import(${JSON.stringify(configUrl)});
// 先写一版完整内容（这就是崩溃后必须能回退到的「上一个完整版本」）。
const first = writeModelCache({ marker: 'v1', deepseek: { models: ['deepseek-v4-flash'], fetchedAt: 1 } });
if (!first.ok) { process.stderr.write('first write failed: ' + first.error + '\\n'); process.exit(3); }
// 模拟「写第二版写到一半被 kill -9」：截断式直写会把目标文件写坏；原子写只会留下半截 tmp。
const realWrite = fs.writeFileSync.bind(fs);
fs.writeFileSync = (p, data, ...args) => {
  if (String(p).includes('model-cache')) {
    realWrite(p, String(data).slice(0, Math.max(1, Math.floor(String(data).length / 2))), ...args);
    process.kill(process.pid, 'SIGKILL');
  }
  return realWrite(p, data, ...args);
};
writeModelCache({ marker: 'v2', deepseek: { models: ['deepseek-v9-experimental'], fetchedAt: 2 } });
process.stdout.write('SHOULD-NOT-REACH\\n');
`;
  const r = await withDeadline(runChild(body), 'model-cache 崩溃子进程');
  // Windows 没有 POSIX 信号：进程对自己发 SIGKILL 会被 TerminateProcess 终结，Node 侧看到的是
  // **code=1 / signal=null**（Linux/macOS 才是 signal=SIGKILL）。v0.6.32 首次推送时 windows 腿的
  // 变异验证因此把 batch69 ④–⑩ 全判成"逃逸"——实际是这条断言在 Windows 上先红，后面的用例根本没跑到。
  // 判据分平台，但两边都要求"确实死在写中"：非 0 退出、没执行到末尾的 SHOULD-NOT-REACH、
  // 且 stderr 里没有第一版写失败的记录（否则说明子进程是写失败退出的，不是被强杀）。
  const killedMidWrite =
    process.platform === 'win32'
      ? r.code !== 0 && r.signal === null && !/SHOULD-NOT-REACH/.test(r.out) && !/first write failed/.test(r.err)
      : r.signal === 'SIGKILL';
  assert.ok(killedMidWrite, `model-cache 子进程必须真的被强杀于写中（实际 code=${r.code} signal=${r.signal}）：${r.stderr}`);
  assert.ok(fs.existsSync(target), 'E3：写中 kill -9 后 model-cache.json 必须仍存在且可解析（或不存在）——这里连文件都没了');
  const disk = readJsonOrNull(target);
  assert.ok(
    disk && typeof disk === 'object',
    `E3：写中 kill -9 后 model-cache.json 必须仍可解析（原子替换，绝不半截）——实际内容：${String(fs.readFileSync(target, 'utf8')).slice(0, 120)}`
  );
  assert.equal(disk.marker, 'v1', 'E3：崩溃后必须仍是上一个完整版本（v1），不能是新版本半截');
  const cache = readModelCache();
  assert.equal(cache.marker, 'v1', 'E3：readModelCache() 单一入口也必须读到完整版本');
  ok('model-cache：写中 kill -9 后文件仍可解析（旧版本完整）');
}

// ===========================================================================
// ④ endpoint-limits：两个进程并发学习不同 baseUrl → 所有学习值都在
// ===========================================================================
{
  const home = freshHome('endpoint-limits');
  fs.writeFileSync(path.join(home, 'endpoint-limits.json'), JSON.stringify({ version: 1, endpoints: {} }, null, 2) + '\n');
  const groups = [
    ['http://127.0.0.1:6101/v1', 'http://127.0.0.1:6102/v1', 'http://127.0.0.1:6103/v1', 'http://127.0.0.1:6104/v1', 'http://127.0.0.1:6105/v1'],
    ['http://127.0.0.1:6201/v1', 'http://127.0.0.1:6202/v1', 'http://127.0.0.1:6203/v1', 'http://127.0.0.1:6204/v1', 'http://127.0.0.1:6205/v1'],
  ];
  const kids = groups.map((urls) => {
    const body = `
const fs = (await import('node:fs')).default;
const { learnEndpointMemoryFailure, endpointLimitsFile } = await import(${JSON.stringify(providersUrl)});
// 拉宽「读整表 → 写整表」窗口：无锁实现必然用同一份旧表互相覆盖（v0.6.26 的学习值就这么丢的）。
const realRead = fs.readFileSync.bind(fs);
fs.readFileSync = (p, ...args) => {
  const r = realRead(p, ...args);
  if (String(p) === endpointLimitsFile()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  return r;
};
process.stdout.write('READY\\n');
await new Promise((resolve) => process.stdin.once('data', resolve));
const urls = JSON.parse(process.env.MDH_URLS || '[]');
for (const u of urls) {
  const r = learnEndpointMemoryFailure(u, { budget: 4096, attempts: 2 });
  if (!r.ok) { process.stderr.write('learn failed: ' + r.error + '\\n'); process.exit(4); }
}
process.stdout.write('DONE\\n');
`;
    return startChild(body, { MDH_URLS: JSON.stringify(urls) });
  });
  await Promise.all(kids.map((k) => withDeadline(k.ready, 'endpoint READY')));
  for (const k of kids) k.go();
  const results = await Promise.all(kids.map((k) => withDeadline(k.done, 'endpoint 子进程')));
  for (const [i, r] of results.entries()) {
    assert.equal(r.code, 0, `endpoint 子进程 ${i} 必须正常退出：${r.err || r.out}`);
    assert.match(r.out, /DONE/, `endpoint 子进程 ${i} 必须完成全部学习：${r.out}${r.err}`);
  }
  const table = readEndpointLimits();
  assert.equal(table.ok, true, `endpoint-limits.json 必须仍可解析：${table.error || ''}`);
  const missing = [];
  for (const urls of groups) {
    for (const u of urls) {
      const key = u.replace(/\/+$/, '');
      if (!table.endpoints[key]) missing.push(key);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `E4：并发学习不同 baseUrl 后每条学习值都必须在（锁内重读合并，不整表覆盖），实际丢了 ${missing.length} 条：${missing.join(',')}`
  );
  ok('endpoint-limits：并发学习不同 baseUrl 全保留（按端点合并）');
}

// ===========================================================================
// ⑤ ledger：并发 append 100 条 → 100 行且每行可解析；外部持锁时写不进去
// ===========================================================================
{
  freshHome('ledger');
  const runId = 'state69-abcdef';
  const kids = [];
  const WORKERS = 10;
  const PER_WORKER = 10;
  for (let w = 0; w < WORKERS; w += 1) {
    const body = `
const { createLedger } = await import(${JSON.stringify(ledgerUrl)});
const runId = process.env.MDH_RUN_ID;
const n = Number(process.env.MDH_N);
process.stdout.write('READY\\n');
await new Promise((resolve) => process.stdin.once('data', resolve));
const ledger = createLedger(runId);
for (let i = 0; i < n; i += 1) {
  const line = ledger.cost({
    model: 'deepseek-v4-flash',
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    pricing: null,
    yuan: 0,
    priced: false,
  });
  if (!line) { process.stderr.write('ledger write failed: ' + ledger.lastError + '\\n'); process.exit(5); }
}
process.stdout.write('DONE ' + ledger.seq + '\\n');
`;
    kids.push(startChild(body, { MDH_RUN_ID: runId, MDH_N: String(PER_WORKER) }));
  }
  await Promise.all(kids.map((k) => withDeadline(k.ready, 'ledger READY')));
  for (const k of kids) k.go();
  const results = await Promise.all(kids.map((k) => withDeadline(k.done, 'ledger 子进程')));
  for (const [i, r] of results.entries()) {
    assert.equal(r.code, 0, `ledger 子进程 ${i} 必须正常退出：${r.err || r.out}`);
    assert.match(r.out, /DONE 10/, `ledger 子进程 ${i} 必须写满 10 条：${r.out}${r.err}`);
  }
  const file = path.join(ledgerDir(), `${runId}.jsonl`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(
    lines.length,
    WORKERS * PER_WORKER,
    `E5a：并发 append ${WORKERS * PER_WORKER} 条后必须恰好 ${WORKERS * PER_WORKER} 行且每行可解析，实际 ${lines.length} 行`
  );
  let bad = 0;
  for (const [i, line] of lines.entries()) {
    try {
      const ev = JSON.parse(line);
      if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string' || typeof ev.prev !== 'string') bad += 1;
    } catch {
      bad += 1;
      void i;
    }
  }
  assert.equal(bad, 0, `E5a：并发 append ${WORKERS * PER_WORKER} 条后必须恰好 ${WORKERS * PER_WORKER} 行且每行可解析，实际有 ${bad} 行不可解析`);
  ok(`ledger：并发 append ${WORKERS * PER_WORKER} 条 → 行数正确且逐行可解析`);

  // 锁语义：外部持锁期间必须写不进去。若有人把追加退回无锁，这条会立刻红。
  const probe = `
const fs = (await import('node:fs')).default;
const path = (await import('node:path')).default;
const { createLedger, ledgerDir } = await import(${JSON.stringify(ledgerUrl)});
const { recordEgress, egressLogFile } = await import(${JSON.stringify(netGuardUrl)});
const runId = 'lockprobe-abc123';
const warns = [];
const origWarn = console.warn;
console.warn = (...a) => warns.push(a.join(' '));
fs.mkdirSync(ledgerDir(), { recursive: true, mode: 0o700 });
const meta = JSON.stringify({ pid: process.pid, at: Date.now(), cmd: path.basename(process.argv[1] || process.execPath) });
const ledgerLock = path.join(ledgerDir(), runId + '.jsonl.lock');
fs.writeFileSync(ledgerLock, meta);
const ledger = createLedger(runId);
const line = ledger.cost({ model: 'm', usage: null, pricing: null, yuan: 0, priced: false });
const ledgerFile = path.join(ledgerDir(), runId + '.jsonl');
const ledgerLines = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').split('\\n').filter(Boolean).length : 0;
const ledgerWarned = warns.some((w) => w.includes('账本写入失败'));
fs.unlinkSync(ledgerLock);

const netLock = egressLogFile() + '.lock';
fs.mkdirSync(path.dirname(netLock), { recursive: true, mode: 0o700 });
fs.writeFileSync(netLock, meta);
const warnsBefore = warns.length;
recordEgress({ host: 'probe.example', port: '443', kind: 'direct', allowed: true });
const netFile = egressLogFile();
const netLines = fs.existsSync(netFile) ? fs.readFileSync(netFile, 'utf8').split('\\n').filter(Boolean).length : 0;
const netWarned = warns.slice(warnsBefore).some((w) => w.includes('出网日志写入失败'));
fs.unlinkSync(netLock);
console.warn = origWarn;
process.stdout.write('PROBE ' + JSON.stringify({ line, ledgerWarned, ledgerLines, netLines, netWarned }) + '\\n');
`;
  const pr = await withDeadline(runChild(probe, { MINGDAO_LOCK_TIMEOUT_MS: '700' }), 'ledger 锁探针');
  assert.equal(pr.code, 0, `锁探针必须正常退出：${pr.err || pr.out}`);
  const probeLine = String(pr.out).split('\n').find((l) => l.startsWith('PROBE '));
  assert.ok(probeLine, `锁探针必须输出结果：${pr.out}${pr.err}`);
  const probeData = JSON.parse(String(probeLine).slice('PROBE '.length));
  assert.equal(probeData.line, null, 'E5b：账本追加必须持锁（外部持锁时写入必须失败，而不是绕开锁直接 append）');
  assert.equal(probeData.ledgerLines, 0, 'E5b：账本追加必须持锁（外部持锁时账本文件不得新增行）');
  assert.equal(probeData.ledgerWarned, true, 'E5b：账本追加必须持锁，且失败必须可见 warn');
  ok('ledger：外部持锁时追加被正确阻塞（锁语义有效）');
}

// ===========================================================================
// ⑥ egress：并发 50 条 → 50 行；外部持锁时不写入
// ===========================================================================
{
  freshHome('egress');
  const kids = [];
  const WORKERS = 5;
  const PER_WORKER = 10;
  for (let w = 0; w < WORKERS; w += 1) {
    const body = `
const fs = (await import('node:fs')).default;
const { recordEgress, egressLogFile } = await import(${JSON.stringify(netGuardUrl)});
// 拉宽「读全文」窗口：如果实现退回「读全文 → 覆盖写」，5 路并发会互相吞掉对方的行。
const realRead = fs.readFileSync.bind(fs);
fs.readFileSync = (p, ...args) => {
  const r = realRead(p, ...args);
  if (String(p) === egressLogFile()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  return r;
};
process.stdout.write('READY\\n');
await new Promise((resolve) => process.stdin.once('data', resolve));
const n = Number(process.env.MDH_N);
for (let i = 0; i < n; i += 1) {
  recordEgress({ host: 'worker.example', port: String(8000 + i), kind: 'direct', allowed: true });
}
process.stdout.write('DONE\\n');
`;
    kids.push(startChild(body, { MDH_N: String(PER_WORKER) }));
  }
  await Promise.all(kids.map((k) => withDeadline(k.ready, 'egress READY')));
  for (const k of kids) k.go();
  const results = await Promise.all(kids.map((k) => withDeadline(k.done, 'egress 子进程')));
  for (const [i, r] of results.entries()) {
    assert.equal(r.code, 0, `egress 子进程 ${i} 必须正常退出：${r.err || r.out}`);
    assert.match(r.out, /DONE/, `egress 子进程 ${i} 必须完成：${r.out}${r.err}`);
  }
  const file = egressLogFile();
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(
    lines.length,
    WORKERS * PER_WORKER,
    `E6a：并发 ${WORKERS * PER_WORKER} 条出网日志后必须恰好 ${WORKERS * PER_WORKER} 行且每行可解析，实际 ${lines.length} 行`
  );
  let bad = 0;
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      bad += 1;
    }
  }
  assert.equal(bad, 0, `E6a：并发 ${WORKERS * PER_WORKER} 条出网日志后必须恰好 ${WORKERS * PER_WORKER} 行且每行可解析，实际有 ${bad} 行不可解析`);
  ok(`egress：并发 ${WORKERS * PER_WORKER} 条 → 行数正确且逐行可解析`);

  freshHome('egress-lock-probe'); // 独立 home：外部持锁期间必须一条都不写（不是「比之前多 0 条」）
  const probe = `
const fs = (await import('node:fs')).default;
const path = (await import('node:path')).default;
const { recordEgress, egressLogFile } = await import(${JSON.stringify(netGuardUrl)});
const warns = [];
const origWarn = console.warn;
console.warn = (...a) => warns.push(a.join(' '));
const lock = egressLogFile() + '.lock';
fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), cmd: path.basename(process.argv[1] || process.execPath) }));
recordEgress({ host: 'probe.example', port: '443', kind: 'direct', allowed: true });
const file = egressLogFile();
const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean).length : 0;
const warned = warns.some((w) => w.includes('出网日志写入失败'));
fs.unlinkSync(lock);
console.warn = origWarn;
process.stdout.write('PROBE ' + JSON.stringify({ lines, warned }) + '\\n');
`;
  const pr = await withDeadline(runChild(probe, { MINGDAO_LOCK_TIMEOUT_MS: '700' }), 'egress 锁探针');
  assert.equal(pr.code, 0, `出网锁探针必须正常退出：${pr.err || pr.out}`);
  const probeLine = String(pr.out).split('\n').find((l) => l.startsWith('PROBE '));
  assert.ok(probeLine, `出网锁探针必须输出结果：${pr.out}${pr.err}`);
  const probeData = JSON.parse(String(probeLine).slice('PROBE '.length));
  assert.equal(probeData.lines, 0, 'E6b：出网日志追加必须持锁（外部持锁时不得新增行）');
  assert.equal(probeData.warned, true, 'E6b：出网日志追加必须持锁，且失败必须可见 warn');
  ok('egress：外部持锁时写入被正确阻塞（锁语义有效）');
}

// ===========================================================================
// ⑦ 六条写路径注入 EACCES：都必须有可见 warn、都只返回失败而不崩
// ===========================================================================
{
  freshHome('write-failures');
  fs.writeFileSync(path.join(process.env.MINGDAO_HOME || '', 'config.json'), JSON.stringify({ provider: 'deepseek' }, null, 2) + '\n');
  fs.writeFileSync(path.join(process.env.MINGDAO_HOME || '', 'credentials.json'), '{}\n', { mode: 0o600 });
  const body = `
const fs = (await import('node:fs')).default;
const { saveConfig } = await import(${JSON.stringify(configUrl)});
const { setStoredKey } = await import(${JSON.stringify(credentialsUrl)});
const { writeModelCache } = await import(${JSON.stringify(configUrl)});
const { learnEndpointMemoryFailure } = await import(${JSON.stringify(providersUrl)});
const { createLedger } = await import(${JSON.stringify(ledgerUrl)});
const { recordEgress } = await import(${JSON.stringify(netGuardUrl)});

const warns = [];
const origWarn = console.warn;
console.warn = (...a) => warns.push(a.join(' '));
const cases = [];
/** 注入 EACCES：只拒绝「写目标临时文件」的那一次调用，其余写照常。 */
function injectWriteFailure(fragment) {
  const real = fs.writeFileSync;
  fs.writeFileSync = function (p, ...args) {
    if (String(p).includes(fragment)) {
      const e = new Error('injected EACCES for ' + String(p));
      e.code = 'EACCES';
      throw e;
    }
    return real.call(fs, p, ...args);
  };
  return () => { fs.writeFileSync = real; };
}
function injectAppendFailure(fragment) {
  const real = fs.appendFileSync;
  fs.appendFileSync = function (p, ...args) {
    if (String(p).includes(fragment)) {
      const e = new Error('injected EACCES for ' + String(p));
      e.code = 'EACCES';
      throw e;
    }
    return real.call(fs, p, ...args);
  };
  return () => { fs.appendFileSync = real; };
}
function expectWarn(name, before, result, extra) {
  const grew = warns.length > before;
  const visible = warns.slice(before).some((w) => w.includes('⚠') && w.includes('失败'));
  // result.ok === false / result === false 都表示「这条写路径确实失败了」
  const failed = result === false || result?.ok === false;
  cases.push({ name, grew, visible, ok: failed, extra: extra ?? null });
}

// 1. config
let before = warns.length;
let restore = injectWriteFailure('.config.json.');
let r1 = saveConfig({ provider: 'deepseek', model: 'x' });
restore();
expectWarn('config', before, r1);
// 2. credentials
before = warns.length;
restore = injectWriteFailure('.credentials.json.');
let r2 = setStoredKey('deepseek', 'sk-inject-000000');
restore();
expectWarn('credentials', before, r2);
// 3. model-cache
before = warns.length;
restore = injectWriteFailure('.model-cache.json.');
let r3 = writeModelCache({ marker: 'inject' });
restore();
expectWarn('model-cache', before, r3);
// 4. endpoint-limits
before = warns.length;
restore = injectWriteFailure('.endpoint-limits.json.');
let r4 = learnEndpointMemoryFailure('http://127.0.0.1:6399/v1', { budget: 4096 });
restore();
expectWarn('endpoint-limits', before, r4);
// 5. ledger
before = warns.length;
restore = injectAppendFailure('.jsonl');
const ledger = createLedger('inject-abc123');
const line5 = ledger.cost({ model: 'm', usage: null, pricing: null, yuan: 0, priced: false });
restore();
expectWarn('ledger', before, { ok: line5 !== null }); // line5 === null = 写入确实失败
// 6. egress（recordEgress 不返回 ok，只验证 warn 与不抛）
before = warns.length;
restore = injectAppendFailure('net.jsonl');
let threw6 = false;
try { recordEgress({ host: 'inject.example', port: '443', kind: 'direct', allowed: true }); } catch { threw6 = true; }
restore();
cases.push({ name: 'egress', grew: warns.length > before, visible: warns.slice(before).some((w) => w.includes('⚠') && w.includes('失败')), ok: !threw6, extra: null });

console.warn = origWarn;
process.stdout.write('FAILURES ' + JSON.stringify(cases) + '\\n');
`;
  const r = await withDeadline(runChild(body), '写失败注入子进程', 90000);
  assert.equal(r.code, 0, `写失败注入子进程不得崩溃（只 warn）：${r.stderr || r.stdout}`);
  const line = String(r.out).split('\n').find((l) => l.startsWith('FAILURES '));
  assert.ok(line, `写失败注入子进程必须输出结果：${r.out}${r.stderr}`);
  const cases = JSON.parse(String(line).slice('FAILURES '.length));
  const bad = cases.filter((/** @type {any} */ c) => !(c.ok && c.grew && c.visible));
  assert.deepEqual(
    bad,
    [],
    `E7：写失败必须可见 warn 且不崩（注入 EACCES）——以下路径不符合：${JSON.stringify(bad)}`
  );
  assert.equal(cases.length, 6, 'E7：六条写路径都必须被覆盖（config / credentials / model-cache / endpoint-limits / ledger / egress）');
  ok('写失败：六条路径均 warn 可见且不崩（注入 EACCES）');
}

console.log(`\nstate-locks：${passed} 项全部通过`);
process.env.MINGDAO_HOME = baseHome;
