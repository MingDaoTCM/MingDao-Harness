// 工具调用审计日志（P3-5，第三轮复审建议）：
//  - 每个工具调用（含被拒/被钩子阻止/参数解析失败）落 ~/.mingdao/audit.jsonl（600 权限）
//  - 纯追加 + 低频截断（>20000 行保留最近 10000 行），与 journal 同款策略
//  - 记录内容做轻量脱敏（sk- 开头的 Key 掩码）；config.audit=false 可关闭（默认开）
//  - mingdao audit [数量] 查看最近记录（倒序）

import fs from 'node:fs';
import path from 'node:path';
import { mingdaoHome, ensureHome } from './config.js';
import { redactSecrets } from './redact.js';
import { atomicWriteFileSync, withFileLockSync, withFileLock } from './atomic-write.js';

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

let auditWarned = false;
let auditError = /** @type {string|null} */ (null);
let auditFailures = 0;
/** 审计写入失败次数（0 = 本次进程内从未失败）。 */
export function auditWriteFailures() {
  return auditFailures;
}
/** 审计最近一次写失败原因（无则 null）。 */
export function auditWriteError() {
  return auditError;
}

/** 锁内临界区：追加 + 低频轮转（**追加与轮转必须同一把锁**，v0.6.3 M-20）。
 * 原实现锁外追加 + 锁外读改写轮转：A 追加 → B 追加 → A 读到含 A 的快照 → A 原子写回 → B 那一行消失。
 * 审计是合规证据，"少一行"等于证据链有洞，而且不报错。锁的范围含 append：代价是每次
 * 工具调用多一次毫秒级文件锁（审计本就每工具调用一条）。
 * @param {any} entry */
function appendAuditUnderLock(/** @type {any} */ entry) {
  const file = auditFile();
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  // 低频截断：statSync 廉价，只有真的超过阈值才整文件读一次并重写
  if (fs.statSync(file).size > MAX_BYTES) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > KEEP_LINES) {
      // v0.6.2（P2-3）：**原子写**——原先直接 writeFileSync，截断过程中崩溃会留下半截
      // audit.jsonl（审计证据丢事件）。atomicWriteFileSync 的 tmp 名含 pid+随机后缀，
      // 写完 rename 原子替换，读者永远看到完整文件；mode 保持 0600。
      atomicWriteFileSync(file, lines.slice(-KEEP_LINES).join('\n') + '\n', { mode: 0o600 });
    }
  }
}

/** 写失败的统一可见化：审计不能反过来打断用户干活，但**不再无声**。
 * @param {any} err */
function auditFailure(/** @type {any} */ err) {
  auditFailures += 1;
  auditError = String(/** @type {any} */ (err)?.message ?? err);
  if (!auditWarned) {
    auditWarned = true;
    console.warn(
      `[MingDao] ⚠ 审计记录写入失败：${auditError}\n` +
        `  该次运行的 audit.jsonl 会缺事件（执行账本 ledger/ 不受影响）；请检查 ${auditFile()} 的磁盘空间与权限。`
    );
  }
}

/**
 * 写一条工具调用审计（**同步版**：CLI/REPL 与任何纯同步调用链；语义不变、失败不阻断主流程）。
 * @param {any} entry
 */
export function writeAudit(/** @type {any} */ entry) {
  try {
    ensureHome();
    withFileLockSync(auditFile() + '.lock', () => appendAuditUnderLock(entry));
  } catch (err) {
    auditFailure(err);
  }
}

/**
 * 写一条工具调用审计 —— **WebUI 工具执行路径用它（v0.7.0 §1.4）**。
 * 每次工具调用都会走到这里；同步版在锁争用时用 `Atomics.wait` 睡眠，会把整个 WebUI
 * （所有会话 / 权限确认 / SSE 流）冻住。`await withFileLock` 等待时让出事件循环。
 * 失败语义与同步版一致：只记计数/告警，绝不抛给主流程。
 * @param {any} entry
 * @returns {Promise<void>}
 */
export async function writeAuditAsync(/** @type {any} */ entry) {
  try {
    ensureHome();
    await withFileLock(auditFile() + '.lock', () => appendAuditUnderLock(entry));
  } catch (err) {
    auditFailure(err);
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
