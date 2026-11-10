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
//   · SSE 帧、UI、账本、同步都不读事件文件（切片 B1 起仅 `GET /api/events` 用 `readAfter` 只读游标读取）。
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

/**
 * 公开事件类型（v0.7.0 B2-a：12 → 13，新增 `messages.replace`）。
 *
 * **可忽略性是新增类型的前提**：读侧对未知 type 一律跳过并计入 `skipped`（见 `readEvents`），
 * 因此旧版读者遇到 `messages.replace` 只会当它不存在，不会把整份日志读坏；反过来，旧日志
 * （没有该类型）在本版照常可读——语义退化为「只有 compact/message.append」，不改变任何
 * 既有事件形状。新增类型必须同时更新这里与 `test/session-events.js` 的清单。
 */
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
  'messages.replace',
  'interrupt',
  'checkpoint',
]);

/**
 * 审批事件（v0.6.40 悬空闭合切片）：`approval.asked` / `approval.decided` 由审批轨道写入。
 *
 * 为什么不并进 `EVENT_TYPES`：那份清单是**对外公开**的事件类型（v0.7.0 B2-a 起 13 类），
 * 条数被回归套件（`test/session-events.js` ①）逐字钉死；本切片不允许改那套断言。但读取与
 * 追加又必须认它们——否则修补器看不见「永远在等审批」的悬空 ask，也没法把合成的 decided
 * 追加进日志。因此：`EVENT_TYPES` 仍是 13 类；内部可读写集合 = 13 类 + 审批 2 类。
 */
export const APPROVAL_EVENT_TYPES = Object.freeze(['approval.asked', 'approval.decided']);

/** 内部接受的事件类型：公共 13 类 + 审批 2 类（变量名保持 `EVENT_TYPE_SET`，既有变异锚点不变）。 */
const EVENT_TYPE_SET = new Set([...EVENT_TYPES, ...APPROVAL_EVENT_TYPES]);

/** 审批/工具的关联键字段（按优先级；没有键时按「最近一条」兜底配对）。 */
const APPROVAL_ID_FIELDS = Object.freeze(['requestId', 'approvalId', 'approvalRequestId', 'id', 'callId']);
const TOOL_ID_FIELDS = Object.freeze(['callId', 'toolCallId', 'id']);

/** 合成闭合事件的固定文案：工具结果未知（不是失败，是进程中断后无从得知）。 */
export const SYNTHETIC_TOOL_ERROR = '进程中断，工具结果未知';
/** 合成闭合事件的默认原因（`repairEventLog` 调用方也可覆盖）。 */
export const SYNTHETIC_REASON = '进程中断（启动时合成闭合事件）';

/** 回滚开关：`MINGDAO_EVENT_LOG=0`（或 false/off/no）时全局关闭双写。 */
export const EVENT_LOG_ENV = 'MINGDAO_EVENT_LOG';

/**
 * 事件日志**格式版本**（写在 `session.start` 的 `data.format` 里）。
 *
 * 为什么需要：0.6.42 之前 `rewriteSession()` 完全不写事件，旧日志**无法**从事件流恢复历史。
 * 对拍工具需要一个可靠依据来区分"旧日志不可回溯（历史噪声）"与"新日志重放回归（真 bug）"——
 * 靠"条数/前缀"猜是不行的（实测会把内容不一致误判成历史噪声）。这就是 DSH `session-format-v*` 的同一思路。
 *
 *   1 = 0.6.35–0.6.41：只有 appendMessages 双写，rewrite 无事件
 *   2 = 0.6.42 起：rewriteSession 也写 `messages.replace`
 */
export const EVENT_LOG_FORMAT = 2;

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
 *
 * v0.7.1 性能：**导出**给路由层取 `lastEventSeq`（`/api/session` 只想要一个整数，此前为了它
 * 调 `readAfter(...,0)` 整份解析，20k 事件时约 13.9ms；这里只读 64KB 尾窗）。
 * @param {string} file
 * @returns {{lastSeq: number, size: number, endsWithNewline: boolean}}
 */
export function readLastEventSeq(file) {
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
        const lastLineOf = (/** @type {string} */ text) => {
          const lines = text.split('\n').filter((l) => l.trim());
          return lines.length ? lines[lines.length - 1] : '';
        };
        let ok = false;
        try {
          const parsed = JSON.parse(lastLineOf(verify.text).replace(/\r$/, ''));
          ok = parsed?.seq === seq && parsed?.type === type;
        } catch {}
        // v0.7.0 B2-a：单条事件可能 > TAIL_BYTES（压缩摘要/工具结果/整份 messages.replace）。
        // 尾窗会把最后一行截断，JSON.parse 必然失败——这不是写失败。只在「尾窗确实没覆盖
        // 整个文件」时回退整文件重验最后一行（大事件才走这条路，代价与事件大小同阶）。
        if (!ok && verify.size > TAIL_BYTES) {
          try {
            const parsed = JSON.parse(lastLineOf(fs.readFileSync(file, 'utf8')).replace(/\r$/, ''));
            ok = parsed?.seq === seq && parsed?.type === type;
          } catch {}
        }
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

/**
 * 从游标处读取事件（v0.7.0 §1.1 切片 B1）：`GET /api/events?after=` 的数据源。
 *
 * **两套编号域（别混）**：本文件所有的 seq 都是**事件日志游标**——每个会话跨轮单调
 * （appendEvent 从 1 开始只增）。SSE 帧上的 `streamSeq` 是**每个 task 从 1 起**的流游标
 * （见 `web/server.js#createSseWriter`），用于客户端漏帧检测；两者互不推导，`after` 只收事件 seq。
 *
 * 语义（纯函数：只读文件、不改入参）：
 *   · 只返回 `seq > afterSeq` 的事件——**严格大于**：客户端持有的 `afterSeq` 那一帧已经收到过，
 *     重复下发会让「跳号检测」把重帧误判成跳号（DSH 的 cursor 语义同此）；
 *   · `lastSeq` 是**整条日志**的最大 seq（不是过滤后的最后一条）：客户端拿它建基线、判断是否追平；
 *   · `eventFile` 不存在（旧会话 / `eventLog=false`）是**正常形态**：`{ok:true, events:[], lastSeq:0}`，
 *     不是错误（事件日志是旁路，绝不能让旧会话读不了）；
 *   · `afterSeq` 非法（非数字 / 负数 / 非安全整数）按 0 处理，与 HTTP 层「after 缺省 = 0」同口径。
 *   · 复用 `readEvents`：torn 行 / 未知 type / 缺 seq 的行照旧跳过并计入 `skipped`（可见，不静默丢）。
 *
 * @param {string} eventFile
 * @param {number} [afterSeq]
 * @returns {{ok: boolean, error: string|null, events: SessionEvent[], lastSeq: number, skipped: number}}
 */
export function readAfter(eventFile, afterSeq = 0) {
  const n = Number(afterSeq);
  const after = Number.isSafeInteger(n) && n > 0 ? n : 0;
  const file = path.resolve(String(eventFile || ''));
  let tail;
  try {
    tail = readLastEventSeq(file);
  } catch (err) {
    return { ok: false, error: String(/** @type {any} */ (err)?.message ?? err), events: [], lastSeq: 0, skipped: 0 };
  }
  // v0.7.1 性能（读放大修复·降级策略）：事件是 append-only 且 seq 单调，尾窗的最后一条 seq 就是
  // 整条日志的最大 seq。`after` 已追平/超尾时直接空窗口返回，**不再整份解析**——SSE 续订每 15s
  // 轮询一次，绝大多数都落在这条近尾路径上（报告实测 20k 事件 cursor 与 full 同 ~13.9ms 的根因）。
  if (tail.lastSeq === 0 || after >= tail.lastSeq) {
    return { ok: true, error: null, events: [], lastSeq: tail.lastSeq, skipped: 0 };
  }
  // 需要中间段：尾窗给不出 `after` 之后的事件，退化为整份解析（after 远离末尾时的既有全量路径；
  // `events.idx` 字节偏移侧车是 v0.8 的事，本版只做到「近尾不整份」）。
  const read = readEvents(file);
  if (!read.ok) return { ok: false, error: read.error, events: [], lastSeq: tail.lastSeq, skipped: read.skipped };
  return { ok: true, error: null, events: read.events.filter((ev) => ev.seq > after), lastSeq: tail.lastSeq, skipped: read.skipped };
}

/**
 * 序号连续性自检（v0.7.0 §1.1 切片 B1）：给测试与服务端自检用，回答「这条流/这份日志有没有漏帧」。
 *
 * 判定：序号必须从 **1** 起、逐条 +1；`[]` 视为连续（没有事件就没有缺口）。任何不合法的序号
 * （非整数 / ≤0）同样算作缺口——「这一帧的编号都读不出来」与丢帧在客户端是同一件事。
 * 发现缺口后以**实际值**继续比较（`[1,3,4]` 只报一个缺口，而不是把 4 也连带报错）。
 *
 * @param {number[]} seqs 按到达顺序（应为升序）的 seq 列表
 * @returns {{ok: boolean, gaps: {after: number, before: number}[]}}
 *   `after` = 缺口前一条的 seq（首条缺 1 时为 0），`before` = 缺口后一条的 seq
 */
export function continuityOf(seqs) {
  const list = Array.isArray(seqs) ? seqs : [];
  /** @type {{after: number, before: number}[]} */
  const gaps = [];
  let expected = 1;
  for (const raw of list) {
    const seq = Number(raw);
    if (!Number.isSafeInteger(seq) || seq < 1) {
      gaps.push({ after: expected - 1, before: Number.isFinite(seq) && seq > 0 ? seq : 0 });
      continue; // 坏序号不推进 expected：下一条合法序号仍按原期望判定
    }
    if (seq !== expected) gaps.push({ after: expected - 1, before: seq });
    expected = seq + 1;
  }
  return { ok: gaps.length === 0, gaps };
}

/**
 * v0.6.40：中断 / 崩溃 / 等审批时关应用会留下**没有配对**的事件。这里把它们找出来。
 *
 * 纯函数：不读写文件、不改入参。配对规则（全部按 `seq` 升序处理）：
 *   · `approval.asked` ↔ `approval.decided`：按 requestId/approvalId/id/callId 配对；
 *     没有 id 时 decided 关闭最近一条无 id 的 ask（审批不嵌套）；
 *   · `tool.start` ↔ `tool.end`：按 callId/toolCallId/id 配对；没有 id 时同样关闭最近一条；
 *   · `turn.start` ↔ `turn.end`：turn 没有 id，用栈配对（end 关闭最近一次 start）；
 *   · **同 id 多次出现以最后一次为准**：后一次 start/asked 覆盖前一次，不会把已覆盖的旧事件报成悬空。
 *
 * @param {any[]} events
 * @returns {{asks: SessionEvent[], tools: SessionEvent[], turns: SessionEvent[]}}
 */
export function findDangling(events) {
  /** @type {Map<string, any>} */
  const asks = new Map();
  /** @type {Map<string, any>} */
  const tools = new Map();
  /** @type {any[]} */
  const turns = [];
  /** @param {any} ev @param {readonly string[]} fields @returns {string} */
  const idOf = (ev, fields) => {
    for (const f of fields) {
      const v = ev?.data?.[f];
      if (v !== null && v !== undefined && String(v) !== '') return String(v);
    }
    return '';
  };
  /**
   * 关闭 map 里最近一条（无 id 的 end/decided 兜底）。
   * @param {Map<string, any>} map
   */
  const closeLatest = (map) => {
    const keys = [...map.keys()];
    const last = keys.length ? keys[keys.length - 1] : '';
    if (last) map.delete(last);
  };
  for (const ev of ordered(events)) {
    if (ev.type === 'approval.asked') {
      const key = idOf(ev, APPROVAL_ID_FIELDS) || `#${ev.seq}`;
      asks.delete(key); // 先删再插：Map 的插入顺序也要反映「最后一次出现」
      asks.set(key, ev);
    } else if (ev.type === 'approval.decided') {
      const key = idOf(ev, APPROVAL_ID_FIELDS);
      if (key) asks.delete(key);
      else closeLatest(asks);
    } else if (ev.type === 'tool.start') {
      const key = idOf(ev, TOOL_ID_FIELDS) || `#${ev.seq}`;
      tools.delete(key); // 同上：覆盖时刷新插入顺序
      tools.set(key, ev);
    } else if (ev.type === 'tool.end') {
      const key = idOf(ev, TOOL_ID_FIELDS);
      if (key) tools.delete(key);
      else closeLatest(tools);
    } else if (ev.type === 'turn.start') {
      turns.push(ev);
    } else if (ev.type === 'turn.end') {
      turns.pop();
    }
  }
  /** @param {any} a @param {any} b @returns {number} */
  const bySeq = (a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0);
  return {
    asks: [...asks.values()].sort(bySeq).map(cloneSessionEvent),
    tools: [...tools.values()].sort(bySeq).map(cloneSessionEvent),
    turns: turns.sort(bySeq).map(cloneSessionEvent),
  };
}

/**
 * v0.6.40：为悬空事件合成**要追加**的闭合事件（纯函数，不写文件）。
 *
 * 顺序是嵌套的自然顺序：先 `approval.decided`（内层）→ 再 `tool.end` → 最后 `turn.end`。
 * 每条都带 `data.synthetic=true` 与 `data.reason`——重放/审计能一眼看出这是修补出来的事实，
 * 而不是真实发生过的结束。合成事件不带 `seq`：由 `appendEvent` 在锁内分配，保证接在尾部不重号。
 *
 * @param {{asks?: any[], tools?: any[], turns?: any[]}} dangling
 * @param {{at?: number|Date|null, reason?: string}} [opts]
 * @returns {{type: string, time: number, data: any}[]}
 */
export function synthClosers(dangling, { at = null, reason = '' } = {}) {
  const rawTime = Number(at instanceof Date ? at.getTime() : at);
  const time = Number.isFinite(rawTime) && rawTime > 0 ? rawTime : Date.now();
  const why = String(reason || SYNTHETIC_REASON);
  /** @type {{type: string, time: number, data: any}[]} */
  const closers = [];
  const asks = Array.isArray(dangling?.asks) ? dangling.asks : [];
  const tools = Array.isArray(dangling?.tools) ? dangling.tools : [];
  const turns = Array.isArray(dangling?.turns) ? dangling.turns : [];
  /** @param {any} ev @param {readonly string[]} fields @returns {{field: string, value: any}|null} */
  const keyOf = (ev, fields) => {
    for (const f of fields) {
      const v = ev?.data?.[f];
      if (v !== null && v !== undefined && String(v) !== '') return { field: f, value: v };
    }
    return null;
  };
  for (const ask of asks) {
    /** @type {any} */
    const data = { decision: 'aborted', synthetic: true, reason: why };
    const key = keyOf(ask, APPROVAL_ID_FIELDS);
    if (key) data[key.field] = key.value; // 带上原 ask 的关联键，否则第二次 findDangling 仍配不上
    closers.push({ type: 'approval.decided', time, data });
  }
  for (const tool of tools) {
    /** @type {any} */
    const data = { ok: false, error: SYNTHETIC_TOOL_ERROR, synthetic: true, reason: why };
    if (tool?.data?.name !== undefined) data.name = String(tool.data.name);
    const key = keyOf(tool, TOOL_ID_FIELDS);
    if (key) data[key.field] = key.value;
    closers.push({ type: 'tool.end', time, data });
  }
  for (let i = 0; i < turns.length; i += 1) {
    // 每条悬空 turn 各补一条；事件形状不需要 turn 的任何字段。
    closers.push({ type: 'turn.end', time, data: { status: 'aborted', synthetic: true, reason: why } });
  }
  return closers;
}

/**
 * v0.6.40：闭合一个事件日志里的悬空事件。**只追加，不删除/不改写既有行**。
 *
 * 流程：读全量事件 → `findDangling` → 有悬空才 `synthClosers` → 逐条走 `appendEvent`
 * （从而拿到锁内分配的连续 seq）。没有悬空时**连文件都不碰**（返回 repaired:0）。
 *
 * 损坏日志：`readEvents` 会把半截 JSON / 未知 type / 缺 seq 的行计入 `skipped`。只要
 * `skipped > 0` 就视为日志损坏，返回 `{ok:false}` 且**一个字节都不写**——修补器的前提是
 * 「日志是完整的、只是缺收尾」，在坏日志上追加只会把损坏固化进事实源。
 *
 * @param {string} eventFile 事件文件（`.events.ndjson`，不是会话 `.jsonl`）
 * @param {{reason?: string}} [opts]
 * @param {{ok: boolean, error: string|null, events: any[], skipped: number}|null} [pre] v0.7.1 性能：调用方已用 `readEvents`
 *   解析好的产物（`loadSession` 一次解析喂给派生与修补）；缺省时自己读。传入时仍保留「skipped>0 拒绝修补」。
 * @returns {{ok: boolean, error: string|null, repaired: number, dangling: {asks:any[],tools:any[],turns:any[]}, disabled?: boolean}}
 */
export function repairEventLog(eventFile, { reason = '' } = {}, pre = null) {
  /** @type {{asks:any[],tools:any[],turns:any[]}} */
  const empty = { asks: [], tools: [], turns: [] };
  try {
    const file = path.resolve(String(eventFile || ''));
    if (!String(eventFile || '')) return { ok: false, error: '事件文件路径为空', repaired: 0, dangling: empty };
    if (!eventLogEnabled()) return { ok: true, error: null, repaired: 0, dangling: empty, disabled: true };
    const read = pre && pre.ok ? pre : readEvents(file);
    if (!read.ok) return { ok: false, error: read.error ?? '读取事件日志失败', repaired: 0, dangling: empty };
    if (read.skipped > 0) {
      return { ok: false, error: `事件日志损坏（跳过 ${read.skipped} 行），拒绝修补`, repaired: 0, dangling: empty };
    }
    const dangling = findDangling(read.events);
    const closers = synthClosers(dangling, { reason });
    if (!closers.length) return { ok: true, error: null, repaired: 0, dangling };
    let repaired = 0;
    for (const closer of closers) {
      const r = appendEvent(file, { type: closer.type, data: closer.data, at: closer.time });
      if (!r.ok) return { ok: false, error: r.error ?? '追加闭合事件失败', repaired, dangling };
      repaired += 1;
    }
    return { ok: true, error: null, repaired, dangling };
  } catch (err) {
    return { ok: false, error: String(/** @type {any} */ (err)?.message ?? err), repaired: 0, dangling: empty };
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
 * 悬空事件的对外快照：只保留 `seq/time/type/data`，data 深拷贝。
 * 找悬空是纯函数，调用方拿到的对象不能反过来改到入参上。
 * @param {any} ev
 * @returns {SessionEvent}
 */
function cloneSessionEvent(ev) {
  return {
    seq: Number.isInteger(Number(ev?.seq)) ? Number(ev.seq) : 0,
    time: Number.isFinite(Number(ev?.time)) ? Number(ev.time) : 0,
    type: String(ev?.type || ''),
    data: cloneJson(ev?.data && typeof ev.data === 'object' ? ev.data : {}),
  };
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
 *   · `compact` / `messages.replace`：`data.messages` 是**新基线**，整体替换当前窗口
 *     （后续 message.append 按 seq 顺序接在它后面）。两者语义相同：`compact` 是切片 A 的旧
 *     类型，`messages.replace`（v0.7.0 B2-a）覆盖压缩 / rewrite / resume 等所有整份重写。
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
    } else if (ev.type === 'compact' || ev.type === 'messages.replace') {
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
 * 单条消息的 `content` 结构化比较（v0.7.1 性能）：普通字符串直接 `===`，非字符串才退回 JSON
 * 序列化等价比较。与旧实现「整条 JSON.stringify 后比字符串」严格等价——旧实现里 content 就嵌在
 * 整串里、键序固定，逐字段独立比较不会改变判定（`m?.content ?? ''` 把 null/undefined 归一成 `''`）。
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function sameContent(a, b) {
  const ca = a?.content ?? '';
  const cb = b?.content ?? '';
  if (ca === cb) return true;
  try {
    return JSON.stringify(ca) === JSON.stringify(cb);
  } catch {
    return false;
  }
}

/**
 * 单条消息的结构化等价判定（与旧 `norm` 整条 stringify 严格等价）：
 *   · `role` 一律 `String(m?.role ?? '')`；
 *   · `content` 见 `sameContent`；
 *   · `tool_calls` 只在两侧都是数组时参与比较，且只比 id（`String(t?.id ?? '')` 排序后）——
 *     name/arguments 差异**不**判不等（与旧实现一致）；仅这一处对 id 数组做序列化比较；
 *   · `tool_call_id` 的「是否存在」（`!= null`）与字符串值分别比较。
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function sameMessageShape(a, b) {
  if (String(a?.role ?? '') !== String(b?.role ?? '')) return false;
  if (!sameContent(a, b)) return false;
  const ta = Array.isArray(a?.tool_calls);
  const tb = Array.isArray(b?.tool_calls);
  if (ta !== tb) return false;
  if (ta && JSON.stringify(a.tool_calls.map((/** @type {any} */ t) => String(t?.id ?? '')).sort()) !== JSON.stringify(b.tool_calls.map((/** @type {any} */ t) => String(t?.id ?? '')).sort())) return false;
  const ida = a?.tool_call_id != null ? String(a.tool_call_id) : null;
  const idb = b?.tool_call_id != null ? String(b.tool_call_id) : null;
  return ida === idb;
}

/**
 * 比较两个消息数组（v0.7.0 B2-b 从 `scripts/event-parity.mjs` 抽出的共享判据）。
 *
 * 逐条按 `role + content + tool_calls`（tool_calls 只比 id，排序后）比较；`_` 开头的运行时注记
 * 不落盘、不参与比较。**必须与 scripts/event-parity.mjs 的 `diffMessages` 保持同一语义**：
 * 对拍工具说「等价」的会话，`loadSession({eventSource:'events'})` 才能采用派生结果；两边判据
 * 一旦漂移，对拍结论与灰度读取就会互相打脸。
 *
 * v0.7.1 性能：从「逐条整段 JSON.stringify 后比字符串」改为结构化比较（见 `sameMessageShape`），
 * 20k 条的两侧数组原本要做 4 万次整段序列化；现在普通字符串消息零序列化，只有 tool_calls 的
 * id 数组做序列化比较，且语义与旧实现**逐字节等价**（由 `test/event-parity.js` /
 * `test/event-source.js` 与 `test/session-read-path.js` 的对拍夹具共同钉住）。
 *
 * 为什么不直接 import 脚本：`scripts/` 不在 `package.json#files`（npm 安装形态没有它），
 * 且 tsconfig 会把脚本拉进类型检查；因此判据放在 src 侧，脚本侧保留同名实现（硬约束：本切片
 * 不改 `scripts/event-parity.mjs`）。
 *
 * @param {any[]} a
 * @param {any[]} b
 * @returns {{ok:boolean, index:number, reason:string}}
 */
export function diffMessages(a, b) {
  const A = Array.isArray(a) ? a : [];
  const B = Array.isArray(b) ? b : [];
  if (A.length !== B.length) return { ok: false, index: Math.min(A.length, B.length), reason: `条数不同：消息 ${A.length} vs 重放 ${B.length}` };
  for (let i = 0; i < A.length; i += 1) {
    if (!sameMessageShape(A[i], B[i])) return { ok: false, index: i, reason: `第 ${i + 1} 条不同` };
  }
  return { ok: true, index: -1, reason: '' };
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
