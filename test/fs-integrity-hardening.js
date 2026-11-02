// 文件锁 / 写完整性 独立回归套件（v0.6.30，E1–E5）。
//
// 五类缺陷的共同点：**正常路径几乎看不出来，只在争用/失败/掉电/坏条目下暴露**，而且
// 一旦暴露就是数据级后果（消息凭空消失、唯一索引副本被删、WebUI 冻结 2 秒、写到 0 字节、
// 会话列表整体清空）。因此每条都按「可执行判据」断言，而不是靠读代码：
//   E1 第 4 个并发任务的互斥（A 的 cleanup 误删 B/C 的链 → D 与 B 重叠）；
//   E2 迁移失败仍删唯一副本（saveShard 的 {ok:false} 没参与 allOk）；
//   E3 请求路径上的同步锁（锁争用冻结事件循环；异步版必须让出）；
//   E4 原子写缺文件/目录 fsync + Windows 权限失效；
//   E5 单个 stat 失败清空整个会话列表。
//
// 运行：node test/fs-integrity-hardening.js（不依赖网络；并发/持锁场景用真子进程，
// 平台相关分支（Windows）用 platform 模拟，不靠"本机恰好是哪个系统"）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-fs-integrity-'));
process.env.MINGDAO_HOME = baseHome;

const AW = await import(pathToFileURL(path.join(srcDir, 'atomic-write.js')).href);
const SI = await import(pathToFileURL(path.join(srcDir, 'session-index.js')).href);
const MEM = await import(pathToFileURL(path.join(srcDir, 'memory.js')).href);
const SESS = await import(pathToFileURL(path.join(srcDir, 'session.js')).href);

const atomicUrl = JSON.stringify(pathToFileURL(path.join(srcDir, 'atomic-write.js')).href);

let passed = 0;
const ok = (/** @type {string} */ name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** Windows/杀软可能让 rmSync 瞬时 EBUSY：重试几次，最终失败不影响断言。 */
function safeRm(/** @type {string} */ p) {
  for (let i = 0; i < 6; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/** 新临时 home（每个断言独立，互不串味）。 */
function freshHome(/** @type {string} */ tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mingdao-e-${tag}-`));
}

/** 在 home 下建 sessions/ 与若干会话文件。 */
function seedSessions(/** @type {string} */ home, /** @type {string[]} */ names) {
  const dir = path.join(home, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, n), JSON.stringify({ role: 'user', content: `内容 ${n}` }) + '\n');
  return { dir, sessions: names.map((n) => ({ file: path.join(dir, n), name: n, mtime: fs.statSync(path.join(dir, n)).mtimeMs })) };
}

/** 子进程持有同一把锁 ms 毫秒（真跨进程互斥，不靠同进程顺序调用假装并发）。 */
async function startLockHolder(/** @type {string} */ lockPath, /** @type {number} */ holdMs) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { withFileLockSync } from ${atomicUrl};
       withFileLockSync(${JSON.stringify(lockPath)}, () => { const s = Date.now(); while (Date.now() - s < ${holdMs}) {} });`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  );
  // 等锁真的出现（子进程启动完成），而不是盲等一个固定时间。
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(lockPath)) {
    if (Date.now() > deadline) throw new Error('持锁子进程未能就绪（锁文件未出现）');
    await sleep(20);
  }
  return child;
}

/**
 * E1：withSessionLock 是 server.js 内部的闭包函数（未导出），直接驱动 HTTP 并发需要模型桩。
 * 这里按「JS 花括号配平」从源码抽出 `sessionLocks + withSessionLock` 求值——测的是**真实现**，
 * 变异改回无条件 delete 时行为断言当场红。抽不到（函数被删/改名）本身就是失败。
 */
function loadSessionLock() {
  const src = fs.readFileSync(path.join(srcDir, 'web', 'server.js'), 'utf8');
  const start = src.indexOf('const sessionLocks = new Map();');
  assert.ok(start >= 0, 'E1：server.js 里找不到 sessionLocks 声明');
  const fnStart = src.indexOf('function withSessionLock(', start);
  assert.ok(fnStart >= 0, 'E1：server.js 里找不到 withSessionLock');
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf('{', fnStart); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > fnStart, 'E1：withSessionLock 花括号不配平');
  const code = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${code}\nreturn { withSessionLock, sessionLocks };`)();
}

/** 记录每个任务的 [start, end]，判断任意两个任务是否重叠。 */
function overlaps(/** @type {[string, number, number][]} */ spans) {
  const bad = [];
  for (let i = 0; i < spans.length; i += 1) {
    for (let j = i + 1; j < spans.length; j += 1) {
      const a = spans[i];
      const b = spans[j];
      if (a[1] < b[2] && b[1] < a[2]) bad.push(`${a[0]}×${b[0]}`);
    }
  }
  return bad;
}

// ===========================================================================
// E1：会话锁第 4 个并发互斥（≥5 项）
// ===========================================================================
{
  const { withSessionLock, sessionLocks } = loadSessionLock();
  const spans = [];
  const task = (/** @type {string} */ name, /** @type {number} */ ms) =>
    withSessionLock('s1', async () => {
      const t0 = Date.now();
      await sleep(ms);
      spans.push([name, t0, Date.now()]);
    });

  // A 短、B 长、C 中；A 完成后才放 D（正是 PoC-3 的交错）。
  const pa = task('A', 50);
  const pb = task('B', 300);
  const pc = task('C', 200);
  await sleep(100); // A 已完成，B/C 在途
  const pd = task('D', 50);
  await Promise.all([pa, pb, pc, pd]);

  // 1. 零重叠（旧实现：A 的 cleanup 删掉 C 的链 → D 与 B 重叠）
  assert.deepEqual(overlaps(spans), [], `E1：A/B/C/D 不得重叠，实际 ${overlaps(spans).join('、')}`);
  ok('E1：A/B/C/D 交错 → 四个任务零重叠（第 4 个并发不再插队）');

  // 2. 严格 FIFO：A → B → C → D
  const order = [...spans].sort((a, b) => a[1] - b[1]).map((s) => s[0]);
  assert.deepEqual(order, ['A', 'B', 'C', 'D'], `E1：执行序应为 A→B→C→D，实际 ${order.join('→')}`);
  ok('E1：后来者在链尾排队（执行序 A→B→C→D）');

  // 3. 散场后 map 必须清空（异常/正常路径都不留内存泄漏）
  await sleep(10); // tail 的清理在 next settle 后再走一两个微任务，等一拍再断言
  assert.equal(sessionLocks.size, 0, `E1：全部完成后 sessionLocks 应为空，实际 ${sessionLocks.size}`);
  ok('E1：正常路径清理完毕（sessionLocks.size === 0）');
}

{
  const { withSessionLock, sessionLocks } = loadSessionLock();
  let active = 0;
  let maxActive = 0;
  const spans = [];
  const order = [];
  const task = (/** @type {string} */ name, /** @type {number} */ ms) =>
    withSessionLock('s2', async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(name);
      const t0 = Date.now();
      await sleep(ms);
      spans.push([name, t0, Date.now()]);
      active -= 1;
    });

  // 先放 3 个（第一个短），等它结束后再放 2 个——旧实现在此时已把链删掉。
  const first = [task('t0', 20), task('t1', 150), task('t2', 150)];
  await sleep(60);
  const later = [task('t3', 20), task('t4', 20)];
  await Promise.all([...first, ...later]);

  // 4. 5 个任务严格串行
  assert.equal(maxActive, 1, `E1：5 个并发任务必须串行，实际最大并发 ${maxActive}`);
  assert.deepEqual(overlaps(spans), [], `E1：5 个任务不得重叠，实际 ${overlaps(spans).join('、')}`);
  assert.deepEqual(order, ['t0', 't1', 't2', 't3', 't4'], `E1：执行序错乱：${order.join('→')}`);
  ok('E1：5 个任务（含首任务结束后才提交的 2 个）→ 最大并发 1、顺序不跳队');

  // 5. 异常路径：失败任务不得卡死链，也不得留下 map 条目
  const failing = withSessionLock('s3', async () => {
    await sleep(20);
    throw new Error('E1 故意失败');
  });
  const after = withSessionLock('s3', async () => {
    await sleep(10);
    return 'ok';
  });
  await assert.rejects(failing, /E1 故意失败/);
  assert.equal(await after, 'ok', 'E1：前一个任务抛错后，后续任务必须仍能执行');
  await sleep(10);
  assert.equal(sessionLocks.size, 0, `E1：异常路径也必须清理 sessionLocks，实际 ${sessionLocks.size}`);
  ok('E1：异常路径正常清理且不阻塞后续任务（无内存泄漏）');
}

// ===========================================================================
// E2：迁移失败不得删除唯一副本（≥3 项）
// ===========================================================================
{
  const home = freshHome('e2');
  // 索引分片/旧索引都落在 mingdaoHome()（不是入参 home）；测试里两者必须一致。
  process.env.MINGDAO_HOME = home;
  const legacy = path.join(home, 'sessions-index.json');
  // 两个文件必须真的存在：syncSessionIndex 会清理"无存活会话"的分片条目，
  // 不建文件的话，迁移成功的 a 分片随后就会被清掉（测试前提错误，不是产品 bug）。
  // 只建文件、不把 sessions 传给同步：让迁移出的条目不被"按 mtime 重算"覆盖，
  // 从而能直接断言"迁移内容原样保留"（文件存在 → 清理死条目时不会被删）。
  seedSessions(home, ['a.jsonl', 'b.jsonl']);
  fs.writeFileSync(
    legacy,
    JSON.stringify({ files: { 'a.jsonl': { mtime: 1, size: 10, terms: { a: 1 } }, 'b.jsonl': { mtime: 2, size: 20, terms: { b: 1 } } } })
  );
  // 让 b 的分片路径变成目录 → saveShard 的 rename 必失败（EISDIR），但**不抛**（返回 {ok:false}）
  const shardDir = path.join(home, 'sessions-index');
  fs.mkdirSync(shardDir, { recursive: true });
  const bShard = path.join(shardDir, `${SI.shardOf('b.jsonl')}.json`);
  fs.mkdirSync(bShard, { recursive: true });

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (/** @type {any} */ ...args) => warnings.push(args.join(' '));
  let result;
  try {
    result = SI.syncSessionIndex(home, []);
  } finally {
    console.warn = realWarn;
  }

  // 1. 旧文件保留（唯一副本不能被删）
  assert.ok(fs.existsSync(legacy), 'E2：迁移不完整时必须保留旧索引文件（唯一副本）');
  // 2. 迁移中断言**有可见日志**（不是静默保留）
  assert.ok(
    warnings.some((w) => w.includes('迁移未完成') && w.includes('已保留')),
    `E2：必须打印可见的迁移未完成日志，实际：${warnings.join(' | ').slice(0, 200)}`
  );
  // 3. 迁移失败原因可查（saveShard 的失败没有再次被吞掉）
  assert.ok(SI.shardWriteError(), 'E2：迁移失败原因必须可查（shardWriteError 非空）');
  ok('E2：一个分片写失败 → 旧索引保留 + 可见日志 + 失败原因可查');

  // 4. 下次启动重试：修好障碍后同一进程再调 → 迁移完成、旧文件才删除
  fs.rmSync(bShard, { recursive: true, force: true });
  SI.syncSessionIndex(home, []);
  assert.ok(!fs.existsSync(legacy), 'E2：迁移成功后旧索引才应删除（下次启动重试生效）');
  const aIdx = JSON.parse(fs.readFileSync(path.join(shardDir, `${SI.shardOf('a.jsonl')}.json`), 'utf8'));
  const bIdx = JSON.parse(fs.readFileSync(path.join(shardDir, `${SI.shardOf('b.jsonl')}.json`), 'utf8'));
  assert.equal(aIdx.files['a.jsonl']?.terms?.a, 1, 'E2：迁移后的分片内容必须保留原词表（a）');
  assert.equal(bIdx.files['b.jsonl']?.terms?.b, 1, 'E2：迁移后的分片内容必须保留原词表（b）');
  ok('E2：修好障碍后重试 → 两个分片都迁移成功、旧文件才删除');

  // 5. 全成功路径（无旧文件时不应误报/报错）仍可用
  const home2 = freshHome('e2b');
  process.env.MINGDAO_HOME = home2;
  const { sessions } = seedSessions(home2, ['c.jsonl']);
  const idx = SI.syncSessionIndex(home2, sessions);
  assert.ok(idx.files['c.jsonl']?.terms, 'E2：没有旧索引时正常同步不受影响');
  ok('E2：全成功路径无回归（正常同步仍产出词表条目）');
  process.env.MINGDAO_HOME = baseHome;
  safeRm(home);
  safeRm(home2);
}

// ===========================================================================
// E3：请求路径必须用异步锁（≥4 项）
// ===========================================================================
{
  const home = freshHome('e3');
  process.env.MINGDAO_HOME = home;
  const { sessions } = seedSessions(home, ['a.jsonl']);
  const lockPath = path.join(home, 'sessions-index', `${SI.shardOf('a.jsonl')}.json.lock`);
  fs.mkdirSync(path.join(home, 'sessions-index'), { recursive: true });
  const holder = await startLockHolder(lockPath, 2400);

  // 1. 异步版在锁争用下**不冻结**事件循环：100ms 心跳至少 15 次 / 2s
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 100);
  const t0 = Date.now();
  let idx;
  try {
    idx = await SI.syncSessionIndexAsync(home, sessions);
  } finally {
    clearInterval(timer);
  }
  const waited = Date.now() - t0;
  assert.ok(waited >= 1500, `E3：前提是异步版真的等过持锁者（实际 ${waited}ms）`);
  assert.ok(ticks >= 15, `E3：异步版等待期间不得冻结事件循环（2s 内心跳应 ≥15，实际 ${ticks}）`);
  assert.ok(idx.files['a.jsonl']?.terms, 'E3：异步版的检索结果必须与同步版一致');
  ok(`E3：syncSessionIndexAsync 争用等待 ${waited}ms，期间心跳 ${ticks} 次 → 事件循环未冻结`);

  // 2. 同步版保留给 CLI（不回归）：无争用时同步返回、结果一致
  const syncIdx = SI.syncSessionIndex(home, sessions);
  assert.ok(syncIdx && !(syncIdx instanceof Promise), 'E3：CLI 仍需要同步版（返回对象而非 Promise）');
  assert.ok(syncIdx.files['a.jsonl']?.terms, 'E3：同步版结果不得回归');
  ok('E3：同步版仍可用于 CLI（返回对象、结果一致）');

  // 3. /api/memory 去重的异步版：持锁期间心跳照常
  fs.writeFileSync(MEM.memoryFile(), '- [2026-01-01] 重复\n- [2026-01-02] 重复\n- [2026-01-03] 唯一\n');
  const memLock = MEM.memoryFile() + '.lock';
  const memHolder = await startLockHolder(memLock, 2400);
  let ticks2 = 0;
  const timer2 = setInterval(() => {
    ticks2 += 1;
  }, 100);
  const t1 = Date.now();
  let removed;
  try {
    removed = await MEM.dedupeMemoryAsync();
  } finally {
    clearInterval(timer2);
  }
  const waited2 = Date.now() - t1;
  assert.ok(waited2 >= 1500, `E3：前提是去重异步版真的等过持锁者（实际 ${waited2}ms）`);
  assert.ok(ticks2 >= 15, `E3：去重等待期间不得冻结事件循环（2s 内心跳应 ≥15，实际 ${ticks2}）`);
  assert.equal(removed, 1, `E3：去重应移除 1 条重复，实际 ${removed}`);
  ok(`E3：dedupeMemoryAsync 争用等待 ${waited2}ms，期间心跳 ${ticks2} 次 → 事件循环未冻结`);

  // 4. /api/memory 整体覆写的异步版：持锁期间心跳照常、写后内容正确
  fs.writeFileSync(MEM.memoryFile(), '- [2026-01-01] 旧内容\n');
  const writeLock = MEM.memoryFile() + '.lock';
  const writeHolder = await startLockHolder(writeLock, 2400);
  let ticks3 = 0;
  const timer3 = setInterval(() => {
    ticks3 += 1;
  }, 100);
  const t2 = Date.now();
  try {
    await MEM.writeMemoryAsync('- [2026-02-02] 新内容\n');
  } finally {
    clearInterval(timer3);
  }
  const waited3 = Date.now() - t2;
  assert.ok(waited3 >= 1500, `E3：前提是覆写异步版真的等过持锁者（实际 ${waited3}ms）`);
  assert.ok(ticks3 >= 15, `E3：覆写等待期间不得冻结事件循环（2s 内心跳应 ≥15，实际 ${ticks3}）`);
  assert.equal(MEM.loadMemory(), '- [2026-02-02] 新内容\n', 'E3：异步覆写后的内容必须正确');
  ok(`E3：writeMemoryAsync 争用等待 ${waited3}ms，期间心跳 ${ticks3} 次 → 事件循环未冻结`);

  // 5. 结构守卫：WebUI 请求路径不得退回同步入口（行为上难直接触发，静态绊线在此）
  const miscSrc = fs.readFileSync(path.join(srcDir, 'web', 'routes', 'domains', 'misc.js'), 'utf8');
  const sessionsRouteSrc = fs.readFileSync(path.join(srcDir, 'web', 'routes', 'domains', 'sessions.js'), 'utf8');
  assert.ok(/await\s+dedupeMemoryAsync\s*\(/.test(miscSrc), 'E3：/api/memory 去重必须 await dedupeMemoryAsync（请求路径禁止同步锁）');
  assert.ok(/await\s+writeMemoryAsync\s*\(/.test(miscSrc), 'E3：/api/memory 覆写必须 await writeMemoryAsync（请求路径禁止同步锁）');
  assert.ok(/await\s+searchSessionsAsync\s*\(/.test(sessionsRouteSrc), 'E3：GET /api/sessions?q= 必须 await searchSessionsAsync（请求路径禁止同步锁）');
  const indexSrc = fs.readFileSync(path.join(srcDir, 'session-index.js'), 'utf8');
  assert.ok(/export\s+async\s+function\s+syncSessionIndexAsync/.test(indexSrc), 'E3：必须提供 syncSessionIndexAsync');
  assert.ok(/await\s+withFileLock\s*\(/.test(indexSrc), 'E3：异步版必须 await withFileLock（不是同步版换皮）');
  const memorySrc = fs.readFileSync(path.join(srcDir, 'memory.js'), 'utf8');
  assert.ok(/await\s+appendMemoryAsync\s*\(/.test(memorySrc), 'E3：会话收尾必须 await appendMemoryAsync（请求路径禁止同步锁）');
  ok('E3：WebUI 请求路径均走异步入口（检索/记忆去重/覆写/会话收尾；结构守卫，变异即红）');

  holder.kill('SIGKILL');
  memHolder.kill('SIGKILL');
  writeHolder.kill('SIGKILL');
  await sleep(50);
  process.env.MINGDAO_HOME = baseHome;
  safeRm(home);
}

// ===========================================================================
// E4：原子写 fsync + Windows chmod（≥5 项）
// ===========================================================================
{
  const dir = freshHome('e4');
  const target = path.join(dir, 'atomic.txt');

  // 1/2/3：文件 fsync 与目录 fsync 都必须被调用（桩断言，不靠"看起来像"）
  const realFsync = fs.fsyncSync;
  const kinds = [];
  fs.fsyncSync = (/** @type {number} */ fd) => {
    kinds.push(fs.fstatSync(fd).isDirectory() ? 'dir' : 'file');
    return realFsync(fd);
  };
  let res;
  try {
    res = AW.atomicWriteFileSync(target, 'hello\n', { mode: 0o600 });
  } finally {
    fs.fsyncSync = realFsync;
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello\n', 'E4：成功写入后目标内容必须正确');
  assert.ok(kinds.includes('file'), `E4：写临时文件后必须 fsync 文件（实际 ${kinds.join(',') || '无'}）`);
  assert.equal(res.fileFsync, true, 'E4：返回值必须可见 fileFsync=true');
  ok('E4：写临时文件后调用 fsync（桩计数 + 返回值可见）');

  if (process.platform === 'win32') {
    assert.equal(res.dirFsync, 'skipped', 'E4：Windows 不支持目录 fsync → 必须如实标记 skipped');
  } else {
    assert.ok(kinds.includes('dir'), `E4：rename 后必须 fsync 目录（POSIX，实际 ${kinds.join(',') || '无'}）`);
    assert.equal(res.dirFsync, true, 'E4：返回值必须可见 dirFsync=true');
  }
  ok(`E4：rename 后目录 fsync 按平台处理（${process.platform === 'win32' ? 'Windows 跳过并标记' : 'POSIX 已调用'}）`);

  // 4. 既有原子写语义不回归：成功不留 tmp、覆盖旧内容不半截
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], `E4：成功路径不得留下临时文件，实际 ${leftovers.join(',')}`);
  AW.atomicWriteFileSync(target, 'second\n', { mode: 0o600 });
  assert.equal(fs.readFileSync(target, 'utf8'), 'second\n', 'E4：覆盖写语义不变');
  ok('E4：原子写既有语义不回归（成功无 tmp 残留、覆盖后内容完整）');

  // 5. Windows 模拟：open(mode) 不生效 → 必须走 chmod 兜底，并在返回值里可见
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  let winRes;
  try {
    winRes = AW.atomicWriteFileSync(path.join(dir, 'win.txt'), 'win\n', { mode: 0o600 });
  } finally {
    Object.defineProperty(process, 'platform', platformDesc);
  }
  assert.equal(winRes.chmod, 'applied', 'E4：Windows 模拟必须走 chmod 兜底（返回值标记 applied）');
  assert.equal(winRes.dirFsync, 'skipped', 'E4：Windows 不支持目录 fsync → 标记 skipped');
  // v0.6.30（Windows 腿）：这条断言只在 POSIX 宿主上有观测面——它验证的是「被模拟成 win32 时
  // 代码真的调了 chmod」，而 chmod 只有在 POSIX 文件系统上才会体现在 mode 位。
  // 真 Windows 上 chmod 不影响 stat 的 mode（仍旧 0666/0444，实测 438），断言必然假红；
  // 因此真 Windows 只断言**可观测的返回值**（chmod='applied'，已在上一行），
  // 并显式跳过 mode 位（打印可见提示，不静默）。
  if (process.platform === 'win32') {
    console.log('   ⚠ 跳过：E4 的 mode 位断言（真 Windows 上 chmod 不改变 stat.mode；返回值 chmod=applied 已断言）');
  } else {
    assert.equal(fs.statSync(path.join(dir, 'win.txt')).mode & 0o777, 0o600, 'E4：Windows 模拟下目标权限应为 0600');
  }
  ok('E4：platform=win32 模拟 → chmod 兜底执行、目录 fsync 标记 skipped（可见标记）');

  // 6. Windows 上 chmod 失败：不阻断写入，但返回值/警告必须可见
  const realChmod = fs.chmodSync;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  fs.chmodSync = () => {
    const e = /** @type {any} */ (new Error('EPERM: operation not permitted'));
    e.code = 'EPERM';
    throw e;
  };
  let failRes;
  try {
    failRes = AW.atomicWriteFileSync(path.join(dir, 'win2.txt'), 'win2\n', { mode: 0o600 });
  } finally {
    fs.chmodSync = realChmod;
    Object.defineProperty(process, 'platform', platformDesc);
  }
  assert.equal(failRes.chmod, 'failed', 'E4：chmod 失败必须标记 failed');
  assert.ok(failRes.warnings.some((w) => w.includes('chmod')), `E4：chmod 失败必须有可见 warning，实际 ${failRes.warnings.join('|')}`);
  assert.equal(fs.readFileSync(path.join(dir, 'win2.txt'), 'utf8'), 'win2\n', 'E4：chmod 失败不得阻断写入');
  ok('E4：Windows 模拟 chmod 失败 → 写入不阻断，但 chmod=failed + 可见 warning');

  // 7. 失败路径不留半截：rename 失败时目标保持旧内容、临时文件清理
  fs.writeFileSync(target, 'old\n');
  const realRename = fs.renameSync;
  fs.renameSync = () => {
    const e = /** @type {any} */ (new Error('EIO: i/o error'));
    e.code = 'EIO';
    throw e;
  };
  let threw = null;
  try {
    AW.atomicWriteFileSync(target, 'new\n', { mode: 0o600 });
  } catch (e) {
    threw = e;
  } finally {
    fs.renameSync = realRename;
  }
  assert.ok(threw, 'E4：rename 失败必须抛错（不得假装成功）');
  assert.equal(fs.readFileSync(target, 'utf8'), 'old\n', 'E4：失败时目标必须保持旧内容（不得留半截）');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'E4：失败路径必须清理临时文件');
  ok('E4：失败不留半截（目标保持旧内容、tmp 已清理、异常上抛）');

  safeRm(dir);
}

// ===========================================================================
// E5：单个 stat 失败不得清空列表（≥3 项）
// ===========================================================================
{
  const home = freshHome('e5');
  const { dir } = seedSessions(home, ['ok1.jsonl', 'ok2.jsonl', 'ok3.jsonl']);

  // 造一个"readdir 看得见、stat 必失败"的条目：
  // POSIX 用悬空符号链接（真失败）；Windows 建符号链接常需开发者模式 → 退回注入缝。
  const badName = 'broken.jsonl';
  const badFile = path.join(dir, badName);
  let badPrepared = false;
  try {
    fs.symlinkSync(path.join(dir, '不存在的目标'), badFile);
    try {
      fs.statSync(badFile);
    } catch {
      badPrepared = true; // 悬空链接：stat 真的失败
    }
  } catch {}
  let realStat = fs.statSync;
  if (!badPrepared) {
    fs.writeFileSync(badFile, '{}\n');
    fs.statSync = (/** @type {any} */ p, ...rest) => {
      if (String(p) === badFile) {
        const e = /** @type {any} */ (new Error('ENOENT: broken fixture'));
        e.code = 'ENOENT';
        throw e;
      }
      return realStat(p, ...rest);
    };
  }

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (/** @type {any} */ ...args) => warnings.push(args.join(' '));
  let detailed;
  let arr;
  try {
    detailed = SESS.listSessionsDetailed(home);
    arr = SESS.listSessions(home); // 兼容形状：数组
  } finally {
    console.warn = realWarn;
    if (!badPrepared) fs.statSync = realStat;
  }

  // 1. 3 个正常条目仍在，坏条目被跳过并计数
  assert.equal(detailed.list.length, 3, `E5：3 个正常会话必须仍然返回，实际 ${detailed.list.length}`);
  assert.equal(detailed.skipped.length, 1, `E5：1 个不可 stat 的文件必须计入 skipped，实际 ${detailed.skipped.length}`);
  assert.equal(detailed.skipped[0].name, badName, 'E5：skipped 必须指出具体文件');
  assert.ok(detailed.skipped[0].error, 'E5：skipped 必须带上失败原因');
  ok('E5：1 个不可 stat + 3 个正常 → 列表 3 条 + skipped 1 条（不再整体清空）');

  // 2. 跳过必须有可见警告（不是静默少几条）
  assert.ok(
    warnings.some((w) => w.includes('无法读取') && w.includes(badName)),
    `E5：必须打印可见 warning（含文件名），实际 ${warnings.join(' | ').slice(0, 200)}`
  );
  ok('E5：跳过时打印可见 warning（含文件名与原因）');

  // 3. listSessions 兼容形状不变（既有调用方仍拿到数组）
  assert.ok(Array.isArray(arr), 'E5：listSessions 必须保持数组返回形状');
  assert.equal(arr.length, 3, `E5：listSessions 兼容形状也必须返回 3 条，实际 ${arr.length}`);
  assert.equal(arr[0].name.startsWith('ok'), true, 'E5：列表中不得混入坏文件');
  ok('E5：listSessions 兼容数组形状不变（3 条、无坏文件混入）');

  // 4. 全好 + 目录缺失：skipped=0、不误报
  const home2 = freshHome('e5b');
  seedSessions(home2, ['x.jsonl', 'y.jsonl']);
  const goodWarnings = [];
  console.warn = (/** @type {any} */ ...args) => goodWarnings.push(args.join(' '));
  let good;
  let missing;
  try {
    good = SESS.listSessionsDetailed(home2);
    missing = SESS.listSessionsDetailed(path.join(home2, '不存在'));
  } finally {
    console.warn = realWarn;
  }
  assert.equal(good.skipped.length, 0, 'E5：全好时 skipped 必须为 0');
  assert.equal(good.list.length, 2, 'E5：全好时列表必须完整');
  assert.deepEqual(goodWarnings, [], 'E5：全好时不得误报 warning');
  assert.deepEqual(missing, { list: [], skipped: [] }, 'E5：会话目录缺失时返回空列表而非抛错');
  ok('E5：全好路径 skipped=0 且无误报；目录缺失返回空列表');

  safeRm(home);
  safeRm(home2);
}

safeRm(baseHome);
console.log(`\nfs-integrity-hardening：${passed} 项通过`);
process.exit(0);
