// 多会话后台任务面板：mingdao run 启动独立 worker 子进程，状态落盘 <mingdao-home>/tasks/<id>.json。
// 命令族：mingdao run "<任务>" · mingdao tasks · tasks watch · tasks kill <id>
// worker 复用 Agent 核心（权限/模型/MCP/自动标题/会话持久化全部生效）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { relativeTime } from './session.js';
import { atomicWriteFileSync, atomicWritePrivateSync, withFileLockSync } from './atomic-write.js';
import { procAlive, pidOwnedBy, spawnOpts } from './proc.js';

const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url));

export function tasksDir(/** @type {any} */ home) {
  return path.join(home, 'tasks');
}

/**
 * 列出后台任务（按启动时间倒序）。
 * v0.4.7（P3 T20）：默认先回收僵尸任务（running 但进程已消失），否则面板会永远转圈。
 * @param {any} home
 * @param {{reap?: boolean}} [opts]
 */
export function listTasks(/** @type {any} */ home, { reap = true } = {}) {
  if (reap) {
    try {
      reapTasks(home, {});
    } catch {} // 回收失败不得影响「看列表」这件正事
  }
  const dir = tasksDir(home);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (t && t.id) out.push(t);
    } catch {}
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

export function readTask(/** @type {any} */ home, /** @type {any} */ id) {
  if (!isValidTaskId(id)) return null; // 防 id 路径穿越（id 直接拼进文件路径）
  try {
    return JSON.parse(fs.readFileSync(path.join(tasksDir(home), id + '.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function writeTask(/** @type {any} */ home, /** @type {any} */ task) {
  fs.mkdirSync(tasksDir(home), { recursive: true, mode: 0o700 });
  // 原子写：先临时文件再改名，避免崩溃留下半截 JSON
  const target = path.join(tasksDir(home), task.id + '.json');
  atomicWritePrivateSync(target, JSON.stringify(task, null, 2) + '\n'); // 质检 H4：tmp 名含 pid+随机；0600（含提问原文）
}

export function isValidTaskId(/** @type {any} */ id) {
  return typeof id === 'string' && /^[a-z0-9]+$/.test(id) && id.length >= 4 && id.length <= 40;
}

export function startTask(/** @type {any} */ home, /** @type {any} */ question, { permission, model, cwd, offpeak, quietNotify } = /** @type {any} */ ({})) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + process.pid.toString(36);
  const task = {
    id,
    status: 'running',
    question: String(question).slice(0, 80),
    startedAt: Date.now(),
    pid: null,
    session: null,
    text: '',
    usage: null,
    durationMs: null,
    error: '',
    note: offpeak ? '避峰：高峰时段顺延到最近闲时（12:00 / 18:00）执行（省 50%）' : '',
  };
  writeTask(home, task);
  const args = [CLI_PATH, 'run-worker', id, '--question', String(question)];
  if (permission) args.push('--permission', permission);
  if (model) args.push('--model', model);
  if (offpeak) args.push('--offpeak');
  const child = spawn(process.execPath, args, {
    cwd: cwd || process.cwd(),
    detached: true,
    stdio: 'ignore',
    // 连续失败的重试轮次静默：只保留首次失败的系统通知，避免右下角刷屏（审计）
    env: { ...process.env, MINGDAO_HOME: home, ...(quietNotify ? { MINGDAO_TASK_QUIET_NOTIFY: '1' } : {}) },
    ...spawnOpts(), // Windows：隐藏控制台（stdio 为 ignore，不依赖管道，保留 detached）
  });
  // 质检 M12：spawn 失败（ENOENT/ARG_MAX）必须有 error 监听，否则未捕获事件直接崩进程
  child.on('error', (err) => {
    try {
      patchTask(home, id, { status: 'failed', error: `worker 启动失败：${(/** @type {any} */ (err))?.message || err}`, durationMs: Date.now() - task.startedAt });
    } catch {}
  });
  task.pid = /** @type {any} */ (child.pid);
  writeTask(home, task);
  child.unref();
  return task;
}

/**
 * 读-改-写补丁（质检 H3：加锁，worker finish 与 CLI kill 跨进程互斥）。
 * @param {any} home
 * @param {any} id
 * @param {any} patch
 * @param {{terminal?: boolean}} [opts] terminal=true 表示这是 worker 的**终态**写入
 * @returns {any} 写入后的任务对象（任务已删除则为 null），调用方据此判断真实生效的状态
 */
export function patchTask(/** @type {any} */ home, /** @type {any} */ id, /** @type {any} */ patch, { terminal = false } = {}) {
  // 质检 H3：读-改-写加锁（worker finish 与 CLI kill 互斥，防 killed/done 互相覆盖）
  return withFileLockSync(path.join(tasksDir(home), '.lock'), () => {
    const t = readTask(home, id);
    if (!t) return null;
    /** @type {any} */
    const next = { ...t, ...patch };
    // v0.4.7（P3 T20）：用户的 kill 是**显式意图**，不能被 worker 迟到的终态写覆盖。
    // 竞态：kill 在 worker 收尾前落地（status=killed），worker 随后写 status=done →
    // 面板显示「已完成」，用户的停止动作静默失效。此处锁内复查：已是 killed 就保留 killed，
    // 只吸收 text/usage/session 等诊断字段（注明被停止时的实际产出）。
    if (terminal && t.status === 'killed' && patch.status && patch.status !== 'killed') {
      next.status = 'killed';
    }
    writeTask(home, next);
    return next;
  });
}

/**
 * 这个任务记录的 worker 是否**真的**还在跑（v0.4.7 P3 T20）。
 * 判据是「归属」而非单纯「存活」：worker 的 argv 里必然带着任务 id
 * （startTask 以 `cli.js run-worker <id> --question ...` 启动），于是
 *   true  → 还是我们那个 worker
 *   false → 进程已消失，**或** pid 已被无关进程复用——两种情况下我们的 worker 都不在了
 *   null  → 读不到命令行（既无 /proc 也无 ps）：退回存活判定，保守地当作还在跑
 * 比 procAlive 更准的一点：worker 被 SIGKILL 后会先进入僵尸态（命令行已空、但 pid 仍可收信号），
 * procAlive 会判「活着」而让任务继续卡在 running；归属校验此时已能给出 false。
 * 调度器与回收器共用此判据，避免「是否还在跑」出现两份会漂移的定义。
 * @param {any} t 任务对象
 */
export function taskWorkerAlive(/** @type {any} */ t) {
  if (!t || !t.pid) return false;
  const owned = pidOwnedBy(t.pid, t.id);
  if (owned === null) return procAlive(t.pid);
  return owned;
}

/**
 * 回收僵尸任务（v0.4.7 P3 T20）：worker 进程已消失、状态却仍停在 running 的任务。
 * 触发场景：worker 被 SIGKILL / OOM / 系统休眠杀死，来不及写终态。此前这类任务会
 * 永久停在 running——面板一直转圈，调度器更会为它空转到 2 小时上限才判超时。
 * @param {any} home
 * @param {{graceMs?: number}} [opts]
 * @returns {string[]} 被回收的任务 id
 */
export function reapTasks(/** @type {any} */ home, { graceMs = 10000 } = {}) {
  const out = [];
  const now = Date.now();
  for (const t of listTasks(home, { reap: false })) {
    if (!t || t.status !== 'running') continue;
    const age = now - (Number(t.startedAt) || 0);
    // 宽限期：startTask 先写 running(pid=null) 再 spawn 再补 pid，期间不该被误判
    if (age < graceMs) continue;
    if (t.pid) {
      if (taskWorkerAlive(t)) continue; // 还在跑
      const patch = { status: 'failed', error: 'worker 进程已消失（可能被系统终止）', durationMs: age };
      if (patchTask(home, t.id, patch)) out.push(t.id);
    } else if (age > 60000) {
      // spawn 都没成功留下 pid：超过 1 分钟仍未补上，判为启动失败
      if (patchTask(home, t.id, { status: 'failed', error: 'worker 未启动（未记录到进程号）', durationMs: age })) out.push(t.id);
    }
  }
  return out;
}

// v0.6.2（自评报告 P2-10）：SIGTERM 之后的**升级终止**。
// 原实现只发 SIGTERM 就立即置终态 `killed`：worker 若卡在长 LLM 请求、或被
// `process.on('SIGTERM')` 拦下、或处于同步阻塞，SIGTERM 不会让它退出——它继续跑、
// 继续改文件，而面板已显示「已停止」（假的"已停止"）。全仓此前没有任何超时升级逻辑。
const KILL_GRACE_MS = 2500;
let pendingKill = /** @type {Promise<string>|null} */ (null);

/** 终止整棵进程树。Windows 无进程组语义，用 taskkill /T /F 才杀得掉孙进程。 */
function killTree(/** @type {any} */ pid, /** @type {any} */ sig) {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    } catch {}
    return;
  }
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {}
  }
}

/**
 * 给进程一点时间自己退出；仍在跑就升级 SIGKILL。
 * 返回的 promise 在「进程确实消失」或「已升级 SIGKILL」后 resolve——
 * **不阻塞事件循环**（用定时器轮询，不用 Atomics.wait 同步等；本仓已把"阻塞事件循环"
 * 列为缺陷 P2-7，不能自己再犯）。
 * 定时器**刻意不 unref**：升级必须在进程退出前跑完，否则又回到"SIGTERM 发出去就不管了"。
 * 代价是短命进程会多活到升级结束（进程正常退出时约 100–200ms，真顽固的才吃满宽限期）——
 * 这正是"让停止真的生效"应付的成本。
 * @param {any} pid
 * @returns {Promise<string>} 'exited' | 'sigkilled'
 */
function escalateKill(/** @type {any} */ pid) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (!procAlive(pid)) return resolve('exited');
      if (Date.now() - started >= KILL_GRACE_MS) {
        killTree(pid, 'SIGKILL');
        return resolve('sigkilled');
      }
      setTimeout(tick, 100);
    };
    setTimeout(tick, 100);
  });
}

/**
 * 等本次 kill 的升级流程跑完。
 * **短命进程（CLI / REPL 单条命令）必须调用**：否则升级用的 setTimeout 会随进程退出丢失，
 * 又回到"SIGTERM 发出去就不管了"的老问题。长命进程（WebUI / daemon）不必调用。
 * @returns {Promise<string>} 'none' | 'exited' | 'sigkilled'
 */
export async function flushKillEscalation() {
  if (!pendingKill) return 'none';
  const p = pendingKill;
  pendingKill = null;
  try {
    return await p;
  } catch {
    return 'none';
  }
}

export function killTask(/** @type {any} */ home, /** @type {any} */ id) {
  // v0.6.2（P2-7 阻塞面）：进程操作全部移到锁**外**，临界区只剩状态读-改-写。
  //
  // 原实现把 killTaskInner 整个包在锁里，而它内部会：
  //   · pidOwnedBy() —— 非 Linux 上回退到**同步** execFileSync('ps')；
  //   · killTree()   —— Windows 上走**同步** spawnSync('taskkill')；
  // 于是临界区里夹着外部进程调用，持锁时间从毫秒级变成百毫秒级，**每个等锁的人都被拖住**。
  // 实测（本机）纯状态读-改-写约 0.13ms、最坏的 cache-stats 轮转也只有 6ms——
  // 也就是说，锁被长时间持有完全是自己把慢操作放进去造成的。
  //
  // 语义不变：状态写回仍在锁内（与 worker 的终态写互斥），P3 T20 的「killed 优先」保护
  // 仍在 patchTask 里；把进程操作提前到锁外不影响任何一条竞态路径的最终状态。
  const t = readTask(home, id);
  if (!t) return false;
  if (t.status === 'running' && t.pid) {
    // 质检 M11：cmdline 含任务 id 才 kill（防 PID 复用误杀无关进程）
    // v0.4.7（P3 T20）：改用 proc.js——原实现只认 /proc，macOS/Windows 上恒为 null，
    // 「归属校验」在这些平台静默失效（退化成「按 pid 存活即杀」，PID 复用即误杀）。
    const owned = pidOwnedBy(t.pid, id);
    // P0-3（v0.4.5）：owned===null（非 Linux 无 /proc，或无法读取）时降级为「按 pid 存活即杀」——
    // 此前 null 直接跳过，导致 macOS/Windows 上 kill 只改状态不杀进程、worker 继续跑完覆盖状态。
    // 任务 id 含随机 + 启动时 pid，PID 复用误杀概率极低，且任务 id 本就是用户显式指定的目标。
    if (owned === true || owned === null) {
      // worker 是 detached 进程（自成进程组）：杀整组，避免工具子进程成孤儿
      killTree(t.pid, 'SIGTERM');
      // 立即置终态（用户意图要立刻可见），但**同时**安排"仍在跑就 SIGKILL"的升级
      pendingKill = escalateKill(t.pid);
    }
  }
  // 状态写回：仍在跨进程锁内（只做读-改-写，毫秒级）
  return killTaskInner(home, id) !== null;
}
/** 临界区内的状态写回（进程部分见 killTask，已移到锁外） */
function killTaskInner(/** @type {any} */ home, /** @type {any} */ id) {
  const t = readTask(home, id);
  if (!t) return null;
  return patchTask(home, id, { status: 'killed', durationMs: t.durationMs ?? Date.now() - t.startedAt });
}

const MARK = { running: '▶', done: '✓', failed: '✖', killed: '■' };

export function formatTaskRow(/** @type {any} */ t) {
  const mark = /** @type {any} */ (MARK)[t.status] || '?';
  const elapsed =
    t.status === 'running'
      ? relativeTime(t.startedAt).replace('前', '')
      : t.durationMs != null
        ? `${(t.durationMs / 1000).toFixed(1)}s`
        : '';
  const session = t.session ? path.basename(t.session) : '';
  const note = t.note ? `（${t.note}）` : '';
  return `${mark} ${t.id}  ${elapsed.padEnd(6)}  ${session.padEnd(24)}  ${t.question}${note}`;
}
