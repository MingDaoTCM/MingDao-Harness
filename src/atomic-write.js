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
import { pidOwnedBy } from './proc.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleepAsync } from 'node:timers/promises';
import { procAlive } from './proc.js';

// ---------------------------------------------------------------------------
// 瞬时拒绝（Windows）与有界重试（v0.6.23，§3.86）
//
// 证据：CI Windows 腿的 BUG-068（8 个子进程并发 saveTaskStateMerge）曾出现 7/8、6/8，
// rerun 换运气；macOS/Linux 万条×5 轮、64 进程×5 轮 0 丢。子进程把 saveTaskStateMerge 的
// {ok:false} 丢进 stdio:'ignore' 后照常 exit 0，所以父进程只看到一个没有归因的差数。
// 复查后确认：丢更新不是原因，**瞬时拒绝被当成永久失败**才是——NTFS 上刚 unlink 的
// `.lock` 仍处于 delete-pending 时 `open(…,'wx')` 会被拒 EACCES/EPERM；Defender/索引器
// 正在扫描刚写出的 `.tmp` 时 `rename` 会被拒 EACCES/EPERM/EBUSY。这两种都不是"权限配错"，
// 也不是"别人长期持锁"，而是**争用的一种**：等几十~几百毫秒就会自己消失。
//
// 所以把 EACCES/EPERM/EBUSY 与 EEXIST 一样纳入"等待 + 重试"，但**单独给 2 秒预算**：
//   · 初始 5ms：锁刚被 unlink 时 delete-pending 通常几个 tick 就清掉，早试能少等；
//   · 每次 ×2、封顶 100ms：既不在前 100ms 里高频敲文件系统（杀软扫描时高频重试只会更糟），
//     又保证晚期的恢复延迟不超过 100ms；
//   · 总预算 2000ms：Windows 杀软/索引器的单文件扫描窗口在数十~数百 ms 量级，
//     2s 有约 10~100 倍余量；同时**有界**——真正的 ACL/只读目录问题不会把进程永久冻住，
//     也不会把一次保存拖成整个 WebUI 的几十秒卡顿（同步锁仍走 Atomics.wait）。
//   · EEXIST（确实有人在持锁）不适用这个 2s 预算：它继续走原来的 timeoutMs(5s)/staleMs(4s)。
// 预算耗尽时**原样抛出原始错误**（保留 errno/path），不折成"锁超时"——后者会把权限/杀软
// 问题伪装成死锁，用户按提示删锁也没用。
// ---------------------------------------------------------------------------
const TRANSIENT_DENY_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);
const TRANSIENT_RETRY_INITIAL_MS = 5;
const TRANSIENT_RETRY_MAX_MS = 100;
const TRANSIENT_RETRY_BUDGET_MS = 2000;

/** 某个 errno 是否属于「等一会儿可能自己好」的瞬时拒绝。 @param {any} code */
export function isTransientDenyCode(code) {
  return TRANSIENT_DENY_CODES.has(String(code || ''));
}

/** 退避参数（导出供诊断与测试断言「5–10ms 起 / 封顶 / 总预算有界」）。 */
export function retryDefaults() {
  return {
    initialMs: TRANSIENT_RETRY_INITIAL_MS,
    maxDelayMs: TRANSIENT_RETRY_MAX_MS,
    budgetMs: TRANSIENT_RETRY_BUDGET_MS,
    codes: [...TRANSIENT_DENY_CODES],
  };
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleepMs = (/** @type {number} */ ms) => Atomics.wait(sleepBuf, 0, 0, ms);

/**
 * 在 deadline 之前对瞬时拒绝做指数退避重试；非瞬时错误与预算耗尽都**原样抛出**。
 * deadline 由调用方传入：一次原子写的 write+rename 共享同一份预算，避免两段各等 2 秒。
 * @template T @param {() => T} fn @param {number} deadline @returns {T}
 */
function retryTransientSync(fn, deadline) {
  let delay = TRANSIENT_RETRY_INITIAL_MS;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      if (!isTransientDenyCode(/** @type {any} */ (err)?.code)) throw err;
      const remain = deadline - Date.now();
      if (remain <= 0) throw err;
      sleepMs(Math.min(delay, remain));
      delay = Math.min(delay * 2, TRANSIENT_RETRY_MAX_MS);
    }
  }
}

export function atomicWriteFileSync(/** @type {string} */ target, /** @type {string|Buffer} */ data, /** @type {any} */ options = {}) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const deadline = Date.now() + TRANSIENT_RETRY_BUDGET_MS;
  try {
    // Windows：杀软/索引器短暂持有新建的 .tmp（EACCES/EPERM/EBUSY）或拒绝覆盖目标，都等一等再试。
    retryTransientSync(() => fs.writeFileSync(tmp, data, options), deadline);
    retryTransientSync(() => fs.renameSync(tmp, target), deadline);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 「私有文件」写入（v0.6.3，审计 H-1）
//
// 背景：会话/记忆/任务/调度/工作空间/索引这些文件此前直接 appendFileSync / 原子写**不带 mode**，
// 默认 umask 下是 0644——而会话原文会原样记录用户粘贴的 sk-*、PEM、JWT，同机其它用户可读。
// 同仓的账本/审计/凭据早已 0600，属于「同模块两套口径」。
//
// 两条纪律：
//   ① 创建时带 mode: 0o600；
//   ② **每次写都补一次 chmod 自愈**——mode 只在创建时生效，对旧版本留下的 0644 文件不起作用
//      （凭据/审计早已这么做，这里收敛成共享助手，避免八处各写一遍再漂移）。
// ---------------------------------------------------------------------------

/**
 * 追加写入并保证 0600（对已存在文件收权自愈）。
 * @param {string} file @param {string|Buffer} data
 */
export function appendFilePrivateSync(file, data) {
  fs.appendFileSync(file, data, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

/**
 * 原子写入并保证 0600（对已存在文件收权自愈）。
 * @param {string} file @param {string|Buffer} data
 */
export function atomicWritePrivateSync(file, data) {
  atomicWriteFileSync(file, data, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

export function atomicWriteJsonSync(/** @type {string} */ target, /** @type {any} */ value, { mode = 0o600 } = {}) {
  atomicWriteFileSync(target, JSON.stringify(value, null, 2) + '\n', { mode });
}

// 极简互斥锁：O_EXCL 创建 lockfile；持锁期间执行 fn（同步/异步）；异常/完成释放。
// 进程崩溃遗留的陈旧锁自动回收，避免永久卡死。

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
 * 尝试独占创建锁文件。**返回结构化结果而不是用异常表达"忙"**：
 *   · `{ok:true}` —— 拿到了锁；
 *   · `{ok:false, code:'EEXIST', error}` —— 锁确实被别人持有（按 timeoutMs 等待，可回收陈旧锁）；
 *   · `{ok:false, code:'EACCES'|'EPERM'|'EBUSY', error}` —— Windows 的**瞬时拒绝**：NTFS
 *     delete-pending / 杀软/索引器扫描 / 共享冲突。它既不是"权限配错"也不是"长期持锁"，
 *     由调用方走独立的 2s 退避预算；预算耗尽时抛 `error`（保留 errno 原文）。
 * 其余错误（路径非法等）仍**直接抛出**——那不是争用，装成争用只会掩盖真问题。
 * @param {string} lockPath
 * @returns {{ok: true} | {ok: false, code: string, error: any}}
 */
function tryAcquire(lockPath) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    const code = String(/** @type {any} */ (err)?.code || '');
    if (code === 'EEXIST' || isTransientDenyCode(code)) return { ok: false, code, error: err };
    throw err;
  }
  try {
    // v0.6.3（M-11）：锁内容额外记下本进程的**入口脚本**，作为 pid 的身份凭据。
    // 起因：陈旧回收只看「持有者 pid 是否存活」，而 pid 会被复用——复用给一个活进程后
    // `procAlive` 恒真，这把锁**永不回收**，所有写方等到超时失败（死锁）。
    // 有了 cmd（argv[1]），回收方可以用既有的 pidOwnedBy() 校验"活着的这个 pid 还是不是原来那个进程"。
    // v0.6.3（M-11）：锁内容额外记下入口脚本的**文件名**作为 pid 的身份凭据。
    // 起因：陈旧回收只看「持有者 pid 是否存活」，而 pid 会被复用——复用给一个活进程后
    // `procAlive` 恒真，这把锁**永不回收**，所有写方等到超时失败（死锁）。
    //
    // 为什么是 basename 而不是 argv[1]：`ps` 显示的是**输入时的形态**，而 Node 把 argv[1]
    // 解析成绝对路径——`node test/smoke.js` 在 ps 里就是 `node test/smoke.js`。
    // 第一版存 argv[1]，于是"同进程内的并发任务"也被判成 pid 复用 → **把活锁抢走**，
    // 既有的并发串行断言当场抓到（3 次自增只剩 1）。basename 在两种形态下都出现，是稳妥的交集。
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), cmd: path.basename(process.argv[1] || process.execPath) }));
  } finally {
    fs.closeSync(fd);
  }
  return { ok: true };
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
  let holderCmd = '';
  try {
    const meta = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    holderPid = Number(meta?.pid) || 0;
    holderCmd = String(meta?.cmd || '');
  } catch {}
  let holderAlive = holderPid > 0 ? procAlive(holderPid) : null;
  // M-11：pid 存活 ≠ 原持有者还活着。用命令行归属校验识破 pid 复用：
  //   · pidOwnedBy 返回 false → 这个 pid 现在跑的是**别的**程序 → 原持有者已死，可以回收；
  //   · 返回 true（同一入口脚本，可能是也可能不是原进程）或 null（Windows/取不到命令行）→ 保持"活着"。
  // 这一层是**严格改进**：原先这种情况一律不回收，现在只有"能确证不是原进程"时才回收。
  if (holderAlive === true && holderCmd) {
    try {
      if (pidOwnedBy(holderPid, holderCmd) === false) holderAlive = false;
    } catch {}
  }
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
    let delay = TRANSIENT_RETRY_INITIAL_MS;
    // 第一次遇到瞬时拒绝的时刻（EEXIST 不参与这个预算，见文件头参数说明）
    let transientSince = 0;
    for (;;) {
      const got = tryAcquire(lockPath);
      if (got.ok) {
        held.add(lockPath);
        // v0.4.7：fn 在 try/finally 里直接执行，**不进入抢锁的 catch**——
        // 否则 fn 自身抛出的 EEXIST 会被当成抢锁失败，重抢后再次执行 fn → 同步死循环。
        try {
          return fn();
        } finally {
          held.delete(lockPath);
          releaseLock(lockPath);
        }
      }
      if (got.code === 'EEXIST') {
        // 审计 BUG-047：回收陈旧锁的分支不得绕过超时闸，否则陈旧锁删不掉（只读目录/EPERM）
        // 时 reclaimIfStale 恒返回 true → 无限空转、超时失效。
        reclaimIfStale(lockPath, staleMs);
        if (Date.now() - t0 > timeoutMs) throw lockTimeoutError(lockPath, timeoutMs);
      } else {
        // EACCES/EPERM/EBUSY：Windows 的瞬时拒绝，走独立的 2s 预算；耗尽时抛原始 errno。
        if (!transientSince) transientSince = Date.now();
        if (Date.now() - transientSince >= TRANSIENT_RETRY_BUDGET_MS) throw got.error;
      }
      sleepMs(delay);
      delay = Math.min(delay * 2, TRANSIENT_RETRY_MAX_MS);
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
 *
 * 等待策略与同步版逐字一致：EEXIST 走 timeoutMs，EACCES/EPERM/EBUSY 走 2s 瞬时预算；
 * `pollMs` 是**首次**等待时长，之后每次 ×2、封顶 100ms（旧版是固定 25ms 轮询）。
 * @param {string} lockPath @param {() => any} fn
 */
export async function withFileLock(/** @type {string} */ lockPath, /** @type {() => any} */ fn, { timeoutMs = DEFAULT_TIMEOUT_MS, staleMs = DEFAULT_STALE_MS, pollMs = TRANSIENT_RETRY_INITIAL_MS } = {}) {
  return runWithHeld(async (held) => {
    if (held.has(lockPath)) return fn();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const t0 = Date.now();
    let delay = Number(pollMs) > 0 ? Number(pollMs) : TRANSIENT_RETRY_INITIAL_MS;
    let transientSince = 0;
    for (;;) {
      const got = tryAcquire(lockPath);
      if (got.ok) {
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
      if (got.code === 'EEXIST') {
        // 与同步版同一条修正（审计 BUG-047）：回收分支不得绕过超时闸，否则陈旧锁删不掉时永远自旋
        reclaimIfStale(lockPath, staleMs);
        if (Date.now() - t0 > timeoutMs) throw lockTimeoutError(lockPath, timeoutMs);
      } else {
        if (!transientSince) transientSince = Date.now();
        if (Date.now() - transientSince >= TRANSIENT_RETRY_BUDGET_MS) throw got.error;
      }
      await sleepAsync(delay);
      delay = Math.min(delay * 2, TRANSIENT_RETRY_MAX_MS);
    }
  });
}

/** 同步/异步锁的默认超时与陈旧阈值（导出供诊断与测试断言「上限有界」）。 */
export function lockDefaults() {
  return { timeoutMs: DEFAULT_TIMEOUT_MS, staleMs: DEFAULT_STALE_MS };
}
