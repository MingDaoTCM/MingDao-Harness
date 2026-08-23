// 工具调用审计日志（P3-5，第三轮复审建议）：
//  - 每个工具调用（含被拒/被钩子阻止/参数解析失败）落 ~/.mingdao/audit.jsonl（600 权限）
//  - 纯追加 + 低频截断（>20000 行保留最近 10000 行），与 journal 同款策略
//  - 记录内容做轻量脱敏（sk- 开头的 Key 掩码）；config.audit=false 可关闭（默认开）
//  - mingdao audit [数量] 查看最近记录（倒序）

import fs from 'node:fs';
import path from 'node:path';
import { mingdaoHome, ensureHome } from './config.js';

const MAX_LINES = 20000;
const KEEP_LINES = 10000;
let auditCount = 0; // 内存计数（评估 P3-2）：避免每次写入都整文件读一遍只为查行数

export function auditFile() {
  return path.join(mingdaoHome(), 'audit.jsonl');
}

// 轻量脱敏：sk- 系 API Key 掩码（审计日志可安全共享排查）
export function redactSecrets(text) {
  return String(text ?? '').replace(/(sk-[A-Za-z0-9_-]{6,})/g, 'sk-***');
}

export function writeAudit(entry) {
  try {
    ensureHome();
    const file = auditFile();
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
    auditCount += 1;
  } catch {
    return; // 审计失败绝不影响会话
  }
  // 低频截断：跨过上限后每 200 条才读盘检查一次
  if (auditCount > MAX_LINES && auditCount % 200 === 0) {
    try {
      const raw = fs.readFileSync(auditFile(), 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      if (lines.length > MAX_LINES) {
        fs.writeFileSync(auditFile(), lines.slice(-KEEP_LINES).join('\n') + '\n', { mode: 0o600 });
        auditCount = KEEP_LINES;
      }
    } catch {}
  }
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
