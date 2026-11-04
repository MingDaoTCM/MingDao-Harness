// 请求路径文件锁回归套件（v0.7.0 §1.4：把 Web 请求路径上的同步文件锁改成异步）。
//
// 缺陷形态：`withFileLockSync` 用 `Atomics.wait` 睡眠——**等待期间整个事件循环停摆**。
// 症状不是"慢"，是"整站冻结"：持锁方活 5s，则所有会话 / 权限确认 / SSE 流一起停 5s。
// 因此本套件用**真跨进程持锁 + 100ms 心跳**来判定，而不是读源码猜：
//   ① 异步版在锁争用下心跳照常（≥15 次/2s），并且**真的等过**持锁者（不是看到锁就返回空）；
//   ② 对照组：同一场景下同步版心跳必须为 0（证明断言有能力区分"异步"与"同步"）；
//   ③ 锁释放后异步版返回**正确结果**（不是超时返回空数组）；
//   ④ CLI 同步版行为不变（同步返回对象、结果一致）——迁移不得破坏命令行；
//   ⑤ 结构绊线：Web 路由文件**不得**出现 `withFileLockSync(`，且必须 await 异步入口。
//
// 运行：node test/request-path-locks.js（不依赖网络；每个场景用独立临时 MINGDAO_HOME）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');

// 持锁方活 5s，而默认锁超时也是 5s——给等待方留出余量，避免"刚好超时"被误读成失败。
// 必须在 import atomic-write.js / schedule.js 之前设置（默认值在模块加载时求值）。
process.env.MINGDAO_LOCK_TIMEOUT_MS = '12000';
const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-request-path-locks-'));
process.env.MINGDAO_HOME = baseHome;

const S = await import(pathToFileURL(path.join(srcDir, 'schedule.js')).href);
const T = await import(pathToFileURL(path.join(srcDir, 'tasks.js')).href);
const TS = await import(pathToFileURL(path.join(srcDir, 'task-state.js')).href);
const AUDIT = await import(pathToFileURL(path.join(srcDir, 'audit.js')).href);
const CACHE = await import(pathToFileURL(path.join(srcDir, 'cachestats.js')).href);

const HOLDER_SRC = `
import fs from 'node:fs';
import path from 'node:path';
const lockPath = process.argv[2];
const holdMs = Number(process.argv[3]);
fs.mkdirSync(path.dirname(lockPath), { recursive: true });
const fd = fs.openSync(lockPath, 'wx');
// 不写 cmd：持锁期间 pid 一定活着，reclaimIfStale 因此不会回收（与真实持有者一致）
fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
fs.closeSync(fd);
process.stdout.write('locked\\n');
setTimeout(() => {
  try { fs.unlinkSync(lockPath); } catch {}
  process.exit(0);
}, holdMs);
`;

let passed = 0;
const ok = (/** @type {string} */ name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// ⑤ 结构绊线：Web 路由不得出现同步锁；异步入口必须存在且真的 await withFileLock
// ===========================================================================
{
  const domainsDir = path.join(srcDir, 'web', 'routes', 'domains');
  const routeFiles = fs.readdirSync(domainsDir).filter((f) => f.endsWith('.js'));
  // 这些函数的**同步版**都会取文件锁：路由里出现"不带 Async 后缀"的调用即视为退回同步路径。
  // 正则以 `(` 结尾，因此 `listSchedulesAsync(` 不会被误判成 `listSchedules(`。
  const LOCK_BEARING_SYNC = [
    'listSchedules',
    'addSchedule',
    'removeSchedule',
    'pauseSchedule',
    'resumeSchedule',
    'chainSchedules',
    'reconcileSchedules',
    'spawnDaemon',
    'listTasks',
    'patchTask',
    'killTask',
    'reapTasks',
    'saveTaskStateMerge',
    'saveTaskState',
    'syncSessionIndex',
    'writeMemory',
    'dedupeMemory',
    'appendMemory',
    'recordUsage',
    'recordCacheStats',
    'writeAudit',
    'commitState',
  ];
  for (const f of routeFiles) {
    const src = fs.readFileSync(path.join(domainsDir, f), 'utf8');
    assert.ok(
      !/withFileLockSync\s*\(/.test(src),
      `⑤ Web 路由文件 ${f} 不得出现 withFileLockSync( ——请求路径上的锁等待必须用异步版，否则整站冻结`
    );
    for (const fn of LOCK_BEARING_SYNC) {
      assert.ok(
        !new RegExp(`\\b${fn}\\s*\\(`).test(src),
        `⑤ Web 路由文件 ${f} 不得调用同步入口 ${fn}( ——必须改 await ${fn}Async(（请求路径禁止同步锁）`
      );
    }
  }
  const routeSrc = fs.readFileSync(path.join(domainsDir, 'schedule.js'), 'utf8');
  for (const fn of ['listSchedulesAsync', 'addScheduleAsync', 'chainSchedulesAsync', 'removeScheduleAsync', 'pauseScheduleAsync', 'resumeScheduleAsync', 'reconcileSchedulesAsync']) {
    assert.ok(new RegExp(`await\\s+${fn}\\s*\\(`).test(routeSrc), `⑤ 调度域路由必须 await ${fn}（请求路径不得退回同步入口）`);
  }
  assert.ok(/await\s+listTasksAsync\s*\(/.test(routeSrc), '⑤ 调度域路由的 /api/tasks 必须 await listTasksAsync');

  const scheduleSrc = fs.readFileSync(path.join(srcDir, 'schedule.js'), 'utf8');
  for (const fn of ['listSchedulesAsync', 'addScheduleAsync', 'chainSchedulesAsync', 'removeScheduleAsync', 'pauseScheduleAsync', 'resumeScheduleAsync', 'reconcileSchedulesAsync', 'spawnDaemonAsync']) {
    assert.match(scheduleSrc, new RegExp(`export\\s+async\\s+function\\s+${fn}`), `⑤ schedule.js 必须提供 ${fn}（Web 请求路径的异步入口）`);
  }
  assert.ok(/await\s+withFileLock\s*\(/.test(scheduleSrc), '⑤ schedule.js 的异步入口必须 await withFileLock（不是同步版换皮）');

  const tasksSrc = fs.readFileSync(path.join(srcDir, 'tasks.js'), 'utf8');
  for (const fn of ['listTasksAsync', 'patchTaskAsync', 'killTaskAsync', 'reapTasksAsync']) {
    assert.match(tasksSrc, new RegExp(`export\\s+async\\s+function\\s+${fn}`), `⑤ tasks.js 必须提供 ${fn}（Web 请求路径的异步入口）`);
  }
  assert.ok(/withFileLock\s*\(/.test(tasksSrc), '⑤ tasks.js 的异步入口必须使用 async withFileLock（不是同步版换皮）');

  const syncSrc = fs.readFileSync(path.join(srcDir, 'sync.js'), 'utf8');
  assert.match(syncSrc, /async\s+function\s+commitStateAsync/, '⑤ sync.js 必须提供 commitStateAsync（/api/sync 的 push/pull/accept 在请求路径上）');
  assert.ok(/await\s+withFileLock\s*\(/.test(syncSrc), '⑤ sync.js 的异步状态提交必须 await withFileLock');
  assert.ok(
    (syncSrc.match(/await\s+commitStateAsync\s*\(/g) || []).length >= 3,
    '⑤ sync.js 的三个业务入口（push/pull/accept）都必须 await commitStateAsync'
  );

  // ⑥⑦ 的第二提交（聊天收尾 / 工具执行）：结构绊线
  const agentSrc = fs.readFileSync(path.join(srcDir, 'agent.js'), 'utf8');
  assert.ok(!/\bwriteAudit\s*\(/.test(agentSrc), '⑤ agent.js 不得再调用同步 writeAudit( ——工具执行路径已改 writeAuditAsync');
  assert.ok(/await\s+writeAuditAsync\s*\(/.test(agentSrc), '⑤ agent.js 工具执行/约束事件必须 await writeAuditAsync');
  const serverSrc = fs.readFileSync(path.join(srcDir, 'web', 'server.js'), 'utf8');
  assert.ok(!/\brecordUsage\s*\(/.test(serverSrc), '⑤ web/server.js 不得再调用同步 recordUsage( ——聊天收尾已改 recordUsageAsync');
  assert.ok(/recordUsageAsync\s*\(modelName/.test(serverSrc), '⑤ web/server.js 聊天的 onUsage 必须走 recordUsageAsync');
  assert.ok(/await\s+recordUsageAsync\s*\(/.test(serverSrc), '⑤ web/server.js 回合收尾必须 await recordUsageAsync');
  const cacheSrc = fs.readFileSync(path.join(srcDir, 'cachestats.js'), 'utf8');
  assert.match(cacheSrc, /export\s+async\s+function\s+recordUsageAsync/, '⑤ cachestats.js 必须提供 recordUsageAsync');
  assert.match(cacheSrc, /export\s+async\s+function\s+recordAuxUsageAsync/, '⑤ cachestats.js 必须提供 recordAuxUsageAsync');
  const auditSrc = fs.readFileSync(path.join(srcDir, 'audit.js'), 'utf8');
  assert.match(auditSrc, /export\s+async\s+function\s+writeAuditAsync/, '⑤ audit.js 必须提供 writeAuditAsync');
  for (const f of ['titles.js', 'memory.js', 'routing.js']) {
    const src = fs.readFileSync(path.join(srcDir, f), 'utf8');
    assert.ok(/await\s+recordAuxUsageAsync\s*\(/.test(src), `⑤ ${f} 的辅助用量入账必须 await recordAuxUsageAsync（请求路径禁同步锁）`);
  }
  const routeNoSyncGuard = routeFiles.join(',');
  ok(`⑤ 结构绊线通过：${routeFiles.length} 个域路由（${routeNoSyncGuard}）均无 withFileLockSync(`);
}

function freshHome(/** @type {string} */ tag) {
  const home = path.join(baseHome, tag);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/** 起一个真子进程抢锁并持有 ms（确认 stdout 的 locked 后再返回）。 */
async function startLockHolder(/** @type {string} */ lockPath, /** @type {number} */ ms) {
  const script = path.join(freshHome('holder'), 'holder.mjs');
  fs.writeFileSync(script, HOLDER_SRC);
  const child = spawn(process.execPath, [script, lockPath, String(ms)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`持锁子进程未就绪（${lockPath}）`)), 5000);
    child.stdout.once('data', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once('error', reject);
  });
  return child;
}

/** 100ms 心跳；返回 {ticks, stop}。 */
function startHeartbeat() {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 100);
  return { get ticks() { return ticks; }, stop: () => clearInterval(timer) };
}

const SCHEDULE_ID = 'scaaaaaaaaaaaa';
function seedSchedule(/** @type {string} */ home, /** @type {any} */ extra = {}) {
  S.writeSchedule(home, {
    id: SCHEDULE_ID,
    status: 'paused',
    kind: 'once',
    question: '请求路径锁回归任务',
    nextRunAt: Date.now() - 1000,
    createdAt: Date.now(),
    runs: 0,
    ...extra,
  });
}

// ===========================================================================
// ①③ 异步列表：外部持锁 5s 期间事件循环不冻结，锁释放后返回正确结果
// ===========================================================================
{
  const home = freshHome('async-list');
  seedSchedule(home);
  const holder = await startLockHolder(path.join(S.scheduleDir(home), '.lock'), 4500);
  const hb = startHeartbeat();
  const t0 = Date.now();
  let jobs;
  try {
    jobs = await S.listSchedulesAsync(home);
  } finally {
    hb.stop();
  }
  const waited = Date.now() - t0;
  assert.ok(waited >= 3000, `① 前提：异步版必须真的等到持锁方释放（实际只等了 ${waited}ms；锁被去掉或改成短超时？）`);
  assert.ok(hb.ticks >= 15, `① 异步版等待期间事件循环不得冻结（2s 内心跳应 ≥15，实际 ${hb.ticks} 次 / ${waited}ms）`);
  // ③ 正确性：必须返回真实任务，而不是"超时返回空"
  assert.equal(jobs.length, 1, `③ 异步版必须返回锁释放后的真实结果（实际 ${jobs.length} 条）`);
  assert.equal(jobs[0].id, SCHEDULE_ID, '③ 异步版返回的调度任务 id 必须正确');
  assert.equal(jobs[0].question, '请求路径锁回归任务', '③ 异步版返回的任务内容必须正确（不是空壳）');
  ok(`①③ listSchedulesAsync 等锁 ${waited}ms，期间心跳 ${hb.ticks} 次 → 未冻结且结果正确`);
  holder.kill('SIGKILL');
  await sleep(50);
}

// ===========================================================================
// ② 对照组：同一场景下同步版必须阻塞（心跳 0 次），证明①不是恒真
//    （用 pauseSchedule —— 它正是被迁到 pauseScheduleAsync 的那个同步函数，
//     与异步列表共用同一把 schedule/.lock，对照的是"同一把锁 + 同一批调用方"）
// ===========================================================================
{
  const home = freshHome('sync-control');
  seedSchedule(home);
  const holder = await startLockHolder(path.join(S.scheduleDir(home), '.lock'), 2200);
  const hb = startHeartbeat();
  const t0 = Date.now();
  let paused;
  try {
    paused = S.pauseSchedule(home, SCHEDULE_ID); // 同步版：Atomics.wait，事件循环停摆
  } finally {
    hb.stop();
  }
  const waited = Date.now() - t0;
  assert.ok(waited >= 1500, `② 对照前提：同步版必须被持锁方挡住（实际 ${waited}ms）`);
  assert.equal(hb.ticks, 0, `② 对照：同步版等待期间心跳必须为 0（实际 ${hb.ticks} 次）——若不为 0，说明①的"不冻结"结论不可信`);
  assert.equal(paused, true, '② 对照：同步版 pauseSchedule 结果本身正确（只是会冻结事件循环）');
  assert.equal(S.readSchedule(home, SCHEDULE_ID)?.status, 'paused', '② 对照：同步版 pauseSchedule 必须写入 paused');
  ok(`② 对照有效：同步版 pauseSchedule 等锁 ${waited}ms 期间心跳 ${hb.ticks} 次（事件循环确实冻结）`);
  holder.kill('SIGKILL');
  await sleep(50);
}

// ===========================================================================
// ①b tasks 异步路径（Web `/api/tasks` → listTasksAsync → reapTasksAsync → patchTaskAsync）
// ===========================================================================
{
  const home = freshHome('async-tasks');
  fs.mkdirSync(T.tasksDir(home), { recursive: true });
  // 一个"状态 running 但进程已消失"的僵尸任务：listTasksAsync 默认回收，必然走到 patchTaskAsync 的锁
  T.writeTask(home, { id: 'dead0001', status: 'running', pid: 999999, question: '僵尸', startedAt: Date.now() - 60000, text: '', error: '' });
  const holder = await startLockHolder(path.join(T.tasksDir(home), '.lock'), 2200);
  const hb = startHeartbeat();
  const t0 = Date.now();
  let list;
  try {
    list = await T.listTasksAsync(home);
  } finally {
    hb.stop();
  }
  const waited = Date.now() - t0;
  assert.ok(waited >= 1500, `① tasks 前提：listTasksAsync 必须真的等到 tasks 锁释放（实际 ${waited}ms）`);
  assert.ok(hb.ticks >= 15, `① tasks 异步回收等待期间事件循环不得冻结（实际 ${hb.ticks} 次 / ${waited}ms）`);
  assert.equal(list.length, 1, '① tasks：回收后仍应返回该任务');
  assert.equal(list[0].status, 'failed', '① tasks：僵尸任务必须在锁释放后被回收为 failed（结果正确）');
  ok(`① listTasksAsync 等 tasks 锁 ${waited}ms，期间心跳 ${hb.ticks} 次 → 回收路径未冻结`);
  holder.kill('SIGKILL');
  await sleep(50);
}

// ===========================================================================
// ④ CLI 同步版回归：pause/remove/list/patchTask/saveTaskStateMerge 仍同步返回
// ===========================================================================
{
  const home = freshHome('cli-sync');
  seedSchedule(home);
  const list = S.listSchedules(home);
  assert.ok(Array.isArray(list) && !(list instanceof Promise), '④ CLI：listSchedules 必须同步返回数组（不是 Promise）');
  assert.equal(list.length, 1, '④ CLI：listSchedules 必须看到刚写入的任务');

  const paused = S.pauseSchedule(home, SCHEDULE_ID);
  assert.equal(typeof paused, 'boolean', '④ CLI：pauseSchedule 必须同步返回 boolean');
  assert.equal(paused, true, '④ CLI：pauseSchedule 必须成功');
  assert.equal(S.readSchedule(home, SCHEDULE_ID)?.status, 'paused', '④ CLI：pause 后状态必须是 paused');

  const removed = S.removeSchedule(home, SCHEDULE_ID);
  assert.equal(typeof removed, 'boolean', '④ CLI：removeSchedule 必须同步返回 boolean');
  assert.equal(removed, true, '④ CLI：removeSchedule 必须成功');
  assert.equal(S.readSchedule(home, SCHEDULE_ID), null, '④ CLI：remove 后任务文件必须消失');
  ok('④ CLI 同步版行为不变：list / pause / remove 同步返回且结果正确');

  // tasks.patchTask（CLI/worker 用）仍同步返回任务对象
  fs.mkdirSync(T.tasksDir(home), { recursive: true });
  T.writeTask(home, { id: 'taskaaaa', status: 'running', question: 'x', startedAt: Date.now(), pid: null, text: '', error: '' });
  const patched = T.patchTask(home, 'taskaaaa', { status: 'done' });
  assert.ok(patched && !(patched instanceof Promise), '④ CLI：patchTask 必须同步返回任务对象');
  assert.equal(patched.status, 'done', '④ CLI：patchTask 必须写入新状态');
  const listed = T.listTasks(home);
  assert.ok(Array.isArray(listed) && !(listed instanceof Promise), '④ CLI：listTasks 必须同步返回数组');
  ok('④ CLI 同步版行为不变：patchTask / listTasks 同步返回任务对象');

  // task-state 同步合并写（CLI/REPL 用）仍返回 {ok}
  const saved = TS.saveTaskStateMerge('cli-regression', { goal: 'g', artifacts: ['a'], progress: 'p', status: 'cap', updatedAt: Date.now() });
  assert.ok(saved && !(saved instanceof Promise), '④ CLI：saveTaskStateMerge 必须同步返回结果对象');
  assert.equal(saved.ok, true, '④ CLI：saveTaskStateMerge 必须写成功');
  ok('④ CLI 同步版行为不变：saveTaskStateMerge 同步返回 {ok:true}');
}

// ===========================================================================
// ⑥ 工具执行路径（audit）：持 audit.jsonl.lock 时 writeAuditAsync 不冻结、锁后写入正确
// ===========================================================================
{
  const home = freshHome('async-audit');
  process.env.MINGDAO_HOME = home;
  const lockPath = AUDIT.auditFile() + '.lock';
  const holder = await startLockHolder(lockPath, 2200);
  const hb = startHeartbeat();
  const t0 = Date.now();
  try {
    await AUDIT.writeAuditAsync({ at: Date.now(), session: 's', model: 'm', tool: 'read', ok: true });
  } finally {
    hb.stop();
  }
  const waited = Date.now() - t0;
  assert.ok(waited >= 1500, `⑥ 前提：writeAuditAsync 必须真的等到审计锁释放（实际 ${waited}ms）`);
  assert.ok(hb.ticks >= 15, `⑥ 工具执行路径的审计等待期间事件循环不得冻结（实际 ${hb.ticks} 次 / ${waited}ms）`);
  const entries = AUDIT.listAudit(10);
  assert.equal(entries.length, 1, `⑥ 锁释放后审计必须真的落盘（实际 ${entries.length} 条）`);
  assert.equal(entries[0].tool, 'read', '⑥ 落盘内容必须与调用一致');
  // CLI 同步版回归：writeAudit 仍同步写、不返 Promise
  const syncRet = AUDIT.writeAudit({ at: Date.now(), session: 's', model: 'm', tool: 'ls', ok: true });
  assert.ok(!(syncRet instanceof Promise), '⑥ CLI：writeAudit 不得变成 async（同步调用方不 await）');
  assert.equal(AUDIT.listAudit(10).length, 2, '⑥ CLI：writeAudit 必须同步落盘');
  ok(`⑥ writeAuditAsync 等审计锁 ${waited}ms，期间心跳 ${hb.ticks} 次；CLI 同步版仍可用`);
  holder.kill('SIGKILL');
  process.env.MINGDAO_HOME = baseHome;
  await sleep(50);
}

// ===========================================================================
// ⑦ 聊天收尾路径（cachestats）：持锁时 recordUsageAsync 不冻结、锁后计费落盘正确
// ===========================================================================
{
  const home = freshHome('async-cachestats');
  process.env.MINGDAO_HOME = home;
  const lockPath = CACHE.cacheStatsFile() + '.lock';
  const holder = await startLockHolder(lockPath, 2200);
  const hb = startHeartbeat();
  const t0 = Date.now();
  try {
    await CACHE.recordUsageAsync('deepseek-chat', { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 90 });
  } finally {
    hb.stop();
  }
  const waited = Date.now() - t0;
  assert.ok(waited >= 1500, `⑦ 前提：recordUsageAsync 必须真的等到费用锁释放（实际 ${waited}ms）`);
  assert.ok(hb.ticks >= 15, `⑦ 聊天收尾路径的计费等待期间事件循环不得冻结（实际 ${hb.ticks} 次 / ${waited}ms）`);
  const rows = CACHE.listCacheStats(10);
  assert.equal(rows.length, 1, `⑦ 锁释放后必须真的写出 1 条用量（实际 ${rows.length} 条）`);
  assert.equal(rows[0].model, 'deepseek-chat', '⑦ 落盘 model 必须正确');
  assert.equal(rows[0].prompt, 100, '⑦ 落盘 prompt 必须正确（不是空账）');
  // CLI/worker 同步版回归
  const syncRet = CACHE.recordUsage('deepseek-chat', { prompt_tokens: 1, completion_tokens: 1 });
  assert.ok(syncRet && typeof syncRet === 'object' && !(syncRet instanceof Promise), '⑦ CLI：recordUsage 必须同步返回结果对象');
  assert.equal(syncRet.ok, true, '⑦ CLI：recordUsage 必须写成功');
  assert.equal(CACHE.listCacheStats(10).length, 2, '⑦ CLI：recordUsage 必须同步落盘');
  ok(`⑦ recordUsageAsync 等费用锁 ${waited}ms，期间心跳 ${hb.ticks} 次；CLI 同步版仍可用`);
  holder.kill('SIGKILL');
  process.env.MINGDAO_HOME = baseHome;
  await sleep(50);
}

console.log(`\n请求路径锁回归：${passed} 项全部通过`);
try {
  fs.rmSync(baseHome, { recursive: true, force: true });
} catch {}
