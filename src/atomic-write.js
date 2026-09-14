// 原子写与跨进程互斥（质检 H3/H4：并发写地基）。
// 背景：守护进程、CLI、web 服务器同时写 ~/.mingdao 下同一批文件，
// 此前 read-modify-write 无锁 + 多进程共享固定 `target + '.tmp'` 临时名，
// 存在丢更新与"rename 到对方半截文件"的成体系隐患；config/credentials 等关键文件更是直写。
// 本模块提供两个原语：
//   1. atomicWriteFileSync —— tmp 名含 pid+随机后缀（跨进程绝不共名），写完 rename 原子替换；
//   2. withFileLockSync —— O_EXCL lockfile 互斥（带超时与陈旧锁回收），包裹读-改-写序列；
//   3. withFileLock —— **同一套语义的异步版**：等待期间 `await` 让出事件循环，不阻塞 WebUI。
//
// v0.6.2（自评 P2-7 的阻塞面）：同步版用 `Atomics.wait` 睡眠，**等待期间整个事件循环停摆**
// ——实测持锁方存活 2.6 秒时，一个 100ms 的定时器在锁返回前根本没触发。对常驻服务而言，
// 这意味着一次文件锁争用就会冻结所有并发会话/权限确认/SSE 流。因此新增异步版并把
// 「正好在请求路径上」的调用点迁过去（workspace 的 7 处）；同步版保留给纯同步调用链。
//
// 另有一处**必须先修**的隐患：原可重入判据是**进程级 Set**。同步临界区不会 yield，
// 所以一直没出事；但异步临界区**会** yield——此时另一个任务拿同一把锁会被误判成"可重入"
// 而**并发**进入临界区，读-改-写互相覆盖。现在用 AsyncLocalStorage 把可重入限定在
// **同一条调用链**内：并发任务各持各的集合，嵌套调用复用同一份。
// 零依赖：仅 node:fs / node:path / node:crypto / node:async_hooks / Atomics.wait / timers/promises。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleepAsync } from 'node:timers/promises';
import { procAlive } from './proc.js';

export function atomicWriteFileSync(/** @type {string} */ target, /** @type {string|Buffer} */ data, /** @type {any} */ options = {}) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, data, options);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

export function atomicWriteJsonSync(/** @type {string} */ target, /** @type {any} */ value, { mode = 0o600 } = {}) {
  atomicWriteFileSync(target, JSON.stringify(value, null, 2) + '\n', { mode });
}

// 极简互斥锁：O_EXCL 创建 lockfile；持锁期间执行 fn（同步/异步）；异常/完成释放。
// 进程崩溃遗留的陈旧锁自动回收，避免永久卡死。
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleepMs = (/** @type {number} */ ms) => Atomics.wait(sleepBuf, 0, 0, ms);

// 可重入集合按**调用链**隔离（见文件头注释：异步临界区会 yield，进程级 Set 会让并发任务互相穿透）
const lockScope = new AsyncLocalStorage();
/** @param {(held: Set<string>) => any} fn */
function runWithHeld(fn) {
  const held = lockScope.getStore();
  if (held) return fn(held); // 已在同一条调用链里：复用同一份，嵌套即"可重入"
  const fresh = new Set();
  return lockScope.run(fresh, () => fn(fresh));
}

/**
 * 尝试独占创建锁文件。EEXIST 表示别人持有（返回 false，由调用方决定等待或重试）；
 * 其它错误（权限/路径非法）**直接抛出**——那不是"有人在用"，装成争用只会掩盖真问题。
 * @param {string} lockPath
 */
function tryAcquire(lockPath) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** @param {string} lockPath */
function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {}
}

/**
 * 判断能否回收一把陈旧锁（返回 true = 调用方应立刻重试）。
 *
 * v0.6.2（P2-7）：陈旧判据是「**持有者 pid 已死**」优先，而不是只看 mtime：
 *   · 只看 mtime 会带来两个反向问题：① 崩溃后要白等满 staleMs 才允许回收（配小 timeout 就是死区）；
 *     ② 某个 fn 本身耗时超过 staleMs（大文件重写、慢盘）时，别人会把**仍然活着**的锁判成陈旧并回收
 *     ——互斥直接失效，且没有任何补救。
 *   · 锁内容本来就写着 {pid, at}，现成的判据要用上：持有者还活着（哪怕 fn 跑了很久）**绝不回收**。
 * 读不到持有者信息（老格式/内容损坏）时才退回「mtime 超过 staleMs」。
 * @param {string} lockPath @param {number} staleMs
 */
function reclaimIfStale(lockPath, staleMs) {
  let st;
  try {
    st = fs.statSync(lockPath);
  } catch {
    return true; // 锁文件刚被释放：立刻重试
  }
  let holderPid = 0;
  try {
    holderPid = Number(JSON.parse(fs.readFileSync(lockPath, 'utf8'))?.pid) || 0;
  } catch {}
  const holderAlive = holderPid > 0 ? procAlive(holderPid) : null;
  const reclaimable = holderAlive === false || (holderAlive === null && Date.now() - st.mtimeMs > staleMs);
  if (!reclaimable) return false;
  // TOCTOU 防护（OfficeACE 报告）：unlink 前读锁内容并二次 stat 比对，
  // 防两个进程同时判定陈旧、后者误删前者刚创建的新锁（互斥失效）
  try {
    const before = fs.readFileSync(lockPath, 'utf8');
    const st2 = fs.statSync(lockPath);
    if (st2.mtimeMs === st.mtimeMs && before === fs.readFileSync(lockPath, 'utf8')) {
      fs.unlinkSync(lockPath);
    }
  } catch {}
  return true; // 无论是否回收成功都重试一次（若锁刚被他人更新则继续等待）
}

// 锁的两个时间参数（v0.6.2 依实测重新定过）：
//
// ① **必须 timeoutMs > staleMs**。曾是 5000/15000——等待方 5 秒就抛超时，而陈旧锁要 15 秒才
//    允许回收，中间 10 秒是纯**死区**：持锁方一旦崩溃，这段内所有写方必然全部失败。
// ② 现在取 **5000 / 4000**：死区没了，且**等锁的最坏冻结从 20 秒降到 5 秒**。
//    依据是实测（本机）：纯状态的临界区极短——小文件读-改-写 **0.13ms**，
//    连最重的 cache-stats 轮转（1.43MB / 2 万行解析 + 重写 1 万行）也只有 **6ms**。
//    5 秒是实测最坏值的约 800 倍，正常争用绝不会误判超时；**只有**「持有者活着但卡死」
//    或「锁内容读不出 pid 且超过 staleMs」才会等这么久。
// ③ 两个值都可用环境变量覆盖，便于诊断与测试（例如调小 staleMs 以便立刻回收陈旧锁）。
const ENV_TIMEOUT = Number(process.env.MINGDAO_LOCK_TIMEOUT_MS);
const ENV_STALE = Number(process.env.MINGDAO_LOCK_STALE_MS);
const DEFAULT_TIMEOUT_MS = Number.isFinite(ENV_TIMEOUT) && ENV_TIMEOUT > 0 ? ENV_TIMEOUT : 5000;
const DEFAULT_STALE_MS = Number.isFinite(ENV_STALE) && ENV_STALE > 0 ? ENV_STALE : 4000;

/**
 * 锁超时的统一文案：**说清锁文件在哪、怎么看持有者、什么时候可以删**。
 * 只报一句"获取文件锁超时"的话，用户除了重试什么也做不了。
 * @param {string} lockPath @param {number} timeoutMs
 */
function lockTimeoutError(lockPath, timeoutMs) {
  return new Error(
    `获取文件锁超时（${(timeoutMs / 1000).toFixed(1)} 秒，${lockPath}）：可能有其他进程长时间占用或已卡死。\n` +
      `  排查：查看该 .lock 文件内容（形如 {"pid":123,"at":…}），确认那个 pid 是否还活着；` +
      `若不是活着的 mingdao 进程，删除该文件后重试即可（陈旧锁也会在 ${DEFAULT_STALE_MS / 1000} 秒后自动回收）。`
  );
}

export function withFileLockSync(/** @type {string} */ lockPath, /** @type {() => any} */ fn, { timeoutMs = DEFAULT_TIMEOUT_MS, staleMs = DEFAULT_STALE_MS } = {}) {
  return runWithHeld((held) => {
    // 可重入：同一条调用链内已持该锁 → 直接执行，不再二次抢锁
    if (held.has(lockPath)) return fn();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const t0 = Date.now();
    for (;;) {
      // v0.4.7：区分「抢锁阶段」与「执行 fn 阶段」。此前 fn 自身抛出的 EEXIST 也会落进下方的
      // 锁重试分支，而 finally 已释放锁 → 重抢成功后再次执行 fn → 再次抛出 → **同步死循环**
      // （100% CPU，连超时分支都不可达）。acquiring 在 fn 开始执行前置 false。
      let acquiring = true;
      try {
        if (!tryAcquire(lockPath)) {
          const e = /** @type {any} */ (new Error('EEXIST'));
          e.code = 'EEXIST';
          throw e;
        }
        held.add(lockPath);
        acquiring = false; // 锁已持有：此后 fn 的任何异常都不得进入锁重试分支
        try {
          return fn();
        } finally {
          held.delete(lockPath);
          releaseLock(lockPath);
        }
      } catch (err) {
        if (!acquiring) throw err; // fn 自身的异常绝不进入锁重试
        if (/** @type {any} */ (err).code !== 'EEXIST') throw err;
        if (reclaimIfStale(lockPath, staleMs)) continue;
        if (Date.now() - t0 > timeoutMs) {
          throw lockTimeoutError(lockPath, timeoutMs);
        }
        sleepMs(25);
      }
    }
  });
}

/**
 * 异步版互斥：语义与 withFileLockSync **完全一致**（同一套 tryAcquire / reclaimIfStale /
 * 可重入规则、同样的超时与错误文案），唯一区别是等待时 `await sleepAsync()` —— 让出事件循环，
 * 因此**不会冻结 WebUI**。事件循环敏感的调用点（请求路径）应当用它。
 *
 * 为什么值得单独一个函数而不是把同步版改成异步：调用链里不少地方本身就是同步的
 * （CLI 一次性命令、调度守护进程内部的读-改-写），强行异步化会把 async 传染到 24 个调用点，
 * 回归风险大于收益。做法是**逐个判断**：请求路径上的迁移，纯同步链保留同步版。
 * @param {string} lockPath @param {() => any} fn
 */
export async function withFileLock(/** @type {string} */ lockPath, /** @type {() => any} */ fn, { timeoutMs = DEFAULT_TIMEOUT_MS, staleMs = DEFAULT_STALE_MS, pollMs = 25 } = {}) {
  return runWithHeld(async (held) => {
    if (held.has(lockPath)) return fn();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const t0 = Date.now();
    for (;;) {
      if (tryAcquire(lockPath)) {
        held.add(lockPath);
        try {
          return await fn();
        } finally {
          // 注意：这里必须放在 try/finally 里而不是靠外层 catch——
          // fn 的异常要原样抛出，绝不能被误当成"抢锁失败"而重跑临界区
          held.delete(lockPath);
          releaseLock(lockPath);
        }
      }
      if (reclaimIfStale(lockPath, staleMs)) continue;
      if (Date.now() - t0 > timeoutMs) {
        throw lockTimeoutError(lockPath, timeoutMs);
      }
      await sleepAsync(pollMs);
    }
  });
}

/** 同步/异步锁的默认超时与陈旧阈值（导出供诊断与测试断言「上限有界」）。 */
export function lockDefaults() {
  return { timeoutMs: DEFAULT_TIMEOUT_MS, staleMs: DEFAULT_STALE_MS };
}
