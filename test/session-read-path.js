// 会话读路径性能（v0.7.1 头条）：事件真源读放大 + 会话列表 N×2 全文件读的独立回归套件。
//
// 为什么单独一套：v0.7.0「事件真源翻转」引入了读放大回退——`readAfter` 游标是装饰性的（整份解析
// 再 filter）、`/api/session` 为取一个整数整份解析事件日志、`loadSession` 一次解析三次事件日志、
// `diffMessages` 逐条整段 JSON.stringify、会话列表每个会话同步读全文件两次。
// 本套件只钉**读路径**的硬性质（不改会话写锁）：
//   ① `readLastEventSeq` 只读 64KB 尾窗且正确导出（路由 lastEventSeq 不再整份解析）；
//   ② `readAfter` 真游标化：after 追平/超尾时不再整份解析（坏行在中间、尾窗干净即可证明）；
//   ③ `loadSession` 对同一会话只 `readEvents` 一次（派生与修补共用同一份产物）；
//   ④ `diffMessages` 结构化比较：普通消息零序列化，且与原整段 stringify **逐字节等价**；
//   ⑤ `sessionPreview` 只读文件头 8KB（找不到才读全量兜底）；消息计数用 mtime+size 缓存；
//   ⑥ 性能守卫：只断言「读取字节 < 全文件一半」，不断言具体毫秒（避免负载假红）。
//
// 运行：node test/session-read-path.js（不依赖网络）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');

// 隔离 home：必须在 import 路由之前设好（workspace/config 的 mingdaoHome 懒读，但保持一致）。
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-read-path-'));
const home = path.join(base, 'home');
const homeSessions = path.join(home, 'sessions');
fs.mkdirSync(homeSessions, { recursive: true, mode: 0o700 });
process.env.MINGDAO_HOME = home;
delete process.env.MINGDAO_EVENT_LOG;
delete process.env.MINGDAO_EVENT_SOURCE;

const E = await import(pathToFileURL(path.join(srcDir, 'session-events.js')).href);
E.setEventLogEnabled(true);

let passed = 0;
/** @param {string} name */
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

/** 直接写 N 条合法事件（不走 appendEvent 的锁，10k 条时避免 O(N²)）。 */
function writeEvents(file, n) {
  const lines = [];
  for (let i = 1; i <= n; i += 1) {
    lines.push(JSON.stringify({ seq: i, time: 1000 + i, type: 'message.append', data: { message: { role: 'user', content: `m${i}` } } }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

/** 单条合法事件行（可指定 seq）。 */
function eventLine(seq) {
  return JSON.stringify({ seq, time: 1000 + seq, type: 'message.append', data: { message: { role: 'user', content: `m${seq}` } } });
}

// ===========================================================================
// ① readLastEventSeq：导出 + 尾窗读（空文件 / 未换行尾行 / 大文件）
//    （放在 session.js / 路由 import **之前**：变异去掉 export 时路由 import 会先崩，
//      必须让「readLastEventSeq 必须导出」这条断言先抓到，而不是逃逸成 import 报错。）
// ===========================================================================
{
  assert.equal(typeof E.readLastEventSeq, 'function', 'readLastEventSeq 必须导出（供路由 lastEventSeq 取整数）');
  ok('① readLastEventSeq 已导出');

  const empty = path.join(base, 'empty.events.ndjson');
  fs.writeFileSync(empty, '');
  assert.equal(E.readLastEventSeq(empty).lastSeq, 0, 'readLastEventSeq：空文件 lastSeq 必须为 0');
  ok('② readLastEventSeq 空文件 → lastSeq 0');

  const noNewline = path.join(base, 'no-newline.events.ndjson');
  fs.writeFileSync(noNewline, eventLine(1) + '\n' + eventLine(2) + '\n' + eventLine(3)); // 未换行尾行
  assert.equal(E.readLastEventSeq(noNewline).lastSeq, 3, 'readLastEventSeq：未换行尾行必须仍取到最后一条 seq');
  assert.equal(E.readLastEventSeq(noNewline).endsWithNewline, false, 'readLastEventSeq：未换行尾行 endsWithNewline 必须为 false');
  ok('③ readLastEventSeq 未换行尾行 → 正确 lastSeq + endsWithNewline=false');

  const big = path.join(base, 'big.events.ndjson');
  writeEvents(big, 5000); // 明显超过 64KB 尾窗
  assert.equal(E.readLastEventSeq(big).lastSeq, 5000, 'readLastEventSeq：大文件（>64KB）必须读尾窗取到最后一条 seq');
  ok('④ readLastEventSeq 大文件（>64KB）→ lastSeq=5000');
}

const S = await import(pathToFileURL(path.join(srcDir, 'session.js')).href);
const Routes = await import(pathToFileURL(path.join(srcDir, 'web', 'routes', 'domains', 'sessions.js')).href);

// ===========================================================================
// ② readAfter 真游标化：after=0 全量；after=lastSeq 只读尾窗、不整份解析
// ===========================================================================
{
  const small = path.join(base, 'small.events.ndjson');
  writeEvents(small, 3);
  const all = E.readAfter(small, 0);
  assert.deepEqual(all.events.map((e) => e.seq), [1, 2, 3], 'readAfter(after=0) 必须仍返回全部事件');
  assert.equal(all.lastSeq, 3, 'readAfter(after=0) lastSeq 必须为最大 seq');
  assert.equal(all.skipped, 0, 'readAfter(after=0) 干净日志 skipped 必须为 0');
  ok('⑤ readAfter(after=0) 仍全量：events=[1,2,3] + lastSeq=3');

  const tail = E.readAfter(small, 3);
  assert.deepEqual(tail.events, [], 'readAfter(after=lastSeq) 必须返回空窗口');
  assert.equal(tail.lastSeq, 3, 'readAfter(after=lastSeq) lastSeq 仍必须为最大值');
  assert.equal(tail.skipped, 0, 'readAfter(after=lastSeq) 必须只读尾窗、不整份解析（坏行不得计入 skipped）');
  ok('⑥ readAfter(after=lastSeq) 追平 → 空窗口 + lastSeq 不变 + skipped=0');

  // 坏行塞在**中部**、尾窗干净：after=0 全量会数到 skipped=1；after=lastSeq 只读尾窗 skipped=0。
  const mid = path.join(base, 'mid-bad.events.ndjson');
  const lines = [];
  for (let i = 1; i <= 1500; i += 1) lines.push(eventLine(i));
  lines.push('{"seq":1501,"type":"message.append","data":{"message":'); // 中部坏行（半截 JSON）
  for (let i = 1501; i <= 3000; i += 1) lines.push(eventLine(i));
  fs.writeFileSync(mid, lines.join('\n') + '\n');
  const full = E.readAfter(mid, 0);
  assert.equal(full.skipped, 1, '夹具前提：after=0 全量必须数到中部坏行（skipped=1）');
  assert.equal(E.readLastEventSeq(mid).lastSeq, 3000, '夹具前提：尾窗必须干净（lastSeq=3000）');
  const tailOnly = E.readAfter(mid, 3000);
  assert.deepEqual(tailOnly.events, [], 'readAfter(after=lastSeq) 追平时必须返回空窗口');
  assert.equal(tailOnly.skipped, 0, 'readAfter(after=lastSeq) 必须只读尾窗、不整份解析（中部坏行不得计入 skipped）');
  ok('⑦ readAfter(after=lastSeq) 只读尾窗：中部坏行 skipped 从 1 → 0（证明未整份解析）');

  const missing = E.readAfter(path.join(base, 'no-such.events.ndjson'), 0);
  assert.equal(missing.ok, true, 'readAfter：事件文件不存在（旧会话）必须 ok:true');
  assert.deepEqual(missing.events, [], 'readAfter：事件文件不存在必须空窗口');
  assert.equal(missing.lastSeq, 0, 'readAfter：事件文件不存在 lastSeq 必须为 0');
  ok('⑧ readAfter 旧会话（无事件文件）→ {ok:true,lastSeq:0,events:[]}');
}

// ===========================================================================
// ③ loadSession 对同一会话只 readEvents 一次
// ===========================================================================
{
  const sessionFile = path.join(homeSessions, 'once.jsonl');
  S.appendMessages(sessionFile, [
    { role: 'user', content: '读一次' },
    { role: 'assistant', content: '回复' },
  ]);
  const eventFile = E.eventFileFor(sessionFile);
  let eventReads = 0;
  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = function (p, ...args) {
    if (path.resolve(String(p)) === path.resolve(eventFile)) eventReads += 1;
    return realReadFileSync.call(fs, p, ...args);
  };
  let loaded;
  try {
    loaded = S.loadSession(sessionFile, { eventSource: 'events' });
  } finally {
    fs.readFileSync = realReadFileSync;
  }
  assert.deepEqual(loaded.messages.map((m) => m.content), ['读一次', '回复'], 'loadSession 派生结果必须仍正确');
  assert.equal(eventReads, 1, 'loadSession 只 readEvents 一次（派生与修补共用同一份产物）');
  ok('⑨ loadSession 对同一会话只 readEvents 一次');
}

// ===========================================================================
// ④ diffMessages 结构化比较：与旧整段 stringify 逐字节等价 + 零序列化
// ===========================================================================
{
  // 旧实现的等价参照（整段 stringify 后比字符串），用于钉「语义严格等价」。
  const refDiffMessages = (a, b) => {
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
  };

  const pairs = [
    [{ role: 'user', content: 'hi' }, { role: 'user', content: 'hi' }],
    [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }],
    [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'a' }],
    [{ role: 'user' }, { role: 'user', content: '' }],
    [{ role: 'user', content: null }, { role: 'user', content: '' }],
    [{ role: 'user', content: 0 }, { role: 'user', content: '0' }],
    [{ role: 'user', content: { a: 1, b: 2 } }, { role: 'user', content: { b: 2, a: 1 } }],
    [{ role: 'assistant', content: null, tool_calls: [{ id: 'x' }, { id: 'y' }] }, { role: 'assistant', content: null, tool_calls: [{ id: 'y' }, { id: 'x' }] }],
    [{ role: 'assistant', content: null, tool_calls: [{ id: 'x', function: { name: 'read', arguments: '{}' } }] }, { role: 'assistant', content: null, tool_calls: [{ id: 'x', function: { name: 'bash', arguments: '{"a":1}' } }] }],
    [{ role: 'assistant', content: null, tool_calls: [] }, { role: 'assistant', content: null }],
    [{ role: 'tool', tool_call_id: '', content: 'x' }, { role: 'tool', tool_call_id: 0, content: 'x' }],
    [{ role: 'tool', tool_call_id: null, content: 'x' }, { role: 'tool', content: 'x' }],
  ];
  for (const [a, b] of pairs) {
    assert.deepEqual(E.diffMessages(a, b), refDiffMessages(a, b), 'diffMessages 结构化比较必须与原整段 stringify 语义逐字节等价');
  }
  assert.equal(E.diffMessages([{ role: 'user', content: 'x' }], [{ role: 'user', content: 'x' }, { role: 'user', content: 'y' }]).ok, false, 'diffMessages 条数不同必须判不等');
  assert.equal(E.diffMessages([{ role: 'user', content: 'x' }], [{ role: 'user', content: 'y' }]).reason, '第 1 条不同', 'diffMessages 内容不同必须报首条差异位置');
  ok('⑩ diffMessages 结构化比较与原整段 stringify 语义逐字节等价（12 组夹具）');

  // 结构化比较对普通字符串消息零序列化：整段 stringify 会做 N 次，这里必须远小于 N。
  const N = 200;
  const msgs = Array.from({ length: N }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: `msg-${i}` }));
  let stringifyCalls = 0;
  const realStringify = JSON.stringify;
  JSON.stringify = function (...args) {
    stringifyCalls += 1;
    return realStringify.apply(JSON, args);
  };
  let r;
  try {
    r = E.diffMessages(msgs, msgs);
  } finally {
    JSON.stringify = realStringify;
  }
  assert.equal(r.ok, true, 'diffMessages 等价数组必须 ok:true');
  assert.ok(stringifyCalls < N, `diffMessages 结构化比较不得逐条整段 stringify（${stringifyCalls} 次 vs ${N} 条）`);
  ok('⑪ diffMessages 结构化比较对普通字符串消息零整段序列化（< N 次）');
}

// ===========================================================================
// ⑤ sessionPreview 只读文件头 8KB
// ===========================================================================
{
  const pv = path.join(base, 'preview.jsonl');
  fs.writeFileSync(pv, JSON.stringify({ role: 'user', content: '你好' }) + '\n' + JSON.stringify({ role: 'assistant', content: '回复' }) + '\n');
  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = function () {
    throw new Error('sessionPreview 不该全文件读');
  };
  try {
    assert.equal(S.sessionPreview(pv), '你好', 'sessionPreview 只读头部（首条 user 在 8KB 内不得全文件读）');
  } finally {
    fs.readFileSync = realReadFileSync;
  }
  ok('⑫ sessionPreview 首条 user 在头部：只读 8KB、不整份 readFileSync');

  const huge = 'x'.repeat(20000);
  const long = path.join(base, 'preview-long.jsonl');
  fs.writeFileSync(long, JSON.stringify({ role: 'user', content: huge }) + '\n');
  assert.equal(S.sessionPreview(long), huge.slice(0, 60), 'sessionPreview 首行超长（>8KB）时必须读全量兜底取到首条 user');
  ok('⑬ sessionPreview 超长首行（>8KB）读全量兜底');

  const nonUser = path.join(base, 'preview-nonuser.jsonl');
  fs.writeFileSync(nonUser, JSON.stringify({ role: 'system', content: 'sys' }) + '\n' + JSON.stringify({ role: 'user', content: 'hi' }) + '\n');
  assert.equal(S.sessionPreview(nonUser), 'hi', 'sessionPreview 首条非 user 时必须跳过、取首条 user');
  ok('⑭ sessionPreview 首条非 user：跳过 system 取首条 user');

  const emptyFile = path.join(base, 'preview-empty.jsonl');
  fs.writeFileSync(emptyFile, '');
  assert.equal(S.sessionPreview(emptyFile), '(无内容)', 'sessionPreview 空文件必须返回 (无内容)');
  ok('⑮ sessionPreview 空文件 → (无内容)');
}

// ===========================================================================
// ⑥ 性能守卫：10k 事件，after=lastSeq 只读尾窗（读取字节 < 全文件一半）
// ===========================================================================
{
  const perf = path.join(base, 'perf.events.ndjson');
  writeEvents(perf, 10000);
  const size = fs.statSync(perf).size;
  const lastSeq = E.readLastEventSeq(perf).lastSeq;
  assert.equal(lastSeq, 10000, '夹具前提：10k 事件文件 lastSeq 必须为 10000');

  let bytes = 0;
  const realReadFileSync = fs.readFileSync;
  const realReadSync = fs.readSync;
  fs.readFileSync = function (p, ...args) {
    const result = realReadFileSync.call(fs, p, ...args);
    if (typeof result === 'string') bytes += Buffer.byteLength(result, 'utf8');
    else if (result && Buffer.isBuffer(result)) bytes += result.length;
    return result;
  };
  fs.readSync = function (fd, buffer, offset, length, position, ...rest) {
    bytes += Number(length) || 0;
    return realReadSync.call(fs, fd, buffer, offset, length, position, ...rest);
  };
  let r;
  try {
    r = E.readAfter(perf, lastSeq);
  } finally {
    fs.readFileSync = realReadFileSync;
    fs.readSync = realReadSync;
  }
  assert.deepEqual(r.events, [], 'readAfter(after=lastSeq) 10k 事件追平时必须返回空窗口');
  assert.ok(bytes < size / 2, `readAfter(after=lastSeq) 必须只读尾窗（读取字节 ${bytes} 须小于全文件一半 ${Math.floor(size / 2)}）`);
  ok('⑯ readAfter(after=lastSeq) 性能守卫：读取字节 < 全文件一半（10k 事件）');
}

// ===========================================================================
// ⑦ 路由 lastEventSeq 复用 readLastEventSeq（尾窗），不回退 readAfter 全量解析
// ===========================================================================
{
  const sessionFile = path.join(homeSessions, 'route.jsonl');
  S.appendMessages(sessionFile, [
    { role: 'user', content: '路由测试' },
    { role: 'assistant', content: '回复' },
  ]);
  const eventFile = E.eventFileFor(sessionFile);
  const lastSeq = E.readLastEventSeq(eventFile).lastSeq;

  let eventReads = 0;
  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = function (p, ...args) {
    if (path.resolve(String(p)) === path.resolve(eventFile)) eventReads += 1;
    return realReadFileSync.call(fs, p, ...args);
  };
  let body = null;
  let hit = false;
  try {
    const ctx = {
      req: {},
      res: {},
      method: 'GET',
      p: '/api/session',
      url: new URL(`http://x/api/session?file=${encodeURIComponent('route.jsonl')}`),
    };
    const deps = {
      home,
      state: { workingDir: path.join(home, 'work') },
      draftTexts: new Map(),
      cfg: {},
    };
    const shared = {
      json: (res, code, b) => {
        body = b;
      },
      readBody: async () => ({}),
      MAX_API_BODY: 1024 * 1024,
    };
    hit = await Routes.handle(ctx, deps, shared);
  } finally {
    fs.readFileSync = realReadFileSync;
  }
  assert.equal(hit, true, '路由 /api/session 必须命中');
  assert.equal(eventReads, 1, '路由 lastEventSeq 必须复用 readLastEventSeq（尾窗），不得回退 readAfter 全量解析');
  assert.equal(body && body.lastEventSeq, lastSeq, '路由 lastEventSeq 必须等于事件日志最大 seq');
  ok('⑰ 路由 /api/session lastEventSeq 复用 readLastEventSeq（不整份解析）');
}

// ===========================================================================
// ⑧ 消息计数缓存：mtime+size 双键（mtime 不变、size 变也必须重新计数）
// ===========================================================================
{
  const f = path.join(base, 'count-cache.jsonl');
  fs.writeFileSync(f, JSON.stringify({ role: 'user', content: 'a' }) + '\n');
  const sec = Math.floor(Date.now() / 1000);
  fs.utimesSync(f, sec, sec); // 整秒 mtime，保证随后恢复时逐字节一致
  const n1 = Routes.sessionMessageCount(f, null);
  assert.equal(n1, 1, '计数缓存冷读必须返回 1');
  fs.appendFileSync(f, JSON.stringify({ role: 'assistant', content: 'b' }) + '\n'); // size 变、mtime 变
  fs.utimesSync(f, sec, sec); // mtime 拨回原值（同秒追加：mtime 不变、size 已变）
  const n2 = Routes.sessionMessageCount(f, null);
  assert.equal(n2, 2, '计数缓存必须按 mtime+size 判失效（mtime 不变、size 变也要重新计数）');
  ok('⑱ 计数缓存按 mtime+size 判失效（mtime 不变、size 变重新计数）');
}

console.log(`\nsession-read-path：${passed} 项全部通过`);
