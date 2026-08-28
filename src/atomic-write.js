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

export function atomicWriteFileSync(target, data, options = {}) {
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

export function atomicWriteJsonSync(target, value, { mode = 0o600 } = {}) {
  atomicWriteFileSync(target, JSON.stringify(value, null, 2) + '\n', { mode });
}

// 极简互斥锁：O_EXCL 创建 lockfile；持锁期间执行 fn（同步）；异常/完成释放。
// 进程崩溃遗留的陈旧锁（> staleMs 未更新）自动回收，避免永久卡死。
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleepMs = (ms) => Atomics.wait(sleepBuf, 0, 0, ms);

export function withFileLockSync(lockPath, fn, { timeoutMs = 5000, staleMs = 15000 } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx'); // 独占创建
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      try {
        return fn();
      } finally {
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          try {
            fs.unlinkSync(lockPath);
          } catch {}
          continue; // 回收陈旧锁后立即重试
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
