// 工具调用审计日志（P3-5，第三轮复审建议）：
//  - 每个工具调用（含被拒/被钩子阻止/参数解析失败）落 ~/.mingdao/audit.jsonl（600 权限）
//  - 纯追加 + 低频截断（>20000 行保留最近 10000 行），与 journal 同款策略
//  - 记录内容做轻量脱敏（sk- 开头的 Key 掩码）；config.audit=false 可关闭（默认开）
//  - mingdao audit [数量] 查看最近记录（倒序）

import fs from 'node:fs';
import path from 'node:path';
import { mingdaoHome, ensureHome } from './config.js';
import { redactSecrets } from './redact.js';
import { atomicWriteFileSync } from './atomic-write.js';

// v0.6.2（第三方代码审计 P2-2）：截断触发改为看**文件大小**。
// 原判据 `auditCount > 20000` 是**进程内**计数：CLI 每次会话只 append 几次、进程结束即归零，
// 于是这个条件永远不成立 → 截断是**死代码**，audit.jsonl 对 CLI 用户无界增长
// （与注释里「低频截断」的意图正好相反）。按大小判断跨进程有效且同样是 O(1)。
const MAX_BYTES = 4 * 1024 * 1024; // 约合 20000 行
const KEEP_LINES = 10000;

export function auditFile() {
  return path.join(mingdaoHome(), 'audit.jsonl');
}

// 轻量脱敏（统一单一来源 v0.3.1 P1-1）：sk-/ghp_ 等常见前缀掩码，见 src/redact.js
export { redactSecrets };

export function writeAudit(/** @type {any} */ entry) {
  try {
    ensureHome();
    const file = auditFile();
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    try {
      fs.chmodSync(file, 0o600);
    } catch {}

  } catch {
    return; // 审计失败绝不影响会话
  }
  // 低频截断：statSync 廉价，只有真的超过阈值才整文件读一次并重写
  try {
    const f = auditFile(); // 上面 try 里的 file 是块内作用域，这里单独取一次
    if (fs.statSync(f).size > MAX_BYTES) {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      if (lines.length > KEEP_LINES) {
        // v0.6.2（P2-3）：**原子写**——原先直接 writeFileSync，截断过程中崩溃会留下半截
        // audit.jsonl（审计证据丢事件）。atomicWriteFileSync 的 tmp 名含 pid+随机后缀，
        // 写完 rename 原子替换，读者永远看到完整文件；mode 保持 0600。
        atomicWriteFileSync(f, lines.slice(-KEEP_LINES).join('\n') + '\n', { mode: 0o600 });
      }
    }
  } catch {}
}

export function listAudit(limit = 20) {
  try {
    const raw = fs.readFileSync(auditFile(), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(Number(limit) || 20, 500)))
      .reverse();
  } catch {
    return [];
  }
}
