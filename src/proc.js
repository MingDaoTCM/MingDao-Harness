// 进程身份核验（跨平台）：判断「pid 是否活着」与「pid 是否仍属于我启动的那个进程」。
//
// 为什么单独成模块：调度器（schedule.js）与任务面板（tasks.js）各自实现过一份，
// 且都只认 /proc——macOS / Windows 上读不到 /proc，于是「PID 归属校验」在非 Linux 上
// 静默退化为「活着就杀」。守护进程 pidfile 与任务 pid 都可能被系统回收后复用，
// 复用后的 pid 属于无关进程，直接 SIGTERM 就是误杀。
//
// 判定语义（三者必须严格区分，调用方据此决定是否动手）：
//   true  —— 命令行确实含 needle（基本可确认是自己的进程）
//   false —— 成功读到命令行但不含 needle（**明确不是**自己的进程，绝不能杀）
//   null  —— 两条路径都读不到（无 /proc 且无 ps / 权限不足）：无从判断，由调用方按 best-effort 处理
//
// 注意 false 与 null 的差别是本模块存在的全部意义：把 null 当 false 会让
// 「非 Linux 上 kill 只改状态不杀进程」（v0.4.5 修过的 P0），把 null 当 false 之外
// 又对 false 放行则是误杀。两条历史故障分别对应这两种误用。

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * 进程是否存活（best-effort）。
 * EPERM 说明进程存在但无权限发信号 → 视为存活。
 * @param {any} pid
 */
export function procAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (/** @type {any} */ e) {
    return e?.code === 'EPERM';
  }
}

/**
 * 读取指定进程的完整命令行。
 * Linux 走 /proc（零子进程开销）；其余平台回退 ps（macOS/BSD 与 procps 均支持
 * `-ww -o command=`，-ww 关掉按终端宽度截断，否则长命令行被截断会误判为「不含 needle」）。
 * @param {any} pid
 * @returns {string|null} 读不到返回 null
 */
function readCmdline(pid) {
  try {
    // Linux：cmdline 以 NUL 分隔；此处只需「是否包含」，无需切分
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    // 已退出但未被回收的僵尸 / 内核线程 cmdline 为空：视为「读到了但内容为空」，
    // 不能当成读不到（否则会退回 best-effort 放行，反而更危险）
    return raw;
  } catch {
    // 继续尝试 ps
  }
  try {
    return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * pid 是否仍属于命令行含 needle 的那个进程。
 * @param {any} pid
 * @param {any} needle 期望出现在命令行里的标记（调度 nonce / 任务 id）
 * @returns {boolean|null} null = 无从判断
 */
export function pidOwnedBy(pid, needle) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  const key = String(needle ?? '');
  if (!key) return null;
  // 进程已不存在：无所谓归属，也避免为死 pid 白起一个 ps 子进程。
  // （返回 false 而非 null：调用方会因此跳过 kill，而 kill 一个死 pid 本就无意义）
  if (!procAlive(n)) return false;
  const cmdline = readCmdline(n);
  if (cmdline === null) return null;
  return cmdline.includes(key);
}

/**
 * 本平台能否校验「命令行归属」（v0.4.7）。
 * Linux 有 /proc、macOS/BSD 有 ps；**Windows 两者皆无**——不为了这个判定去依赖
 * PowerShell/WMI（每次调用数百毫秒，且在受限环境里未必可用），因此 Windows 上
 * 归属校验诚实返回 null，由调用方退回「进程存活」判定（best-effort）。
 *
 * 这条边界是**已知且写明**的，不是「在 Windows 上碰巧不生效」：
 *   - Linux / macOS：kill 前可确认「这确实是我的进程」，PID 复用不会误杀；
 *   - Windows：无法确认，kill 为 best-effort（与 v0.4.5 行为一致，未退化也未夸大）。
 * 探测方式是用自身进程做一次实测，而不是硬编码平台名——这样新增平台时无需改代码。
 * @returns {boolean}
 */
let verifiableCache = /** @type {boolean|null} */ (null);
export function ownershipVerifiable() {
  if (verifiableCache !== null) return verifiableCache;
  const marker = process.argv[1] || process.execPath;
  verifiableCache = pidOwnedBy(process.pid, marker) !== null;
  return verifiableCache;
}
