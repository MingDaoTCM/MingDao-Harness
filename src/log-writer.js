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
      // 自查 #5：日志可能含工具参数等敏感信息——创建与轮转一律 600（多用户机器防同机读取）
      if (!fs.existsSync(file)) fs.appendFileSync(file, line, { mode: 0o600 });
      else fs.appendFileSync(file, line);
      const st = fs.statSync(file);
      if (st.size > maxBytes) {
        const raw = fs.readFileSync(file, 'utf8');
        const cut = raw.length - maxBytes;
        const nl = raw.indexOf('\n', cut);
        const keep = nl === -1 ? raw.slice(cut) : raw.slice(nl + 1); // 行对齐保留尾部
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
