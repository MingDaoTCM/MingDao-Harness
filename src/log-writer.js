// 统一日志写入器（质检 A6）：追加写 + 超限轮转（v0.6.3 起为改名式，见下方说明）。
// 桌面主进程（appLog）与 Web 服务端（srvlog）共用同一实现，消除双文件口径漂移与 O(n) 全量重写。
import fs from 'node:fs';
import path from 'node:path';

export function createLogWriter(/** @type {string} */ file, { maxBytes = 512 * 1024 } = {}) {
  return (/** @type {string} */ msg) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const line = new Date().toISOString() + ' ' + String(msg) + '\n';
      // 自查 #5：日志可能含工具参数等敏感信息——创建与轮转一律 600（多用户机器防同机读取）。
      // v0.4.6 P3：已存在的 644 日志也要收权——mode 只在创建时生效，此前只在轮转时才 chmod。
      if (!fs.existsSync(file)) {
        fs.appendFileSync(file, line, { mode: 0o600 });
      } else {
        fs.appendFileSync(file, line);
        try { fs.chmodSync(file, 0o600); } catch {}
      }
      // v0.6.3（M-20）：轮转改为**改名式**，且不引入锁。
      //
      // 原实现是「全量读 → 算保留尾 → 写 .tmp → 原子替换」：读与写之间别人追加的行
      // 会被替换掉（静默丢日志）。两种修法里这里刻意**不用锁**——本写入器由 web 服务端
      // 在 chat 请求路径上调用（`srvlog(...)`），加上同步锁会在这个路径上引入 Atomics.wait
      // 阻塞（正是 v0.6.2 花大力气消掉的东西），而 `.lock` 的 `n` 清单也在提醒这一点。
      //
      // 改名式轮转没有"读-改-写"窗口，因此不需要锁：
      //   1. 把整文件 rename 成 `<file>.1`（**每一行都还在**，连"别人此刻正追加到旧 inode"
      //      的那一行也一并保住了）；
      //   2. 立刻按 logrotate 的 create 语义建一个空文件，读者不会看到"日志文件消失"；
      //   3. 上一轮的 `.1` 在 rename 前删掉，磁盘占用有界（≤ 2× 上限）。
      // Windows 上若其它进程仍持有该文件句柄，rename 会失败——被下面的 catch 吞掉，
      // 结果是"这次没轮转、文件继续长"，**不丢数据**，属于可接受降级。
      const st = fs.statSync(file);
      if (st.size > maxBytes) {
        const rotated = file + '.1';
        fs.rmSync(rotated, { force: true });
        fs.renameSync(file, rotated);
        try {
          fs.writeFileSync(file, '', { mode: 0o600, flag: 'wx' });
        } catch {}
        try { fs.chmodSync(file, 0o600); } catch {}
      }
    } catch {
      // 日志失败绝不抛错（best-effort）
    }
  };
}
