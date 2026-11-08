// 双读对拍：对同一会话，**消息数组**（旧真源）与**事件重放**（候选真源）必须逐条等价。
//
// 为什么先做对拍而不是直接切：B2 要把"谁是真源"从消息数组换成事件日志。
// 切之前必须证明"两者等价"——否则切换那天，历史会话会静默变形（标题/工具卡片/中断占位）。
// 这一步是 0.6.19 教训的直接产物：大改前先拿到"新旧一致"的证据。
//
// 用法：
//   node scripts/event-parity.mjs                  # 扫当前 MINGDAO_HOME/sessions
//   node scripts/event-parity.mjs --home <dir>
//   node scripts/event-parity.mjs --limit 50 --verbose
// 退出码：0 = 没有不一致（等价 / 不可回溯 / 跳过）；1 = 有不一致；2 = 用法/环境错误。
//
// `incomplete`（v0.7.0 B2-a）：本版之前 `rewriteSession()` 完全不写事件，压缩 / --resume /
// /clear 之后的消息窗口只存在于 .jsonl 里，事件流无法回溯。这类**历史噪声**单列为
// incomplete（不计入 exit 1），避免把「旧会话本来就没记录」误报成「重放回归」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSession } from '../src/session.js';
import { eventFileFor, readEvents, replayToMessages, isEventLogName } from '../src/session-events.js';

/**
 * 比较两个消息数组：逐条按 role + content + tool_calls（按 id 排序）比较。
 * 只比较**语义字段**，不比较 `_` 开头的运行时注记（`_endedAt` 等不落盘）。
 * @param {any[]} a
 * @param {any[]} b
 * @returns {{ok:boolean, index:number, reason:string}}
 */
export function diffMessages(a, b) {
  const A = Array.isArray(a) ? a : [];
  const B = Array.isArray(b) ? b : [];
  if (A.length !== B.length) return { ok: false, index: Math.min(A.length, B.length), reason: `条数不同：消息 ${A.length} vs 重放 ${B.length}` };
  const norm = (m) => {
    const out = { role: String(m?.role ?? ''), content: m?.content ?? '' };
    if (Array.isArray(m?.tool_calls)) out.tool_calls = m.tool_calls.map((t) => String(t?.id ?? '')).sort();
    if (m?.tool_call_id != null) out.tool_call_id = String(m.tool_call_id);
    return JSON.stringify(out);
  };
  for (let i = 0; i < A.length; i += 1) {
    if (norm(A[i]) !== norm(B[i])) return { ok: false, index: i, reason: `第 ${i + 1} 条不同` };
  }
  return { ok: true, index: -1, reason: '' };
}

/**
 * 对一个会话做对拍。
 *
 * `incomplete` 的判据（v0.7.0 B2-a）：
 *   · 消息数组与重放**不一致**，且；
 *   · 整条事件日志里**没有任何 `messages.replace`**。
 * 没有该类型 = 日志写于本版之前：那时 `rewriteSession()` 不写事件，压缩 / --resume / /clear
 * 后的窗口只存在于 `.jsonl`，事件流无从回溯。两个方向都算（文件更短时是「被压掉的旧消息仍
 * 留在事件流里」，文件更长时是「重写后的窗口没有落事件」），二者都不是重放回归。
 * 反之，有 `messages.replace` 仍对不上，才是需要修的不一致（fail）。
 * @param {string} file 会话文件（.jsonl）
 * @returns {{status:'pass'|'incomplete'|'fail'|'skip', file:string, reason:string, messages:number}}
 */
export function parityOf(file) {
  const evFile = eventFileFor(file);
  if (!fs.existsSync(evFile)) return { status: 'skip', file, reason: '无事件侧车（旧会话）', messages: 0 };
  const read = readEvents(evFile);
  if (!read.ok) return { status: 'fail', file, reason: `事件日志读取失败：${read.error || '未知'}`, messages: 0 };
  const loaded = loadSession(file);
  const replay = replayToMessages(read.events);
  const d = diffMessages(loaded.messages, replay);
  if (d.ok) return { status: 'pass', file, reason: '', messages: loaded.messages.length };
  const hasReplace = read.events.some((ev) => ev.type === 'messages.replace');
  if (!hasReplace) {
    return {
      status: 'incomplete',
      file,
      reason: `事件日志早于本版，缺 rewrite 记录：${d.reason}`,
      messages: loaded.messages.length,
    };
  }
  return {
    status: 'fail',
    file,
    reason: `${d.reason}（${d.reason.includes('条数') ? '' : '至少到第 ' + (d.index + 1) + ' 条之前一致'}）`,
    messages: loaded.messages.length,
  };
}

/** 扫描目录下的所有会话（跳过事件侧车/冲突副本）。 */
export function sessionsIn(home) {
  const dir = path.join(home, 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') && !isEventLogName(f) && !f.includes('.server-') && !f.includes('.remote-'))
    .map((f) => path.join(dir, f))
    .sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const readArg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const home = readArg('--home') || process.env.MINGDAO_HOME || path.join(os.homedir(), '.mingdao');
  const limit = Number(readArg('--limit') || 0) || Infinity;
  const verbose = argv.includes('--verbose');
  const files = sessionsIn(home).slice(0, limit);
  if (!files.length) {
    console.log(`没有可对拍的会话（home=${home}）`);
    process.exit(0);
  }
  const results = files.map((f) => parityOf(f));
  const pass = results.filter((r) => r.status === 'pass');
  const incomplete = results.filter((r) => r.status === 'incomplete');
  const fail = results.filter((r) => r.status === 'fail');
  const skip = results.filter((r) => r.status === 'skip');
  for (const r of results) {
    if (r.status === 'pass') { if (verbose) console.log(`  ✓ ${path.basename(r.file)}（${r.messages} 条）`); continue; }
    if (r.status === 'skip') { if (verbose) console.log(`  – ${path.basename(r.file)}：${r.reason}`); continue; }
    if (r.status === 'incomplete') { console.log(`  ◌ ${path.basename(r.file)}：${r.reason}`); continue; }
    console.log(`  ✗ ${path.basename(r.file)}：${r.reason}`);
  }
  console.log(`\n对拍结果：等价 ${pass.length} · 不可回溯 ${incomplete.length} · 不一致 ${fail.length} · 跳过 ${skip.length}（共 ${results.length}）`);
  if (incomplete.length) console.log(`不可回溯（incomplete）不计入失败：这些会话的日志写于本版之前，整份重写没有 messages.replace，历史无法从事件流恢复。`);
  process.exit(fail.length ? 1 : 0);
}
