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
import { fileURLToPath } from 'node:url';

// 主入口守卫：比较 **realpath**（不是字符串）。
// `file://${argv[1]}` 在三种情况下会静默失效：Windows 盘符、符号链接路径（/tmp → /private/tmp）、
// 以及 Node 默认把模块解析成 realpath 而 argv[1] 仍是链接路径。失效时整段 CLI 不执行并 exit 0——
// "看起来跑过了"比报错危险得多（0.6.42 实测踩到）。
function isMainModule() {
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const argv = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return Boolean(argv) && self === argv;
  } catch { return false; }
}

import { loadSession } from '../src/session.js';
// 判据**单源**：比较逻辑住在 `src/session-events.js`，本脚本只做采集与汇总。
// 曾经这里复制过一份（0.7.0 B2-b），两份判据迟早漂移——对拍工具与被测代码的判据不一致，
// 等于用两把尺子量同一件事。这里改为导入 + 再导出，保持脚本对外签名不变。
import { eventFileFor, readEvents, replayToMessages, isEventLogName, EVENT_LOG_FORMAT, diffMessages } from '../src/session-events.js';

export { diffMessages };

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
  // 新日志（session.start.format >= EVENT_LOG_FORMAT）出现不一致 = 真回归；
  // 旧日志没有格式戳，缺 rewrite 记录是**历史噪声**，判 incomplete。
  const newFormat = read.events.some((ev) => ev.type === 'session.start' && Number(ev.data?.format) >= EVENT_LOG_FORMAT);
  const hasReplace = read.events.some((ev) => ev.type === 'messages.replace');
  const hasCompact = read.events.some((ev) => ev.type === 'compact');
  if (!newFormat && !hasReplace) {
    return {
      status: 'incomplete',
      file,
      reason: `事件日志早于本版，缺 rewrite 记录：${d.reason}`,
      messages: loaded.messages.length,
    };
  }
  // v0.8.0：format=2 却有 compact 而没有 messages.replace —— 说明某次 rewrite 的重写事件没落盘
  // （事件写失败只 warn、或当时 eventLog 被关）。这类日志**无法**从事件流回溯，不是"重放回归"，
  // 单列 incomplete 并点明原因，避免把"历史某次写失败"当成本版的重放 bug。
  if (newFormat && !hasReplace && hasCompact) {
    return {
      status: 'incomplete',
      file,
      reason: `format=2 但只有 compact 没有 messages.replace（某次整份重写未落事件），事件流无法回溯：${d.reason}`,
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

if (isMainModule()) {
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
