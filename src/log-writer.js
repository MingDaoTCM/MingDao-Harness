// 统一日志写入器（质检 A6）：追加写 + 超限按行截断（原子替换，绝不截断在行中间）。
// 桌面主进程（appLog）与 Web 服务端（srvlog）共用同一实现，消除双文件口径漂移与 O(n) 全量重写。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createLogWriter(/** @type {string} */ file, { maxBytes = 512 * 1024 } = {}) {
  // 轮转低水位（v0.4.6 P2 修复）：保留到 maxBytes/2 而不是刚好卡在上限。
  // 此前 `cut = raw.length - maxBytes` 让保留区恰好等于上限，文件在轮转后立刻又超限，
  // 于是**每次追加都整文件重写**（实测：上限之后 2000 次追加 = 2000 次全量读写 ≈1GB I/O）。
  // 另外 raw.length 是 UTF-16 码元数、st.size 是字节数，中文日志下 cut 直接变负 → 只砍掉一行。
  // 改为按字节定位行边界（Buffer.lastIndexOf(0x0a)），并留出一半余量。
  const keepBytes = Math.max(1, Math.floor(maxBytes / 2));
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
      const st = fs.statSync(file);
      if (st.size > maxBytes) {
        const buf = fs.readFileSync(file);
        // 从「字节位置 st.size - keepBytes」起找下一个换行，保证不在行/多字节字符中间切开
        const from = Math.max(0, buf.length - keepBytes);
        const nl = buf.indexOf(0x0a, from);
        const keep = nl === -1 ? buf.subarray(from) : buf.subarray(nl + 1);
        const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
        fs.writeFileSync(tmp, keep, { mode: 0o600 }); // 轮转重建保持 600
        fs.renameSync(tmp, file);
        try { fs.chmodSync(file, 0o600); } catch {} // rename 后兜底收权（历史 644 日志迁移）
      }
    } catch {
      // 日志失败绝不抛错（best-effort）
    }
  };
}
