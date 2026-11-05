// 会话持久化：JSONL 格式存放在 <mingdao-home>/sessions/。
// 每轮自动追加；mingdao --continue 载入最近一次会话。

import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, eventFileFor, eventLogEnabled, isEventLogName, warnEventFailure } from './session-events.js';

// —— 冲突备份名（单一事实来源，v0.4.6）——
// 同步冲突时写入的备份：<会话名>.server-<时间戳>[-<随机后缀>].jsonl（远端版本）与 .remote-（远端拉取版本）。
// 教训：producer（sync.js conflictCopyName）带随机后缀，而 consumer 的正则只认 <数字>.jsonl，
// 导致 listSyncConflicts/resolveSyncConflict 永远匹配不到自己的备份——「冲突三选一」100% 失效；
// 且这些备份被 listSessions 当成普通会话推出/拉取，在其他设备上变成无法解析的幽灵会话。
// 现由本模块统一给出「识别 + 排除」，写入 / 冲突面板 / 会话列表与同步三处共用同一判定。
export const CONFLICT_BACKUP_RE = /^(.+)\.(server|remote)-(\d+)(?:-[a-z0-9]+)?\.jsonl$/;
/** @param {any} n */
export function isConflictBackupName(n) {
  return typeof n === 'string' && CONFLICT_BACKUP_RE.test(n);
}

/**
 * 会话列表（带诊断）：**单个条目失败不得清空整个列表**（v0.6.30 E5）。
 *
 * 根因：原实现把 `statSync` 放在一个包住整个 readdir+map 的 try 里——只要有一个条目
 * stat 失败（悬空符号链接、权限、并发删除、网络盘瞬时 EIO），异常冒到外层 catch，
 * 整个列表返回 `[]`：用户看到"会话全没了"，最近会话/搜索/同步推送也一起空。
 *
 * 现在每个条目独立 try/catch：失败的**跳过并计数**（`skipped`），其余照常返回；
 * 同时打一条可见 warning（含文件名与原因），避免"少了几条"完全无感。
 * `listSessions()` 保持既有的数组返回形状（调用方很多），需要诊断时用本函数。
 * @param {any} home
 * @returns {{ list: {file:string,name:string,mtime:number}[], skipped: {file:string,name:string,error:string}[] }}
 */
export function listSessionsDetailed(home) {
  const dir = path.join(home, 'sessions');
  /** @type {{file:string,name:string,mtime:number}[]} */
  const list = [];
  /** @type {{file:string,name:string,error:string}[]} */
  const skipped = [];
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // 目录不存在/不可读：会话目录整体不可用（首次运行/路径错），空列表是正确语义。
    return { list, skipped };
  }
  for (const f of entries) {
    // 冲突备份不是会话：排除后不再出现在会话列表/最近会话/搜索/云同步推送集合中
    // v0.7.0 §1.1：事件侧车 `<session>.events.jsonl` 不是会话——必须排除，否则它会变成
    // 「没有消息的幽灵会话」，甚至因 mtime 更新而抢走 latestSession()。旧会话行为不变。
    if (!f.endsWith('.jsonl') || isEventLogName(f) || isConflictBackupName(f)) continue;
    const file = path.join(dir, f);
    try {
      list.push({ file, name: f, mtime: fs.statSync(file).mtimeMs });
    } catch (err) {
      skipped.push({ file, name: f, error: String(/** @type {any} */ (err)?.code || /** @type {any} */ (err)?.message || err) });
    }
  }
  list.sort((a, b) => b.mtime - a.mtime);
  if (skipped.length) {
    try {
      const sample = skipped.slice(0, 3).map((s) => `${s.name}（${s.error}）`).join('、');
      console.warn(
        `[MingDao] ⚠ 会话列表：${skipped.length} 个会话文件无法读取，已跳过，不影响其余 ${list.length} 个会话：${sample}` +
          (skipped.length > 3 ? ` 等 ${skipped.length} 个` : '')
      );
    } catch {}
  }
  return { list, skipped };
}

/** @param {any} home */
export function listSessions(home) {
  return listSessionsDetailed(home).list;
}

/** @param {any} home */
export function latestSession(home) {
  return listSessions(home)[0] || null;
}

/** @param {any} home */
export function createSession(home) {
  const dir = path.join(home, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // v0.6.7（报告一 L-10）：同秒 + 4 位随机仍有碰撞概率，而此前**不检查存在性**——
  // 撞上就静默覆盖别人的会话。与 schedule 的 id 生成对齐：存在就换（最多 20 次），
  // 仍撞则退化为递增序号（确定性兜底，不引入新的随机源）。
  for (let i = 0; i < 20; i += 1) {
    const rand = Math.random().toString(36).slice(2, 6);
    const file = path.join(dir, `${stamp}-${rand}.jsonl`);
    if (!fs.existsSync(file)) return { file, name: path.basename(file) };
  }
  for (let i = 1; i < 1000; i += 1) {
    const file = path.join(dir, `${stamp}-x${i}.jsonl`);
    if (!fs.existsSync(file)) return { file, name: path.basename(file) };
  }
  const file = path.join(dir, `${stamp}-${Date.now()}.jsonl`);
  return { file, name: path.basename(file) };
}

/**
 * v0.6.23（§3.87）：会话消息 `ts` 的**唯一补齐点**。
 *
 * 为什么放在这一层：CLI / REPL / 调度 worker / Web 落盘最终都走 appendMessages；
 * 此前只有 Web server 在落盘前自己 stamp，导致旧会话与非 Web 会话的消息在界面上没有时间。
 * 规则：只给**缺少 ts** 的消息补一个 ISO 字符串，已有 ts 原样保留（重复写入不刷新时间）；
 * 就地写回同一批消息对象，这样自动压缩的整文件重写（rewriteSession）能带上刚写下的 ts。
 * 读取路径不调用它：旧会话缺 ts 仍返回 null，绝不回填/改写历史文件。
 * @param {any[]} messages
 * @param {Date} [now]
 */
export function stampMessageTs(messages, now = new Date()) {
  const ts = now.toISOString();
  for (const m of messages) {
    if (!m || typeof m !== 'object' || m.ts) continue;
    m.ts = ts;
  }
  return messages;
}

/**
 * v0.7.0 §1.1：会话消息的**双写**（消息文件写完之后的旁路）。
 *
 * 纪律：会话文件已经落盘，这里任何失败都只 warn 并返回；**绝不改变 appendMessages 的结果**，
 * 也绝不把异常抛给调用方。`cfg.eventLog=false` 由 agent 侧把进程开关关掉，这里自然一并停止。
 * @param {any} file
 * @param {any[]} messages
 */
function doubleWriteSessionEvents(file, messages) {
  if (!eventLogEnabled()) return;
  const eventFile = eventFileFor(file);
  if (!eventFile) return;
  try {
    // 事件流的第一条：只在文件尚不存在时写一次（并发下最多重复一条 session.start，无害）。
    if (!fs.existsSync(eventFile)) {
      const start = appendEvent(eventFile, { type: 'session.start', data: { session: path.basename(String(file)) } });
      if (!start.ok) {
        warnEventFailure(eventFile, start.error ?? null);
        return;
      }
    }
    for (const m of messages) {
      const r = appendEvent(eventFile, { type: 'message.append', data: { message: m } });
      if (!r.ok) {
        warnEventFailure(eventFile, r.error ?? null);
        return; // 写不进去就停：后面的每一条都只会重复同一条告警
      }
    }
  } catch (err) {
    warnEventFailure(eventFile, String(/** @type {any} */ (err)?.message ?? err));
  }
}

/** @param {any} file @param {any} messages */
export function appendMessages(file, messages) {
  if (!messages?.length) return;
  stampMessageTs(messages); // 单一来源：所有写入路径在这里补 ts（已有 ts 不覆盖）
  const lines = messages.map((/** @type {any} */ m) => JSON.stringify(m)).join('\n') + '\n';
  appendFilePrivateSync(file, lines);
  doubleWriteSessionEvents(file, messages); // 旁路：失败只 warn，不影响上面的会话写入
}

// 整文件原子重写：自动压缩后把会话文件同步为压缩形态（否则每次加载历史都会重新触发压缩）
/** @param {any} file @param {any} messages */
export function rewriteSession(file, messages) {
  const lines = messages.map((/** @type {any} */ m) => JSON.stringify(m)).join('\n');
  atomicWriteFileSync(file, lines + (lines ? '\n' : ''), { mode: 0o600 }); // 质检 H4：会话文件原子写
}

/** @param {any} file */
export function loadSession(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const messages = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m && typeof m === 'object' && ['system', 'user', 'assistant', 'tool'].includes(m.role)) {
        messages.push(m);
      }
    } catch {}
  }
  return { file, messages };
}

// 会话预览：第一条用户消息（用于会话选择器）
/** @param {any} file */
export function sessionPreview(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (!m || typeof m !== 'object') continue; // 审计 B4：null/非对象行跳过而非中断预览
      if (m.role === 'user') {
        const s = String(m.content).split('\n')[0].trim().slice(0, 60);
        return s || '(空消息)';
      }
    }
    return '(无内容)';
  } catch {
    return '(无法读取)';
  }
}

/** @param {any} mtime */
export function relativeTime(mtime) {
  const diff = Date.now() - mtime;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

// 全文检索历史会话（P3-2 索引化）：增量词表倒排 + AND 匹配（中文 bigram），
// 只对命中的少数文件读原文生成片段；未命中/无关键词时回退列表。
// v0.6.30（E3）：新增异步版 searchSessionsAsync —— WebUI 请求路径必须用异步版（索引同步的
// 锁等待不能阻塞事件循环）；CLI/REPL 保留同步版 searchSessions。
import { syncSessionIndex, syncSessionIndexAsync, tokenize, extractSessionText } from './session-index.js';
import { atomicWriteFileSync, appendFilePrivateSync } from './atomic-write.js';

/** 用已同步好的索引做匹配 + 片段（同步/异步两版共用）。 @param {any[]} sessions @param {any} idx @param {string} kw */
function matchSessions(/** @type {any[]} */ sessions, /** @type {any} */ idx, /** @type {string} */ kw, /** @type {number} */ limit) {
  const qTerms = [...tokenize(kw).keys()];
  if (!qTerms.length) return [];
  const lower = kw.toLowerCase();
  const out = [];
  for (const s of sessions) {
    if (out.length >= limit) break;
    const e = idx.files[s.name];
    if (!e?.terms) continue;
    let hit = true;
    for (const t of qTerms) {
      if (!e.terms[t]) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    // 命中（数量受 limit 约束）：读原文生成干净片段
    let snippet = '';
    try {
      const text = extractSessionText(s.file);
      const at = text.toLowerCase().indexOf(lower);
      if (at !== -1) {
        snippet = `…${text.slice(Math.max(0, at - 30), at + kw.length + 50).replace(/\s+/g, ' ').trim()}…`;
      } else {
        snippet = `…${text.slice(0, 80).replace(/\s+/g, ' ').trim()}…`;
      }
    } catch {}
    out.push({ ...s, snippet });
  }
  return out;
}

/** 同步检索：CLI / REPL 用（纯同步调用链）。WebUI 用 searchSessionsAsync。
 * @param {any} home @param {any} keyword */
export function searchSessions(home, keyword, { limit = 20 } = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) return listSessions(home).slice(0, limit);
  const sessions = listSessions(home);
  const idx = syncSessionIndex(home, sessions);
  return matchSessions(sessions, idx, kw, limit);
}

/** 异步检索：WebUI `GET /api/sessions?q=` 用——索引同步走异步文件锁，不冻结事件循环。
 * 结果与同步版逐字一致（同一套匹配/片段逻辑）。
 * @param {any} home @param {any} keyword */
export async function searchSessionsAsync(home, keyword, { limit = 20 } = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) return listSessions(home).slice(0, limit);
  const sessions = listSessions(home);
  const idx = await syncSessionIndexAsync(home, sessions);
  return matchSessions(sessions, idx, kw, limit);
}
