// 原子写与跨进程互斥（质检 H3/H4：并发写地基）。
// 背景：守护进程、CLI、web 服务器同时写 ~/.mingdao 下同一批文件，
// 此前 read-modify-write 无锁 + 多进程共享固定 `target + '.tmp'` 临时名，
// 存在丢更新与"rename 到对方半截文件"的成体系隐患；config/credentials 等关键文件更是直写。
// 本模块提供两个原语：
//   1. atomicWriteFileSync —— tmp 名含 pid+随机后缀（跨进程绝不共名），写完 rename 原子替换；
//   2. withFileLockSync —— O_EXCL lockfile 互斥（带超时与陈旧锁回收），包裹读-改-写序列。
// 零依赖：仅 node:fs / node:path / node:crypto / Atomics.wait。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

// 极简互斥锁：O_EXCL 创建 lockfile；持锁期间执行 fn（同步）；异常/完成释放。
// 进程崩溃遗留的陈旧锁（> staleMs 未更新）自动回收，避免永久卡死。
// 可重入（P0-1 修复，v0.4.5）：本进程已持该锁时直接执行 fn——O_EXCL 锁不可重入，此前
// killTask 持锁内调 patchTask 二次抢同一把锁自死锁 5s（tasks kill/pause/remove 全失效）。
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleepMs = (/** @type {number} */ ms) => Atomics.wait(sleepBuf, 0, 0, ms);
const heldLocks = new Set(); // 本进程当前持有的锁路径（可重入判定）

// v0.6.2（自评报告 P2-7）：默认值必须 **timeoutMs > staleMs**。
// 原为 5000 / 15000——等待方 5 秒就抛「获取文件锁超时」，而陈旧锁要 15 秒才允许回收，
// 中间 10 秒是纯粹的**死区**：持锁方一旦崩溃，这段时间内所有写方必然全部失败
// （cachestats 静默跳过轮转丢计费明细；tasks/workspace/schedule/sync 未捕获时直接报错）。
export function withFileLockSync(/** @type {string} */ lockPath, /** @type {() => any} */ fn, { timeoutMs = 20000, staleMs = 15000 } = {}) {
  // 可重入：同一调用栈内已持该锁 → 直接执行，不再二次抢锁
  if (heldLocks.has(lockPath)) {
    return fn();
  }
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    // v0.4.7：区分「抢锁阶段」与「执行 fn 阶段」。此前 fn 自身抛出的 EEXIST 也会落进下方的
    // 锁重试分支，而 finally 已释放锁 → 重抢成功后再次执行 fn → 再次抛出 → **同步死循环**
    // （100% CPU，连超时分支都不可达）。acquiring 在 fn 开始执行前置 false。
    let acquiring = true;
    try {
      const fd = fs.openSync(lockPath, 'wx'); // 独占创建
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      heldLocks.add(lockPath);
      acquiring = false; // 锁已持有：此后 fn 的任何异常都不得进入锁重试分支
      try {
        return fn();
      } finally {
        heldLocks.delete(lockPath);
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      }
    } catch (err) {
      if (!acquiring) throw err; // fn 自身的异常绝不进入锁重试
      if (/** @type {any} */ (err).code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(lockPath);
        // v0.6.2（P2-7）：陈旧判据改为「**持有者 pid 已死**」优先。
        //
        // 原判据只看 mtime 超过 staleMs，带来两个反向问题：
        //   ① 崩溃后要白等满 15 秒才允许回收（配上面 5 秒的 timeout 就是死区）；
        //   ② 若某个 fn 本身耗时超过 15 秒（大文件重写、慢盘），别人会把**仍然活着**的锁
        //      判成陈旧并回收——互斥直接失效，而且没有任何补救。
        // 锁内容本来就写着 {pid, at}（此前只用于 TOCTOU 比对），现成的判据没用上。
        let holderPid = 0;
        try {
          holderPid = Number(JSON.parse(fs.readFileSync(lockPath, 'utf8'))?.pid) || 0;
        } catch {}
        const holderAlive = holderPid > 0 ? procAlive(holderPid) : null;
        // 回收条件：持有者已死（立刻回收，不留死区）；或读不到持有者信息且确实超过 staleMs。
        // 持有者仍活着（哪怕 fn 跑了很久）**绝不回收**——那会破坏互斥。
        const reclaimable = holderAlive === false || (holderAlive === null && Date.now() - st.mtimeMs > staleMs);
        if (reclaimable) {
          // TOCTOU 防护（OfficeACE 报告）：unlink 前读锁内容并二次 stat 比对，
          // 防两个进程同时判定陈旧、后者误删前者刚创建的新锁（互斥失效）
          try {
            const before = fs.readFileSync(lockPath, 'utf8');
            const st2 = fs.statSync(lockPath);
            if (st2.mtimeMs === st.mtimeMs && before === fs.readFileSync(lockPath, 'utf8')) {
              fs.unlinkSync(lockPath);
            }
          } catch {}
          continue; // 无论是否回收成功都重试一次（若锁刚被他人更新则继续等待）
        }
      } catch {
        continue; // 锁文件刚被释放
      }
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`获取文件锁超时（${lockPath}），可能存在其他进程长时间占用`);
      }
      sleepMs(25);
    }
  }
}
