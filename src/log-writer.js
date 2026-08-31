// 统一日志写入器（质检 A6）：追加写 + 超限按行截断（原子替换，绝不截断在行中间）。
// 桌面主进程（appLog）与 Web 服务端（srvlog）共用同一实现，消除双文件口径漂移与 O(n) 全量重写。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createLogWriter(/** @type {string} */ file, { maxBytes = 512 * 1024 } = {}) {
  return (/** @type {string} */ msg) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const line = new Date().toISOString() + ' ' + String(msg) + '\n';
      fs.appendFileSync(file, line);
      const st = fs.statSync(file);
      if (st.size > maxBytes) {
        const raw = fs.readFileSync(file, 'utf8');
        const cut = raw.length - maxBytes;
        const nl = raw.indexOf('\n', cut);
        const keep = nl === -1 ? raw.slice(cut) : raw.slice(nl + 1); // 行对齐保留尾部
        const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
        fs.writeFileSync(tmp, keep);
        fs.renameSync(tmp, file);
      }
    } catch {
      // 日志失败绝不抛错（best-effort）
    }
  };
}
