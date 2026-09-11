// 任务队列与调度：定时任务（一次性/周期）与依赖编排（after/链式）。
// 架构（评估 P3-5 单守护进程调度器）：一个 schedule-daemon 进程监督全部调度任务——
// 守护进程内以协程运行每任务的 runSleeper 等待/执行逻辑，到期启动 worker（复用 mingdao run
// 的独立进程机制）；状态落盘 <home>/schedule/<id>.json，daemon.pid 防重复。
// 旧式逐任务 sleeper（schedule-worker）保留为 daemon 启动失败时的兜底。
// 命令族：mingdao schedule add/list/remove/pause/resume/chain；tasks/run 触发时自动 reconcile 补挂到期任务（重启自愈）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startTask, readTask, killTask, patchTask, taskWorkerAlive } from './tasks.js';
import { procAlive, pidOwnedBy } from './proc.js';

function isRunningTask(/** @type {any} */ home, /** @type {any} */ taskId) {
  const t = readTask(home, taskId);
  return Boolean(t && t.status === 'running');
}

const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url));

import { isPeakHour, deferToOffpeak } from './pricing.js';
import { atomicWriteFileSync, withFileLockSync } from './atomic-write.js';

export function scheduleDir(/** @type {any} */ home) {
  return path.join(home, 'schedule');
}

export function parseInterval(/** @type {any} */ s) {
  const m = /^(\d+)(s|m|h|d)$/.exec(String(s).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = /** @type {Record<string, number>} */ ({ s: 1000, m: 60000, h: 3600000, d: 86400000 })[m[2]];
  if (!(n > 0)) return null;
  return n * unit;
}

// 解析 --at：'YYYY-MM-DD HH:MM' 或 'HH:MM'（今天；已过则明天）
export function parseAt(/** @type {any} */ s) {
  const t = String(s).trim();
  const full = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(t);
  if (full) {
    const d = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4]), Number(full[5]));
    // 质检 L3：Date 对非法日期（如 2026-02-30）会静默回滚成 3 月——round-trip 校验拒绝
    if (d.getFullYear() === Number(full[1]) && d.getMonth() === Number(full[2]) - 1 && d.getDate() === Number(full[3]) && !isNaN(d.getTime())) {
      return d.getTime();
    }
    return null;
  }
  const hm = /^(\d{2}):(\d{2})$/.exec(t);
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

export function listSchedules(/** @type {any} */ home) {
  const dir = scheduleDir(home);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j && j.id) out.push(j);
    } catch {}
  }
  return out.sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0));
}

function isValidScheduleId(/** @type {any} */ id) {
  return typeof id === 'string' && /^[a-z0-9]+$/.test(id) && id.length >= 2 && id.length <= 40;
}

export function readSchedule(/** @type {any} */ home, /** @type {any} */ id) {
  if (!isValidScheduleId(id)) return null; // 防 id 路径穿越
  try {
    return JSON.parse(fs.readFileSync(path.join(scheduleDir(home), id + '.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function writeSchedule(/** @type {any} */ home, /** @type {any} */ job) {
  if (!isValidScheduleId(job?.id)) return null;
  fs.mkdirSync(scheduleDir(home), { recursive: true });
  const target = path.join(scheduleDir(home), job.id + '.json');
  atomicWriteFileSync(target, JSON.stringify(job, null, 2) + '\n'); // 质检 H4：tmp 名含 pid+随机，杜绝跨进程共名
  return job;
}

/** 新建调度任务；after: 依赖的任务 ID（全部成功后才启动，任一失败则跳过） */
export function addSchedule(/** @type {any} */ home, /** @type {any} */ question, /** @type {any} */ { at, every, after, permission, model, cwd, anchor, offpeak }) {
  const id = 'sc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const interval = every != null ? parseInterval(every) : null;
  const afterList = Array.isArray(after) ? after.filter(Boolean).map(String) : after ? String(after).split(',').map((x) => x.trim()).filter(Boolean) : [];
  const hasAfter = afterList.length > 0 || (after !== undefined && after !== null);
  if (at == null && interval == null && !hasAfter) return { error: '需要 --at、--every 或 --after 之一' }; // 质检 L2：hasAfter 已蕴含后两子条件
  if (at != null && parseAt(at) == null) return { error: `无法解析时间 "${at}"（格式：YYYY-MM-DD HH:MM 或 HH:MM）` };
  if (every != null && interval == null) return { error: `无法解析周期 "${every}"（格式：<数字>s|m|h|d）` };
  let nextRunAt = null;
  if (at != null) nextRunAt = parseAt(at);
  else if (interval != null) {
    if (anchor) {
      const a = parseAt(anchor);
      if (a == null) return { error: `无法解析每日锚点 "${anchor}"（格式 HH:MM）` };
      nextRunAt = a;
      while (nextRunAt <= Date.now()) nextRunAt += interval;
    } else {
      nextRunAt = Date.now() + interval;
    }
  } else {
    // 仅依赖或空依赖（链头）：立即触发，由 sleeper 按依赖/即时逻辑处理
    nextRunAt = Date.now();
  }
  const job = {
    id,
    status: 'pending',
    kind: interval != null ? 'every' : at != null ? 'once' : 'after',
    question: String(question).slice(0, 300),
    interval: interval || null,
    anchor: anchor || null,
    after: afterList,
    permission: permission || null,
    model: model || null,
    cwd: cwd || process.cwd(),
    nextRunAt,
    lastRunAt: null,
    lastTaskId: null,
    runs: 0,
    pid: null,
    createdAt: Date.now(),
    note: offpeak ? '避峰：高峰时段自动顺延到最近闲时（12:00 / 18:00）执行' : '',
    offpeak: Boolean(offpeak),
  };
  writeSchedule(home, job);
  if (!daemonAlive(home)) spawnDaemon(home); // 单守护进程监督（评估 P3-5）
  return { id, job };
}

// 质检 H2（pause 失效确定性回归）：runOnce 返回后的状态决策抽为纯函数——
// 用户在执行期间 pause/remove 的指令（paused/failed/文件已删）绝不被 pending 覆盖；
// 连续失败 3 次熔断；否则排下一次（锚点对齐避免逐日漂移）。
export function postRunStatus(/** @type {any} */ cur2, /** @type {any} */ result) {
  if (!cur2) return null;
  if (cur2.status === 'paused' || cur2.status === 'failed') return null;
  if (result !== 'done' && (cur2.consecutiveFailures || 0) >= 3) {
    return { status: 'failed', note: '连续失败 3 次已停止重试：请检查 API Key / 模型 / 网络（mingdao schedule list 查看历史）' };
  }
  const next = cur2.anchor ? nextAnchorAfter(cur2.anchor, cur2.interval) || Date.now() + cur2.interval : Date.now() + cur2.interval;
  return { status: 'pending', nextRunAt: next };
}

export function removeSchedule(/** @type {any} */ home, /** @type {any} */ id) {
  // 质检 H3：读-改-写序列加锁，与 sleeper 循环的状态写互斥（防丢更新）
  return withFileLockSync(path.join(scheduleDir(home), '.lock'), () => {
    const job = readSchedule(home, id);
    if (!job) return false;
    if (job.pid) {
      const owned = pidOwnedBy(job.pid, id); // 质检 M11：cmdline 含调度 id 才 kill
      if (owned === true) { // 非 Linux/无法校验（null）不盲杀（CodeBuddy 报告：PID 复用误杀风险）
        try {
          process.kill(job.pid, 'SIGTERM');
        } catch {}
      }
    }
    // 正在跑的 worker 同步停止，避免成孤儿继续执行
    // P0-2（v0.4.5）：killTask 失败不应阻断「删除」这一更强用户意图——包 try/catch 保证删除照常
    try {
      if (job.lastTaskId && isRunningTask(home, job.lastTaskId)) killTask(home, job.lastTaskId);
    } catch {}
    try {
      fs.unlinkSync(path.join(scheduleDir(home), id + '.json'));
    } catch {}
    return true;
  });
}

export function pauseSchedule(/** @type {any} */ home, /** @type {any} */ id) {
  // 质检 H3：读-改-写序列加锁（pause 与 sleeper 的 postRunStatus 写互斥，杜绝 pause 被覆盖）
  return withFileLockSync(path.join(scheduleDir(home), '.lock'), () => {
    const job = readSchedule(home, id);
    if (!job) return false;
    if (job.pid) {
      const owned = pidOwnedBy(job.pid, id); // 质检 M11：cmdline 含调度 id 才 kill
      if (owned === true) { // 非 Linux/无法校验（null）不盲杀（CodeBuddy 报告：PID 复用误杀风险）
        try {
          process.kill(job.pid, 'SIGTERM');
        } catch {}
      }
    }
    // P0-2（v0.4.5）：killTask 失败不应阻断「暂停」的状态写
    try {
      if (job.lastTaskId && isRunningTask(home, job.lastTaskId)) killTask(home, job.lastTaskId);
    } catch {}
    writeSchedule(home, { ...job, status: 'paused', pid: null, lastTaskId: null });
    return true;
  });
}

export function resumeSchedule(/** @type {any} */ home, /** @type {any} */ id) {
  // 评估 6.3（v0.4.3）：读-改-写序列加锁，与 remove/pause 及 sleeper 状态写互斥（防丢更新）
  return withFileLockSync(path.join(scheduleDir(home), '.lock'), () => {
    const job = readSchedule(home, id);
    if (!job || job.status !== 'paused') return false;
    let next = job.nextRunAt;
    if (job.kind === 'every') {
      next = job.anchor ? nextAnchorAfter(job.anchor, job.interval) || Date.now() + job.interval : Date.now() + job.interval;
    } else if (job.kind === 'once') {
      if (next && next <= Date.now()) next = Date.now() + 30000; // 已过期的一次性任务恢复后 30s 执行
    } else next = Date.now();
    const nextJob = { ...job, status: 'pending', nextRunAt: next };
    writeSchedule(home, nextJob);
    // 审计修复：守护进程在时只更新状态交给 daemon 接管；否则旧式 sleeper 兜底（避免双跑）
    if (process.env.MINGDAO_NO_DAEMON === '1' || !daemonAlive(home)) spawnSleeper(home, nextJob);
    return true;
  });
}

// 每日锚点：锚点时刻（HH:MM）对齐到 now 之后的最近一次
function nextAnchorAfter(/** @type {any} */ anchor, /** @type {any} */ interval) {
  const a = parseAt(anchor);
  if (a == null) return null;
  let n = a;
  while (n <= Date.now()) n += interval;
  return n;
}

// 链式编排：A→B→C，后者依赖前者成功
export function chainSchedules(/** @type {any} */ home, /** @type {any} */ questions, opts = {}) {
  const ids = [];
  let prev = null;
  for (const q of questions) {
    const after = prev ? [prev] : [];
    const r = addSchedule(home, q, { ...opts, after });
    if (r.error) return r;
    ids.push(r.id);
    prev = r.id;
  }
  return { ids };
}

export function sleeperAlive(/** @type {any} */ pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnSleeper(/** @type {any} */ home, /** @type {any} */ job) {
  const child = spawn(process.execPath, [CLI_PATH, 'schedule-worker', job.id], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MINGDAO_HOME: home },
  });
  child.on('error', () => {}); // 质检 M12：error 事件必须有监听（ENOENT 等）
  writeSchedule(home, { ...job, pid: child.pid });
  child.unref();
  return child.pid;
}

// —— 单守护进程调度器（评估 P3-5）：一进程监督全部任务 ——
export function daemonPidFile(/** @type {any} */ home) {
  return path.join(scheduleDir(home), 'daemon.pid');
}
// pid 文件内容 "pid nonce"：校验进程存在 + 命令行含同一 nonce，防止陈旧 PID 被无关进程复用而误判（审计 P2-7）
// 质检 M11：kill 前校验 PID 归属（命令行含 needle 才动手，防 PID 复用误杀）
// v0.4.7（P3 T20）：实现移入 src/proc.js——原实现只认 /proc，macOS/Windows 上恒返回 null，
// 「归属校验」在这些平台静默失效。现在 Linux 走 /proc、其余平台回退 ps，语义不变（含 null）。
export { pidOwnedBy, procAlive };

export function daemonAlive(/** @type {any} */ home) {
  try {
    const [pidStr, nonce] = fs.readFileSync(daemonPidFile(home), 'utf8').trim().split(/\s+/);
    const pid = Number(pidStr);
    if (!pid || !nonce) return false;
    if (!procAlive(pid)) return false;
    // v0.4.7（P3 T20）：改用 proc.js 的跨平台归属校验——此前 macOS 上读不到 /proc，
    // 陈旧的 daemon.pid 只要 pid 被复用就会被判成「守护还活着」，新守护永不启动。
    if (pidOwnedBy(pid, nonce) === false) return false;
    return true;
  } catch {
    return false;
  }
}
export function stopDaemon(/** @type {any} */ home) {
  try {
    // pidfile 格式 "<pid> <nonce>"——必须取首段（此前整串 Number()=NaN，SIGTERM 永远不发，
    // 只删 pidfile → 孤儿 daemon 继续跑，新 daemon 再被拉起 → 双守护重复执行任务）
    const parts = String(fs.readFileSync(daemonPidFile(home), 'utf8')).trim().split(/\s+/);
    const pid = Number(parts[0]);
    const nonce = String(parts[1] || '');
    // v0.4.7：kill 前校验 PID 归属（nonce 命中才动手）——pidfile 可能陈旧，PID 被无关进程复用后
    // 直接 SIGTERM 会误杀。pidOwnedBy 返回 null（非 Linux 读不到 /proc）时按 best-effort 放行。
    const owned = nonce ? pidOwnedBy(pid, nonce) : true;
    if (pid && owned !== false) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
  } catch {}
  try {
    fs.rmSync(daemonPidFile(home), { force: true });
  } catch {}
  return true;
}
export function spawnDaemon(/** @type {any} */ home) {
  // v0.4.7（P2 T15）：必须在**跨进程锁内**完成「查活 → spawn → 写 pidfile」这一步。
  // 此前是「先 daemonAlive 判断、再 spawn、最后写 pidfile」，两个并发调用方都会看到「没有 daemon」
  // 而各自 spawn 一个：pidfile 被后者覆盖，前者成为无主的第二个 daemon，两者同时监督同一批任务
  // → 同一个定时任务被**并发执行两次**（有副作用的定时任务尤其危险）。
  withFileLockSync(daemonPidFile(home) + '.lock', () => {
    // 锁内复查：已有 daemon 就不再 spawn。返回值语义保持与旧版一致——
    // 「调用后存在可用 daemon」为 true（无论本次是否真的 spawn），调用方据此判断可用性。
    if (daemonAlive(home)) return;
    const nonce = Math.random().toString(36).slice(2, 10);
    const child = spawn(process.execPath, [CLI_PATH, 'schedule-daemon', nonce], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, MINGDAO_HOME: home },
    });
    child.on('error', () => {}); // 质检 M12：error 事件必须有监听（ENOENT 等）
    try {
      // 原子写（审计 workbuddy P3-4）：tmp+rename 与 writeSchedule 同款——崩溃不留半截 pid 文件
      const target = daemonPidFile(home);
      atomicWriteFileSync(target, `${child.pid} ${nonce}`);
    } catch {}
    child.unref();
  });
  return true;
}

// 重启自愈：有非终态任务且 daemon 不在 → 拉起单守护（失败才回退旧式逐任务 sleeper）
export function reconcileSchedules(/** @type {any} */ home) {
  const jobs = listSchedules(home);
  const hasPending = jobs.some((j) => j.status === 'pending' || j.status === 'running');
  if (!hasPending) return;
  if (daemonAlive(home) || process.env.MINGDAO_NO_DAEMON === '1') {
    if (process.env.MINGDAO_NO_DAEMON === '1') {
      // 兜底路径（旧式）
      for (const job of jobs) {
        if (job.status !== 'pending' && job.status !== 'running') continue;
        if (sleeperAlive(job.pid)) continue;
        if (job.lastTaskId && isRunningTask(home, job.lastTaskId)) continue;
        if (job.kind === 'after' || (job.nextRunAt && job.nextRunAt <= Date.now() + 5000)) spawnSleeper(home, job);
      }
    }
    return;
  }
  spawnDaemon(home);
}
// —— sleeper 主循环（schedule-worker 进程内运行）——
/**
 * 任务监督循环（每个调度任务一个协程）。
 * opts.shouldStop：可选回调——返回 true 时本协程立即退出（v0.4.7 用于「daemon 租约丢失」：
 * every 型任务是 `for(;;)` 常驻循环，不主动通知就会一直跑下去，旧 daemon 因此无法退出，
 * 与新 daemon 并跑同一批任务 = 重复执行）。
 * @param {any} home @param {any} id @param {{ shouldStop?: () => boolean }} [opts]
 */
export async function runSleeper(/** @type {any} */ home, /** @type {any} */ id, opts = {}) {
  const job = readSchedule(home, id);
  if (!job) return;
  const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : () => false;

  const wait = (/** @type {any} */ ms) => new Promise((r) => setTimeout(r, ms));

  // P1-15（v0.4.5）：标记 running 前加锁并复查 paused——此前锁外 writeSchedule({...cur,'running'})
  // 与 pauseSchedule 锁内写 paused 交错时，running 会覆盖 pause（任务继续触发，pause 语义失效）。
  const markRunning = () => withFileLockSync(path.join(scheduleDir(home), '.lock'), () => {
    const c = readSchedule(home, id);
    if (!c || c.status === 'paused') return false; // 已删除或已暂停：不覆盖、不再触发
    // v0.4.7（T15）：进入 running 的同时就写上宿主 pid。`status=running` 与「lastTaskId 落盘」
    // 之间存在一个窗口（要等 startTask 返回），期间另一个 daemon 的恢复分支会把它误判成
    // 「崩溃残留」→ 重置 pending → 并发重跑。带上 runnerPid 后，接管方能立刻判断「宿主还活着，等它」。
    writeSchedule(home, { ...c, status: 'running', runnerPid: process.pid });
    return true;
  });

  // 依赖检查：支持两种依赖——调度任务 id（chain 编排）或后台任务 id（mingdao run 输出）
  async function depsSatisfied(/** @type {any} */ deps) {
    for (const dep of deps) {
      const sch = readSchedule(home, dep);
      if (sch) {
        if (sch.status === 'done') continue;
        if (sch.status === 'failed' || sch.status === 'skipped' || sch.status === 'paused') return 'failed';
        return false; // pending / running
      }
      const t = readTask(home, dep);
      if (!t) return 'failed'; // 依赖任务不存在（拼错/已删）：判失败并报错，避免永续轮询
      if (t.status === 'running') return false;
      if (t.status !== 'done') return 'failed';
    }
    return true;
  }

  const runOnce = async () => {
    // 避峰（评估 A2/Kimi P-1）：高峰时段（北京工作日 9:00–12:00、14:00–18:00）
    // 顺延到最近闲时起点（12:00 / 18:00）执行，输入价省 50%
    if (job.offpeak && isPeakHour(new Date())) {
      const defer = deferToOffpeak(new Date());
      // P2-4（v0.4.5）：note 更新同样加锁 + 复查 paused（避免「读 curN 到写回之间 pause」被覆盖）
      withFileLockSync(path.join(scheduleDir(home), '.lock'), () => {
        const curN = readSchedule(home, id);
        if (curN && curN.status !== 'paused') writeSchedule(home, { ...curN, note: `避峰等待至北京时间 ${defer.toISOString().slice(11, 16)}（闲时起执行）` });
      });
      await wait(defer.getTime() - Date.now() + 2000);
      if (shouldStop()) return 'aborted'; // 睡醒后若已失去租约，直接放弃（避免接管方并跑）
    }
    if (job.after?.length) {
      const st = await depsSatisfied(job.after);
      if (st === false) return 'pending';
      if (st === 'failed') return 'skipped';
    }
    // 连续失败熔断（审计：右下角「失败：避峰任务」通知刷屏根因）——周期任务失败后按原周期
    // 无限重试且每次失败都弹系统通知；这里记录连续失败次数：重试轮次静默（quietNotify），
    // 连续 3 次失败由 every 主循环熔断停止
    // v0.4.7（P2 T14）：避峰等待可能长达数小时。醒来后必须复查任务是否已被 pause/remove——
    // 此前会照样 startTask：暂停的任务被执行、删除的任务留下孤儿 worker（与用户意图相反）。
    const beforeStart = readSchedule(home, id);
    if (!beforeStart || beforeStart.status === 'paused') return 'aborted';

    const prevFails = Number(readSchedule(home, id)?.consecutiveFailures) || 0;
    const task = startTask(home, job.question, {
      permission: job.permission || undefined,
      model: job.model || undefined,
      cwd: job.cwd || process.cwd(),
      quietNotify: prevFails >= 1,
    });
    // v0.4.7（P2 T14/T15）：**立刻**把「在跑的任务 id + 宿主 pid」写进 job（锁内）。
    // 此前只在跑完后才写 lastTaskId：这整个窗口内，另一个 daemon 看到 status=running 且
    // lastTaskId=null，会误判为「崩溃残留」→ 重置为 pending → 并发重跑同一任务；
    // 同时 pause/remove 也因为没有任务 id 可杀而无法停止在途运行。
    try {
      withFileLockSync(path.join(scheduleDir(home), '.lock'), () => {
        const curS = readSchedule(home, id);
        if (curS) writeSchedule(home, { ...curS, lastTaskId: task.id, runnerPid: process.pid });
      });
    } catch {}

    // 轮询 worker 状态直至结束（最长 2 小时）；超时清理 worker 防孤儿（审计 P2-8）
    let t = readTask(home, task.id);
    const deadline = Date.now() + 2 * 3600000;
    while (t && t.status === 'running' && Date.now() < deadline) {
      await wait(3000);
      t = readTask(home, task.id);
      // v0.4.7（P3 T20）：worker 进程已消失、状态却仍停在 running（被 SIGKILL / OOM / 系统休眠
      // 杀死，来不及写终态）。此前这里只会傻等到 2 小时上限——期间该调度任务占着 ->>running，
      // 用户看到的是「跑了两个小时」，实际早已没有进程在工作。改为立刻回收并跳出。
      if (t && t.status === 'running' && t.pid && !taskWorkerAlive(t)) {
        const age = Date.now() - (Number(t.startedAt) || Date.now());
        patchTask(home, task.id, {
          status: 'failed',
          error: 'worker 进程已消失（可能被系统终止）',
          durationMs: age,
        }, { terminal: true });
        t = readTask(home, task.id);
        break;
      }
    }
    if (t && t.status === 'running') {
      killTask(home, task.id);
      t = { ...t, status: 'timedout' };
    }
    const result = t?.status === 'done' ? 'done' : t?.status === 'timedout' ? 'timedout' : 'failed';
    // 审计（H3 + 自检 P2）：runOnce 收尾元数据读-改-写加锁——与 pause/remove（锁内写）跨进程互斥，
    // 杜绝「读 cur0 到写回之间用户 pause」被覆盖（毫秒级窗口，彻底起见与终态写同锁、同复查）。
    const wrote = withFileLockSync(path.join(scheduleDir(home), '.lock'), () => {
      const curL = readSchedule(home, id);
      if (!curL) return false; // 已删除：停止后续写入
      const historyL = [...(curL?.history || [])];
      historyL.push({
        taskId: task.id,
        status: t?.status || 'unknown',
        at: Date.now(),
        durationMs: t?.durationMs ?? null,
        text: (t?.text || t?.error || '').slice(0, 200),
      });
      if (historyL.length > 50) historyL.shift();
      writeSchedule(home, {
        ...curL,
        lastRunAt: Date.now(),
        lastTaskId: task.id,
        runnerPid: null, // v0.4.7：本轮已收尾，清掉宿主标记
        runs: (curL?.runs || 0) + 1,
        history: historyL,
        consecutiveFailures: result === 'done' ? 0 : prevFails + 1,
      });
      return true;
    });
    if (!wrote) return 'failed'; // 任务已被删除
    return result;
  };

  for (;;) {
    if (shouldStop()) return; // v0.4.7：租约丢失/被接管 → 协程立即退出
    const cur = readSchedule(home, id);
    if (!cur || cur.status === 'paused') return;
    const now = Date.now();
    if (cur.kind === 'every') {
      if (!cur.nextRunAt || cur.nextRunAt > now) {
        await wait(Math.min(Math.max((cur.nextRunAt || now) - now, 1000), 60000));
        continue;
      }
      if (!markRunning()) return; // P1-15：标记 running 前复查 paused（被暂停则直接退出）
      const result = await runOnce();
      // 质检 H3：状态读-改-写加锁（与 pause/remove 互斥，防丢更新）
      const nextState = withFileLockSync(path.join(scheduleDir(home), '.lock'), () => {
        const cur2 = readSchedule(home, id);
        if (!cur2) return null;
        const ns = postRunStatus(cur2, result);
        if (!ns) return null;
        writeSchedule(home, { ...cur2, ...ns });
        return ns;
      });
      if (!nextState) return;
      if (nextState.status === 'failed') return; // 熔断后退出主循环（与旧行为一致）
    } else if (cur.kind === 'once') {
      if (cur.nextRunAt && cur.nextRunAt > now) {
        await wait(Math.min(cur.nextRunAt - now, 60000));
        continue;
      }
      if (!markRunning()) return; // P1-15：标记 running 前复查 paused
      const result = await runOnce();
      // 评估 6.4（v0.4.3）+ P2-4（v0.4.5）：once 最终状态读-改-写加锁，且 paused 不覆盖——
      // 用户执行期间 pause（cur2.status==='paused'）绝不被 done/failed 覆盖（every 经 postRunStatus 有防护，此处补齐）
      withFileLockSync(path.join(scheduleDir(home), '.lock'), () => {
        const cur2 = readSchedule(home, id);
        if (!cur2 || cur2.status === 'paused') return;
        writeSchedule(home, { ...cur2, status: result });
      });
      return;
    } else {
      // after：轮询依赖，满足即执行一次后结束；任一依赖失败则跳过
      const st = await depsSatisfied(cur.after || []);
      if (st === false) {
        await wait(3000);
        continue;
      }
      if (st === 'failed') {
        // P2-4（v0.4.5）：终态写加锁 + 复查 paused（依赖失败判 skipped 也不得覆盖 pause）
        withFileLockSync(path.join(scheduleDir(home), '.lock'), () => {
          const c2 = readSchedule(home, id);
          if (!c2 || c2.status === 'paused') return;
          writeSchedule(home, { ...c2, status: 'skipped' });
        });
        return;
      }
      if (!markRunning()) return; // P1-15：标记 running 前复查 paused
      const result = await runOnce();
      // 评估 6.4（v0.4.3）+ P2-4（v0.4.5）：after 最终状态读-改-写加锁，且 paused 不覆盖
      withFileLockSync(path.join(scheduleDir(home), '.lock'), () => {
        const cur2 = readSchedule(home, id);
        if (!cur2 || cur2.status === 'paused') return;
        writeSchedule(home, { ...cur2, status: result });
      });
      return;
    }
  }
}

export function formatScheduleRow(/** @type {any} */ j) {
  const mark = j.status === 'pending' ? '⏳' : j.status === 'running' ? '▶' : j.status === 'paused' ? '⏸' : j.status === 'done' ? '✓' : '✖';
  const when =
    j.kind === 'every'
      ? `每 ${j.interval / (j.interval >= 86400000 ? 86400000 : j.interval >= 3600000 ? 3600000 : j.interval >= 60000 ? 60000 : 1000)}${j.interval >= 86400000 ? 'd' : j.interval >= 3600000 ? 'h' : j.interval >= 60000 ? 'm' : 's'}`
      : j.kind === 'once'
        ? new Date(j.nextRunAt || 0).toLocaleString()
        : `依赖 ${j.after.join(',')}`;
  const last = j.lastRunAt ? new Date(j.lastRunAt).toLocaleTimeString() : '';
  return `${mark} ${j.id}  ${j.status.padEnd(7)}  ${when.padEnd(20)}  已运行 ${j.runs} 次  ${last}  ${j.question}`;
}
