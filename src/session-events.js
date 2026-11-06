// 会话事件日志（v0.7.0 §1.1 切片 A）：append-only 的事件流，与消息数组**双写**。
//
// 为什么要有它：会话此前只存 `<home>/sessions/<name>.jsonl` 的消息数组——「这条消息属于哪个
// turn/step、工具有没有结束、压缩发生在第几条之前」这些结构信息只能靠字段猜。本模块把会话状态
// 增加一条**可重放**的事实源：每条 `{seq,time,type,data}` 追加一行，seq 单调且是唯一关联键。
//
// 本切片**不改既有读取路径**：
//   · `loadSession` / `rewriteSession` 的返回值与 `.jsonl` 格式一字未动；
//   · 事件文件是**并列的新侧车** `<session>.events.ndjson`，旧会话没有它照样可读；
//     **为什么不是 .jsonl**：全仓（以及用户脚本/测试）有大量 `readdirSync(sessions).filter(f => f.endsWith('.jsonl'))`
//     的写法，侧车若也叫 `.jsonl` 就会被当成会话——本版实测已挂掉 2 个 e2e（分享时把侧车当会话推给服务端，
//     服务端回「你还没有这个会话」）。改成 `.ndjson`（同格式、不同扩展名）让这类碰撞在命名层就不存在。
//   · SSE 帧、UI、账本、同步都不读事件文件。
// 因此事件日志坏掉/写不进去，最多是「这条时间线不完整」，绝不影响会话本身。
//
// 可靠性约定：
//   · 所有对外 API 一律返回 `{ok,error}` 形态，**任何失败都不许抛到调用方**；
//   · seq 分配在跨进程文件锁内「读尾行 → last+1 → 单次 append」，同进程再用 Map 缓存上一条，
//     避免 8 个子进程并发时重号；
//   · 读取跳过 torn 行（半截 JSON）与未知 type，并返回 `skipped` 计数——**可见**，不静默丢；
//   · `replayToMessages` 是纯函数：`message.append` 提供消息本体，`compact` 重置基线，
//     `interrupt` 在最终消息数组里补齐尚未回填的 tool 占位（延迟到全部事件读完再补，避免与
//     随后 message.append 的占位重复/错位）。

import fs from 'node:fs';
import path from 'node:path';
import { appendFilePrivateSync } from './atomic-write.js';

/** 本切片先定这 12 类事件；新增类型必须同时更新这里与 `test/session-events.js` 的清单。 */
export const EVENT_TYPES = Object.freeze([
  'session.start',
  'turn.start',
  'turn.end',
  'step.start',
  'step.end',
  'tool.start',
  'tool.end',
  'message.append',
  'usage',
  'compact',
  'interrupt',
  'checkpoint',
]);

const EVENT_TYPE_SET = new Set(EVENT_TYPES);

/** 回滚开关：`MINGDAO_EVENT_LOG=0`（或 false/off/no）时全局关闭双写。 */
export const EVENT_LOG_ENV = 'MINGDAO_EVENT_LOG';

/** 中断时补的 tool 占位文案——与 `agent.js#finishTurn` 的既有文案保持逐字一致。 */
export const INTERRUPTED_TOOL_CONTENT = '（已中断，未执行）';

/** 尾部读取窗口：足够覆盖若干条事件；只有读不到 seq 且文件更大时才回退整文件。 */
const TAIL_BYTES = 64 * 1024;

/** 同进程 seq 缓存：`事件文件绝对路径 → {seq, size}`。跨进程仍以文件尾为准。 */
const seqCache = new Map();

/** 追加锁的临界区只有「读尾行 + 一次 append」：超过这个年龄的锁视为崩溃残留。 */
const APPEND_LOCK_STALE_MS = 10000;
const APPEND_LOCK_TIMEOUT_MS = 10000;

/** 同步小睡：临界区极短，用 Atomics.wait 让出 CPU（不引入异步传染）。 */
function sleepSync(/** @type {number} */ ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

/** 释放追加锁。返回是否真的删掉了（删除失败只影响下一次抢锁，不影响本次写入结果）。 */
function releaseAppendLock(/** @type {string} */ lock) {
  try {
    fs.unlinkSync(lock);
  } catch {
    return false;
  }
  return true;
}

/** 回收崩溃残留锁：只回收「超过临界区阈值」的锁，避免误删刚建的新锁。 */
function reclaimStaleAppendLock(/** @type {string} */ lock) {
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs <= APPEND_LOCK_STALE_MS) return false;
    try {
      fs.unlinkSync(lock);
    } catch {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 每文件一个极短临界区的追加锁（`<eventFile>.lock`，O_EXCL 创建）。
 *
 * 为什么不用 `atomic-write.js#withFileLockSync`：那套锁允许调用方按业务持锁数秒，
 * 本模块的临界区只有「读尾行 → append → 回读校验」三步、毫秒级；这里用更小的超时/陈旧阈值，
 * 且失败一律折成 `{ok:false}`（见 appendEvent 的 catch），不会让事件日志拖住会话。
 * 也可以理解为：seq 的唯一性靠这把锁，锁外的任何路径都不写事件文件。
 * @template T
 * @param {string} file
 * @param {() => T} fn
 * @returns {T}
 */
function withAppendLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + APPEND_LOCK_TIMEOUT_MS;
  for (;;) {
    let fd = -1;
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } finally {
        fs.closeSync(fd);
        fd = -1;
      }
      break;
    } catch (err) {
      if (fd >= 0) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      const code = String(/** @type {any} */ (err)?.code || '');
      // v0.6.37：Windows 上 `openSync(lock,'wx')` 在"锁已被别人创建"时**不一定**报 EEXIST——
      // 实测 8 进程并发会得到 `EPERM: operation not permitted, open '…concurrent.events.ndjson.lock'`
      // （NTFS/FAT 的 O_EXCL 语义差异）。此前只把 EEXIST 当"有人持锁"→ EPERM 直接上抛，
      // Windows 腿的 `batch76`（session-events 并发用例）因此 7/12、5 条逃逸。
      // 处理：把 EPERM/EACCES/EBUSY 一并视为"有竞争"，走同一套超时/陈旧回收/退避逻辑；
      // 真正的权限错误仍会在超时后以明确的超时信息暴露（不会永远静默重试）。
      const RETRYABLE = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);
      if (!RETRYABLE.has(code)) throw err;
      // 崩溃残留：临界区毫秒级，超过 10s 的锁不可能是活写方；二次 stat 防误删刚建的新锁。
      if (reclaimStaleAppendLock(lock)) continue;
      if (Date.now() > deadline) throw new Error(`获取事件追加锁超时：${lock}`);
      sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    releaseAppendLock(lock);
  }
}

/** 写失败告警去重（每个事件文件每次进程只提示一次，避免每条消息刷屏）。 */
const warnedFiles = new Set();

/** 进程级开关（`createAgent` 按 `cfg.eventLog` 设置；默认开）。 */
let processEnabled = true;

/**
 * 事件日志是否启用。
 * @param {any} [cfg] 传入 config 时额外尊重 `cfg.eventLog === false`
 * @returns {boolean}
 */
export function eventLogEnabled(cfg) {
  const env = String(process.env[EVENT_LOG_ENV] ?? '').toLowerCase();
  if (env === '0' || env === 'false' || env === 'off' || env === 'no') return false;
  if (cfg && cfg.eventLog === false) return false;
  return processEnabled;
}

/**
 * 进程级开关。`cfg.eventLog === false` 时由 `createAgent` 调用它，使**会话消息的**
 * `message.append` 双写也一起停下（否则只停 agent 事件，仍会写一半）。
 * @param {boolean} enabled
 */
export function setEventLogEnabled(enabled) {
  processEnabled = enabled !== false;
}

/**
 * 会话文件 → 事件文件：`<session>.jsonl` → `<session>.events.ndjson`。
 * 已经是 `.events.ndjson` 的原样返回（方便调用方只写一个入口）。
 * @param {string} sessionFile
 * @returns {string}
 */
export function eventFileFor(sessionFile) {
  const s = String(sessionFile || '');
  if (!s) return '';
  if (s.endsWith('.events.ndjson')) return s;
  if (s.endsWith('.jsonl')) return `${s.slice(0, -'.jsonl'.length)}.events.ndjson`;
  return `${s}.events.ndjson`;
}

/**
 * 是否是事件侧车文件名。会话列表/同步必须排除它——否则事件文件会被当成一个「没有消息的
 * 幽灵会话」，甚至因为 mtime 更新而抢走 `latestSession()`。
 * @param {string} name
 * @returns {boolean}
 */
export function isEventLogName(name) {
  return String(name || '').endsWith('.events.ndjson');
}

/**
 * @typedef {{seq: number, time: number, type: string, data: any}} SessionEvent
 * @typedef {{ok: boolean, error: string|null, events: SessionEvent[], skipped: number}} ReadEventsResult
 * @typedef {{ok: boolean, error: string|null, seq?: number|null, disabled?: boolean}} AppendEventResult
 */

/**
 * 读文件尾（最多 TAIL_BYTES）。文件不存在按空文件处理；其余读失败上抛，由调用方转成 `{ok:false}`。
 * @param {string} file
 * @returns {{size: number, text: string, endsWithNewline: boolean}}
 */
function readTail(file) {
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    if (len > 0) fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return { size, text, endsWithNewline: size === 0 || text.endsWith('\n') };
  } catch (err) {
    if (String(/** @type {any} */ (err)?.code || '') === 'ENOENT') {
      return { size: 0, text: '', endsWithNewline: true };
    }
    throw err;
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * 从文本尾部找最后一条**可解析事件的 seq**；torn/非 JSON 行跳过。
 * @param {string} text
 * @returns {number}
 */
function lastSeqInText(text) {
  const lines = String(text || '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      const seq = Number(ev?.seq);
      if (Number.isInteger(seq) && seq > 0) return seq;
    } catch {}
  }
  return 0;
}

/**
 * 读文件尾的 last seq；尾窗读不到且文件更大时回退整文件（只发生在文件损坏/超长时）。
 * @param {string} file
 * @returns {{lastSeq: number, size: number, endsWithNewline: boolean}}
 */
function readLastEventSeq(file) {
  const tail = readTail(file);
  let lastSeq = lastSeqInText(tail.text);
  if (!lastSeq && tail.size > Buffer.byteLength(tail.text, 'utf8')) {
    lastSeq = lastSeqInText(fs.readFileSync(file, 'utf8'));
  }
  return { lastSeq, size: tail.size, endsWithNewline: tail.endsWithNewline };
}

/**
 * 追加一条事件。返回 `{ok,error,seq}`；**绝不抛异常**。
 *
 * seq 分配：跨进程文件锁内读尾行 last seq + 1，单次 append 后立刻回读校验；同进程用 Map
 * 缓存上一条作为「文件被外部截断/重建」时的保守下限（文件大小小于缓存值时以文件尾为准，
 * 避免凭空跳号）。
 * @param {string} eventFile
 * @param {{type?: string, data?: any, at?: number|Date|null}} [event]
 * @returns {AppendEventResult}
 */
export function appendEvent(eventFile, { type = '', data = {}, at = null } = {}) {
  if (!eventLogEnabled()) return { ok: true, error: null, seq: null, disabled: true };
  try {
    const file = path.resolve(String(eventFile || ''));
    if (!file) return { ok: false, error: '事件文件路径为空' };
    if (!EVENT_TYPE_SET.has(type)) return { ok: false, error: `未知事件类型：${String(type)}` };
    const payload = data && typeof data === 'object' ? data : {};
    const time = Number(at instanceof Date ? at.getTime() : at);
    const lineBody = () => {
      const event = { seq: 0, time: Number.isFinite(time) && time > 0 ? time : Date.now(), type, data: payload };
      return event;
    };
    const result = withAppendLock(
      file,
      () => {
        const tail = readLastEventSeq(file);
        const cached = seqCache.get(file);
        let base = tail.lastSeq;
        if (tail.size === 0) base = 0;
        else if (cached && tail.size >= cached.size) base = Math.max(base, cached.seq);
        const seq = base + 1;
        const event = lineBody();
        event.seq = seq;
        const json = JSON.stringify(event);
        // 文件尾部若没有换行（torn 行/手工写入），先补一个换行：新事件永远独占一行。
        const prefix = tail.size > 0 && !tail.endsWithNewline ? '\n' : '';
        appendFilePrivateSync(file, prefix + json + '\n');
        const newSize = tail.size + Buffer.byteLength(prefix + json + '\n', 'utf8');
        // 末尾校验：确认最后一行就是刚写下的事件（锁内不会有第二个写方）。
        const verify = readTail(file);
        const lines = verify.text.split('\n').filter((l) => l.trim());
        const last = lines.length ? lines[lines.length - 1] : '';
        let ok = false;
        try {
          const parsed = JSON.parse(last.replace(/\r$/, ''));
          ok = parsed?.seq === seq && parsed?.type === type;
        } catch {}
        if (!ok) return { ok: false, error: `事件写入后校验失败（seq=${seq}）` };
        seqCache.set(file, { seq, size: newSize });
        return { ok: true, error: null, seq };
      }
    );
    return result;
  } catch (err) {
    return { ok: false, error: String(/** @type {any} */ (err)?.message ?? err) };
  }
}

/**
 * 读取事件流。torn 行 / 未知 type / 缺 seq 的行跳过并计入 `skipped`；文件不存在返回空流
 * （这是旧会话的正常形态，不是错误）。
 * @param {string} eventFile
 * @returns {ReadEventsResult}
 */
export function readEvents(eventFile) {
  try {
    const file = path.resolve(String(eventFile || ''));
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (String(/** @type {any} */ (err)?.code || '') === 'ENOENT') {
        return { ok: true, error: null, events: [], skipped: 0 };
      }
      return { ok: false, error: String(/** @type {any} */ (err)?.message ?? err), events: [], skipped: 0 };
    }
    /** @type {SessionEvent[]} */
    const events = [];
    let skipped = 0;
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.replace(/\r$/, '').trim();
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        skipped += 1;
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        skipped += 1;
        continue;
      }
      if (!EVENT_TYPE_SET.has(parsed.type)) {
        skipped += 1;
        continue;
      }
      const seq = Number(parsed.seq);
      if (!Number.isInteger(seq) || seq < 1) {
        skipped += 1;
        continue;
      }
      const time = Number(parsed.time);
      events.push({
        seq,
        time: Number.isFinite(time) ? time : 0,
        type: String(parsed.type),
        data: parsed.data && typeof parsed.data === 'object' ? parsed.data : {},
      });
    }
    return { ok: true, error: null, events, skipped };
  } catch (err) {
    return { ok: false, error: String(/** @type {any} */ (err)?.message ?? err), events: [], skipped: 0 };
  }
}

/** @param {any} value @returns {any} 深拷贝（事件里只会有 JSON 值）。 */
function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

/**
 * 事件按 seq 升序（seq 是唯一关联键）；缺 seq 的保持原序在后。
 * @param {any[]} events
 * @returns {SessionEvent[]}
 */
function ordered(events) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  return list
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const sa = Number(a.e?.seq);
      const sb = Number(b.e?.seq);
      const fa = Number.isFinite(sa) ? sa : Number.MAX_SAFE_INTEGER;
      const fb = Number.isFinite(sb) ? sb : Number.MAX_SAFE_INTEGER;
      return fa === fb ? a.i - b.i : fa - fb;
    })
    .map((x) => /** @type {SessionEvent} */ (x.e));
}

/**
 * 找出中断时**尚未回填**的 tool_call_id（按 assistant.tool_calls 原序）。
 * 与 `agent.js#finishTurn` 的判据同源：最后一条带 tool_calls 的 assistant 之后，
 * 哪些 id 还没有对应的 tool 消息。
 * @param {any[]} messages
 * @returns {string[]}
 */
export function missingToolCallIds(messages) {
  const list = Array.isArray(messages) ? messages : [];
  /** @type {string[]} */
  const ids = [];
  try {
    const assistant = [...list].reverse().find((m) => m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length);
    if (!assistant) return ids;
    const have = new Set(list.filter((m) => m?.role === 'tool' && m.tool_call_id).map((m) => String(m.tool_call_id)));
    for (const tc of assistant.tool_calls) {
      const id = tc?.id ? String(tc.id) : '';
      if (id && !have.has(id)) ids.push(id);
    }
  } catch {}
  return ids;
}

/**
 * 由事件流确定性重放出消息数组（纯函数：不读写文件、不改入参）。
 *
 * 语义（与双写顺序一致）：
 *   · `message.append`：`data.message` 追加到末尾；
 *   · `compact`：`data.messages` 是压缩后的**新基线**，整体替换（后续 append 接在它后面）；
 *   · `interrupt`：`data.toolCallIds` 里的 id 若在最终消息里仍没有 tool 回填，则在对应
 *     assistant 之后补一条 `（已中断，未执行）` 占位——**延迟到所有事件处理完再补**，这样
 *     随后到达的 message.append 若已含占位就不会重复，也不会插错位置。
 * @param {any[]} events
 * @returns {any[]}
 */
export function replayToMessages(events) {
  /** @type {any[]} */
  let messages = [];
  /** @type {string[]} */
  const pendingInterruptIds = [];
  for (const ev of ordered(events)) {
    if (ev.type === 'message.append') {
      const m = ev.data?.message;
      if (m && typeof m === 'object' && !Array.isArray(m)) messages.push(cloneJson(m));
    } else if (ev.type === 'compact') {
      const base = ev.data?.messages;
      if (Array.isArray(base)) {
        messages = base.filter((m) => m && typeof m === 'object' && !Array.isArray(m)).map(cloneJson);
      }
    } else if (ev.type === 'interrupt') {
      const ids = Array.isArray(ev.data?.toolCallIds) ? ev.data.toolCallIds : Array.isArray(ev.data?.ids) ? ev.data.ids : [];
      for (const raw of ids) {
        const id = raw ? String(raw) : '';
        if (id) pendingInterruptIds.push(id);
      }
    }
  }
  // 延迟补占位：只补「最终基线里确实缺 tool 回填」的 id，插在该 assistant 之后连续 tool 块末尾。
  for (const id of [...new Set(pendingInterruptIds)]) {
    if (messages.some((m) => m?.role === 'tool' && String(m.tool_call_id) === id)) continue;
    let assistantAt = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some((/** @type {any} */ tc) => String(tc?.id) === id)) {
        assistantAt = i;
        break;
      }
    }
    const placeholder = { role: 'tool', tool_call_id: id, content: INTERRUPTED_TOOL_CONTENT };
    if (assistantAt < 0) {
      // 找不到对应的 assistant（可能已被 compact 压掉）：不凭空造消息，避免重放与真实消息数组分叉。
      continue;
    }
    let insertAt = assistantAt + 1;
    while (insertAt < messages.length && messages[insertAt]?.role === 'tool') insertAt += 1;
    messages.splice(insertAt, 0, placeholder);
  }
  return messages;
}

/**
 * 供后续 UI/诊断用的 turn 摘要（可选；纯函数）。只从事件自己推导，不读消息正文。
 * @param {any[]} events
 * @returns {{turn:number, startedAt:number, endedAt:number|null, status:string, steps:number, toolCalls:number, usage:any}[]}
 */
export function deriveTurnSummaries(events) {
  /** @type {{turn:number, startedAt:number, endedAt:number|null, status:string, steps:number, toolCalls:number, usage:any}[]} */
  const out = [];
  /** @type {any} */
  let cur = null;
  for (const ev of ordered(events)) {
    if (ev.type === 'turn.start') {
      cur = { turn: out.length + 1, startedAt: ev.time, endedAt: null, status: 'running', steps: 0, toolCalls: 0, usage: null };
      out.push(cur);
    } else if (!cur) {
      continue;
    } else if (ev.type === 'step.start') {
      cur.steps += 1;
    } else if (ev.type === 'tool.start') {
      cur.toolCalls += 1;
    } else if (ev.type === 'usage') {
      cur.usage = ev.data?.usage ?? null;
    } else if (ev.type === 'turn.end') {
      cur.endedAt = ev.time;
      cur.status = String(ev.data?.status ?? 'done');
      cur = null;
    }
  }
  return out;
}

/**
 * 写失败时打一条**可见** warn（每个文件每进程一次）。事件日志是旁路，绝不能反过来影响调用方。
 * @param {string} eventFile
 * @param {string|null} error
 */
export function warnEventFailure(eventFile, error) {
  const file = String(eventFile || '');
  if (warnedFiles.has(file)) return;
  warnedFiles.add(file);
  try {
    console.warn(
      `[MingDao] ⚠ 会话事件日志写入失败（${file}）：${error || '未知原因'}——会话消息已正常写入，` +
        `事件日志本次不完整（可用 config.eventLog=false 或 MINGDAO_EVENT_LOG=0 关闭）。`
    );
  } catch {}
}
