// SSE 单调 seq + 事件游标读取（v0.7.0 §1.1 切片 B1）的独立回归套件。
//
// 这一层要证明的三件事（对应路线图验收 ①②③）：
//   ① SSE 帧带 **按 task 从 1 起** 的连续 seq，并同时写标准 `id: <seq>` 行——
//      客户端据此发现跳号；seq 若按全局/会话累加，两个并发任务会互相占号，跳号检测直接失效；
//      心跳 progress 也是状态更新，**不能漏 seq**；
//   ② `GET /api/events?file=&after=` 按 `seq > after` 严格过滤，参数非法/目录穿越/会话不存在
//      各有明确状态码；旧会话没有事件文件时返回空窗口（200，不是 404）；
//   ③ `readAfter` / `continuityOf` 是纯函数：游标读取只读文件；连续性自检能指出缺口
//      （`gaps:[{after,before}]`），服务端与测试共用同一份判据。
//
// 事件日志的 seq（session-events.js，按会话、跨 task 连续）与 SSE 的 seq（按 task）
// 是**两套编号**：本套件分别钉住「两轮 chat 的 SSE 各自从 1 起」与「事件日志 seq 不重置」。
//
// 运行：node test/event-cursor.js（不依赖外网；内置 mock Provider + 真实 HTTP 服务器）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');

// 隔离 home：必须在 import 配置/服务器之前设好（runWebServer 用它 ensureHome）。
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-event-cursor-'));
const home = path.join(base, 'home');
fs.mkdirSync(path.join(home, 'sessions'), { recursive: true, mode: 0o700 });
process.env.MINGDAO_HOME = home;
delete process.env.MINGDAO_EVENT_LOG;

const E = await import(pathToFileURL(path.join(srcDir, 'session-events.js')).href);
const { runWebServer } = await import(pathToFileURL(path.join(srcDir, 'web', 'server.js')).href);

let passed = 0;
/** @param {string} name */
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

// ---------------------------------------------------------------------------
// ① 纯函数：readAfter / continuityOf
// ---------------------------------------------------------------------------
const pureDir = path.join(base, 'pure');
fs.mkdirSync(pureDir, { recursive: true });

{
  const eventFile = path.join(pureDir, 'basic.events.ndjson');
  for (let i = 0; i < 3; i += 1) {
    const r = E.appendEvent(eventFile, { type: 'turn.start', data: { i } });
    assert.equal(r.ok, true, `夹具写入必须成功：${r.error}`);
  }
  const all = E.readAfter(eventFile, 0);
  assert.equal(all.ok, true, 'readAfter：可读文件必须 ok:true');
  assert.deepEqual(all.events.map((e) => e.seq), [1, 2, 3], 'readAfter(after=0) 必须返回全部事件（seq 1..3）');
  assert.equal(all.lastSeq, 3, 'readAfter：lastSeq 必须是整条日志的最大 seq');
  assert.equal(all.skipped, 0, 'readAfter：完整日志的 skipped 必须为 0');
  ok('① readAfter(after=0)：返回全部事件 + lastSeq=最大 seq');
}
{
  const eventFile = path.join(pureDir, 'basic.events.ndjson');
  const part = E.readAfter(eventFile, 2);
  assert.deepEqual(part.events.map((e) => e.seq), [3], 'readAfter(after=2) 只返回 seq > 2 的事件（严格大于，重帧不算）');
  assert.equal(part.lastSeq, 3, 'readAfter：过滤不得改变 lastSeq（客户端要靠它判断是否追平）');
  const beyond = E.readAfter(eventFile, 99);
  assert.deepEqual(beyond.events, [], 'after 超过最大 seq 时必须返回空窗口');
  assert.equal(beyond.lastSeq, 3, 'after 超过最大 seq 时 lastSeq 仍必须是日志最大值');
  const neg = E.readAfter(eventFile, -5);
  assert.deepEqual(neg.events.map((e) => e.seq), [1, 2, 3], 'after 为负数时按 0 处理（返回全部）');
  ok('② readAfter 边界：after 严格过滤 / 超出尾部空窗口 / 负数按 0');
}
{
  const missing = E.readAfter(path.join(pureDir, 'no-such.events.ndjson'), 0);
  assert.equal(missing.ok, true, '事件文件不存在（旧会话）必须 ok:true，不是错误');
  assert.deepEqual(missing.events, [], '事件文件不存在时事件必须为空');
  assert.equal(missing.lastSeq, 0, '事件文件不存在时 lastSeq 必须为 0');
  ok('③ readAfter：事件文件不存在 → {ok:true,lastSeq:0,events:[]}（旧会话正常形态）');
}
{
  const eventFile = path.join(pureDir, 'torn.events.ndjson');
  assert.equal(E.appendEvent(eventFile, { type: 'turn.start', data: {} }).ok, true, '夹具写入必须成功');
  fs.appendFileSync(eventFile, '{"seq":2,"type":"turn.end"'); // 半截 JSON（崩溃残留）
  fs.appendFileSync(eventFile, '\n');
  assert.equal(E.appendEvent(eventFile, { type: 'turn.end', data: {} }).ok, true, '夹具写入必须成功');
  const torn = E.readAfter(eventFile, 0);
  assert.equal(torn.ok, true, 'torn 行不得让读取失败');
  assert.equal(torn.skipped, 1, 'torn 行必须计入 skipped（可见，不静默丢）');
  assert.deepEqual(torn.events.map((e) => e.seq), [1, 2], 'torn 行必须被跳过，其余事件照常返回（seq 由 appendEvent 重新分配）');
  assert.equal(torn.lastSeq, 2, 'torn 行不得影响 lastSeq（以最后一条可解析事件为准）');
  assert.deepEqual(E.readAfter(eventFile, 1).events.map((e) => e.seq), [2], 'torn 行跳过后的游标过滤仍然严格按 seq');
  ok('④ readAfter：torn 行计入 skipped，seq 过滤与 lastSeq 不受影响');
}
{
  const clean = E.continuityOf([1, 2, 3, 4]);
  assert.equal(clean.ok, true, 'continuityOf：连续序号必须 ok:true');
  assert.deepEqual(clean.gaps, [], 'continuityOf：连续序号不得报缺口');
  assert.equal(E.continuityOf([]).ok, true, 'continuityOf：空列表视为连续');
  assert.equal(E.continuityOf([1]).ok, true, 'continuityOf：单条 seq=1 视为连续');
  ok('⑤ continuityOf：连续 / 空 / 单条 → ok:true，gaps=[]');
}
{
  const one = E.continuityOf([1, 3, 4]);
  assert.equal(one.ok, false, 'continuityOf：跳号必须被识别（ok:false）');
  assert.deepEqual(one.gaps, [{ after: 1, before: 3 }], 'continuityOf：单缺口必须报 {after:1,before:3}（且不连带误报 4）');
  const many = E.continuityOf([1, 3, 6]);
  assert.deepEqual(
    many.gaps,
    [
      { after: 1, before: 3 },
      { after: 3, before: 6 },
    ],
    'continuityOf：多个缺口必须逐个报出'
  );
  const notOne = E.continuityOf([2, 3]);
  assert.equal(notOne.ok, false, 'continuityOf：不是从 1 起也必须判为不连续');
  assert.deepEqual(notOne.gaps, [{ after: 0, before: 2 }], 'continuityOf：首条不是 1 时缺口必须记为 {after:0,before:2}');
  const bad = E.continuityOf([1, 'x', 3]);
  assert.equal(bad.ok, false, 'continuityOf：不可解析的 seq 同样算缺口（读不出编号 = 丢帧）');
  ok('⑥ continuityOf：跳号 / 不从 1 起 / 非法序号都被识别为缺口');
}

// ---------------------------------------------------------------------------
// ② mock Provider：三种回合（普通 / 工具两轮 / 慢回合心跳）
// ---------------------------------------------------------------------------
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {}
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    const flat = JSON.stringify(messages);
    /** @param {any} payload */
    const upstream = (payload) => {
      try {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        res.end('data: [DONE]\n\n');
      } catch {}
    };
    /** @param {string} content */
    const answer = (content) =>
      upstream({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });

    // 慢回合：6.5s 后才回 → 5s 的 progress 心跳必然先到（心跳帧也是状态更新，必须带 seq）
    if (flat.includes('SLOWPROGRESS')) {
      setTimeout(() => answer('慢回复完成'), 6500);
      return;
    }
    // 工具回合：第一次请求回 tool_calls（工具结果回填后再发第二次请求）→ 同一 task 两个模型轮次
    if (flat.includes('TOOLFLOW')) {
      const hasToolResult = messages.some((m) => m && m.role === 'tool');
      if (!hasToolResult && Array.isArray(parsed.tools) && parsed.tools.length) {
        upstream({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_ec1',
                    type: 'function',
                    // 只读工具（不落盘、不污染工作树）：工具执行后模型再被请求一次 → 同一 task 两个模型轮次。
                    function: { name: 'ls', arguments: JSON.stringify({ path: base }) },
                  },
                ],
                finish_reason: 'tool_calls',
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 5 },
        });
        return;
      }
      return answer('工具执行完成');
    }
    return answer('普通回复');
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;

// 配置：自定义 Provider 指向 mock；autoTitle=false —— 自动标题会重命名会话文件，
// 而事件侧车（.events.ndjson）不随改名迁移，会让「同一会话两轮 chat」的事件日志分叉。
fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify({
    provider: 'custom',
    model: 'test-model',
    baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    permission: 'auto',
    contextBudget: 32000,
    autoTitle: false,
  }),
  { mode: 0o600 }
);
fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ custom: 'sk-test-event-cursor-000000' }), { mode: 0o600 });

const srv = await runWebServer({ host: '127.0.0.1', port: 0, authToken: null });
if (!srv.listening) await new Promise((r) => srv.once('listening', r));
const baseUrl = `http://127.0.0.1:${srv.address().port}`;

/** GET JSON。 */
async function getJson(/** @type {string} */ p) {
  const res = await fetch(baseUrl + p);
  const j = await res.json().catch(() => ({}));
  return { status: res.status, j };
}

/**
 * 发一轮 chat 并完整读取 SSE：同时解析 `data:` 帧与紧邻的 `id:` 行。
 * @param {any} payload
 * @returns {Promise<{frames: any[], frameIds: (number|null)[]}>}
 */
async function readChat(payload) {
  const resp = await fetch(baseUrl + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(resp.status, 200, 'chat 应返回 200');
  /** @type {any[]} */
  const frames = [];
  /** @type {(number|null)[]} */
  const frameIds = [];
  /** @type {number|null} */
  let pendingId = null;
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      if (line.startsWith('id:')) {
        pendingId = Number(line.slice(3).trim());
        continue;
      }
      if (!line.startsWith('data:')) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      frames.push(ev);
      frameIds.push(pendingId);
      pendingId = null;
    }
  }
  return { frames, frameIds };
}

/**
 * 钉死一条 SSE 流的 seq 契约：从 1 起、逐帧 +1、每帧都有整数 seq、id 行等于该帧 seq。
 * @param {string} label
 * @param {{frames: any[], frameIds: (number|null)[]}} stream
 */
function assertFrameContract(label, stream) {
  const { frames, frameIds } = stream;
  assert.ok(frames.length > 0, `${label}：必须收到至少一帧（空流无法验证 streamSeq）`);
  assert.equal(frames[0].streamSeq, 1, `${label}：每个 task 的 SSE streamSeq 必须从 1 起（实际 ${String(frames[0].streamSeq)}）`);
  assert.ok(frames[0].taskId, `${label}：帧必须带 taskId`);
  assert.equal(frames.every((f) => f.taskId === frames[0].taskId), true, `${label}：同一条流只能属于一个 taskId`);
  for (let i = 0; i < frames.length; i += 1) {
    const ev = frames[i];
    assert.ok(
      Number.isInteger(ev.streamSeq) && ev.streamSeq >= 1,
      `${label}：每一帧都必须带整数 streamSeq（含心跳 progress）（第 ${i} 帧 type=${String(ev.type)} streamSeq=${JSON.stringify(ev.streamSeq)}）`,
    );
    assert.equal(ev.streamSeq, i + 1, `${label}：SSE streamSeq 必须逐帧 +1、不得跳号或重置（第 ${i} 帧 streamSeq=${ev.streamSeq}）`);
    assert.equal(frameIds[i], ev.streamSeq, `${label}：SSE id: 行必须等于该帧 streamSeq（第 ${i} 帧 id=${String(frameIds[i])} streamSeq=${ev.streamSeq}）`);
  }
  const c = E.continuityOf(frames.map((f) => f.streamSeq));
  assert.equal(c.ok, true, `${label}：continuityOf 必须判定这条流连续（gaps=${JSON.stringify(c.gaps)}）`);
}

try {
  // ---------- 1. 工具回合（同一 task 两个模型轮次）：streamSeq 从 1 起、连续、不重置 ----------
  /** @type {any} */
  let firstStream;
  /** @type {string} */
  let sessionFile = '';
  {
    firstStream = await readChat({ message: 'TOOLFLOW 第一轮' });
    assertFrameContract('工具回合', firstStream);
    assert.equal(firstStream.frames.some((f) => f.type === 'tool'), true, '工具回合必须真的产生 tool 事件（否则两轮模型不是这条流）');
    const doneEv = firstStream.frames.find((f) => f.type === 'done');
    assert.ok(doneEv && doneEv.ok, '工具回合必须有 done.ok');
    assert.ok(doneEv.session, 'done 事件必须返回会话文件名');
    sessionFile = String(doneEv.session);
    // 两个模型轮次之间不得把流序号重置回 1（逐帧 +1 已在 assertFrameContract 里钉住，这里再显式说出来）
    const toolAt = firstStream.frames.findIndex((f) => f.type === 'tool');
    assert.ok(toolAt > 0 && toolAt < firstStream.frames.length - 1, 'tool 事件必须在流中间（前后都还有帧）');
    assert.ok(
      firstStream.frames[toolAt + 1].streamSeq > firstStream.frames[toolAt].streamSeq,
      '工具之后的第二轮模型帧必须继续递增（streamSeq 不得重置）',
    );
    // 双游标：既有的 `seq` 是工具卡片配对号（toolStart ↔ tool 同号），新增 streamSeq 不得把它覆盖掉。
    const toolStart = firstStream.frames.find((f) => f.type === 'toolStart' && f.name === 'ls');
    const toolDone = firstStream.frames.find((f) => f.type === 'tool' && f.name === 'ls');
    assert.ok(toolStart && toolDone, '工具回合必须有 toolStart 与 tool 完成帧');
    assert.ok(Number.isInteger(toolStart.seq) && Number.isInteger(toolDone.seq), '工具帧既有的 seq（配对号）必须保留');
    assert.equal(toolDone.seq, toolStart.seq, '双游标：toolStart 与 tool 的既有 seq 必须仍然同号（不得被 streamSeq 覆盖）');
    assert.notEqual(toolStart.streamSeq, toolDone.streamSeq, '双游标：开始/完成是两帧，streamSeq 必须各自递增');
    ok('⑦ SSE：工具回合（两轮模型）streamSeq 从 1 起、逐帧 +1、id 行匹配；既有工具配对 seq 未被覆盖');
  }

  // ---------- 2. 慢回合：心跳 progress 帧也带 seq，且整条流仍然连续 ----------
  {
    const slow = await readChat({ message: 'SLOWPROGRESS 慢回合' });
    assertFrameContract('慢回合', slow);
    const progress = slow.frames.filter((f) => f.type === 'progress');
    assert.ok(progress.length >= 1, '长回合必须至少推送一条心跳 progress 帧（状态更新不能只有 done）');
    assert.equal(typeof progress[0].streamSeq, 'number', '心跳 progress 帧也必须带 streamSeq');
    ok('⑧ SSE：慢回合的心跳 progress 帧带 streamSeq（跳号检测不漏它）');
  }

  // ---------- 3. 并发两个 task：各自从 1 起（streamSeq 按 task，不跨 task 共享） ----------
  {
    const [a, b] = await Promise.all([readChat({ message: '并发任务甲' }), readChat({ message: '并发任务乙' })]);
    assertFrameContract('并发甲', a);
    assertFrameContract('并发乙', b);
    assert.notEqual(a.frames[0].taskId, b.frames[0].taskId, '并发任务必须有独立 taskId');
    ok('⑨ SSE：并发两个 task 各自 streamSeq 从 1 起（不是全局计数器）');
  }

  // ---------- 4. 同一会话两轮 chat：SSE streamSeq 各自从 1 起；事件日志 seq 不重置 ----------
  {
    const ev1 = await getJson(`/api/session?file=${encodeURIComponent(sessionFile)}`);
    assert.equal(ev1.status, 200, '/api/session 必须 200');
    assert.equal(ev1.j.ok, true, '/api/session 必须 ok:true');
    assert.ok(Number.isInteger(ev1.j.lastEventSeq) && ev1.j.lastEventSeq > 0, `第一轮 chat 必须写入事件日志（lastEventSeq=${JSON.stringify(ev1.j.lastEventSeq)}）`);
    const firstSeq = ev1.j.lastEventSeq;

    const second = await readChat({ message: '普通第二轮', file: sessionFile });
    assertFrameContract('第二轮', second);
    assert.equal(second.frames[0].streamSeq, 1, '第二轮是新的 task：SSE streamSeq 必须重新从 1 起（不跨 task 累加）');

    const ev2 = await getJson(`/api/session?file=${encodeURIComponent(sessionFile)}`);
    assert.ok(ev2.j.lastEventSeq > firstSeq, `两轮 chat 的事件日志 seq 不得重置（第一轮 ${firstSeq} → 第二轮 ${ev2.j.lastEventSeq}）`);
    ok('⑩ 两轮 chat：SSE 各 task 的 streamSeq 从 1 起；事件日志 seq 跨轮继续（不重置）');
  }

  // ---------- 5. /api/events：缺省 after=0 返回全部窗口 ----------
  /** @type {any} */
  let allEvents;
  {
    const r = await getJson(`/api/events?file=${encodeURIComponent(sessionFile)}`);
    assert.equal(r.status, 200, '/api/events 必须 200');
    assert.equal(r.j.ok, true, '/api/events 必须 ok:true');
    assert.equal(r.j.file, sessionFile, '/api/events 必须回显 file');
    assert.equal(r.j.seqKind, 'event', '/api/events 必须声明 seqKind:event（lastSeq/events[].seq 是事件日志编号，不是 SSE streamSeq）');
    assert.ok(Array.isArray(r.j.events) && r.j.events.length > 0, '事件窗口不得为空（两轮 chat 已写入事件）');
    for (const ev of r.j.events) {
      assert.ok(Number.isInteger(ev.seq) && ev.seq > 0, '事件项必须带正整数 seq');
      assert.equal(typeof ev.type, 'string', '事件项必须带 type');
      assert.equal(typeof ev.time, 'number', '事件项必须带 time');
      assert.ok(ev.data && typeof ev.data === 'object', '事件项必须带 data 对象');
    }
    const seqs = r.j.events.map((e) => /** @type {any} */ (e).seq);
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1), '事件日志 seq 必须从 1 起且连续（服务端自检口径）');
    assert.equal(r.j.lastSeq, Math.max(...seqs), '/api/events 的 lastSeq 必须是窗口内最大 seq');
    allEvents = r.j;
    ok('⑪ /api/events（缺省 after=0）：返回全部事件 + lastSeq + 字段形状');
  }

  // ---------- 6. 旧会话（无事件文件）：200 + 空窗口，不是 404 ----------
  {
    // 旧会话：只有 .jsonl 消息数组，没有 .events.ndjson 侧车（v0.6.35 之前的会话形态）
    fs.writeFileSync(
      path.join(home, 'sessions', 'old-session.jsonl'),
      [JSON.stringify({ role: 'user', content: '旧问题' }), JSON.stringify({ role: 'assistant', content: '旧回答' })].join('\n') + '\n'
    );
    const old = await getJson(`/api/events?file=${encodeURIComponent('old-session.jsonl')}`);
    assert.equal(old.status, 200, '旧会话（无事件文件）必须是 200，不是 404');
    assert.equal(old.j.ok, true, '旧会话必须 ok:true');
    assert.deepEqual(old.j.events, [], '旧会话必须返回空事件窗口');
    assert.equal(old.j.lastSeq, 0, '旧会话 lastSeq 必须为 0');
    ok('⑫ /api/events：旧会话无事件文件 → 200 + lastSeq:0 + events:[]（不是 404）');
  }

  // ---------- 7. /api/events?after=：严格 seq > after ----------
  {
    const after = allEvents.events[1].seq; // 第二条的 seq
    const r = await getJson(`/api/events?file=${encodeURIComponent(sessionFile)}&after=${after}`);
    assert.equal(r.status, 200, 'after 合法时必须 200');
    const want = allEvents.events.filter((e) => e.seq > after).map((e) => e.seq);
    assert.deepEqual(r.j.events.map((e) => e.seq), want, '只返回 seq > after 的事件（`>=` 会把重帧当新帧，必须红）');
    assert.equal(r.j.lastSeq, allEvents.lastSeq, 'after 过滤不得改变 lastSeq');
    const tail = await getJson(`/api/events?file=${encodeURIComponent(sessionFile)}&after=${allEvents.lastSeq}`);
    assert.deepEqual(tail.j.events, [], 'after=最大 seq 时必须返回空窗口（已追平）');
    assert.equal(tail.j.lastSeq, allEvents.lastSeq, '已追平时 lastSeq 仍必须是最大值');
    ok('⑬ /api/events?after=：严格大于过滤 / 追平后空窗口 / lastSeq 不变');
  }

  // ---------- 7. /api/events：非法参数 400 ----------
  {
    const bad = ['abc', '-1', '1.5', '', '1e3'];
    for (const v of bad) {
      const r = await getJson(`/api/events?file=${encodeURIComponent(sessionFile)}&after=${encodeURIComponent(v)}`);
      assert.equal(r.status, 400, `after=${JSON.stringify(v)} 必须 400（非数字/负数不得被静默当成 0）`);
    }
    const noFile = await getJson('/api/events');
    assert.equal(noFile.status, 400, '缺 file 参数必须 400');
    ok('⑭ /api/events：after 非数字/负数/小数/空 → 400；缺 file → 400');
  }

  // ---------- 8. /api/events：目录穿越必须 400 ----------
  {
    // 造一个 sessions 目录之外、但仍在 home 下的"会话"：护栏若失效，?file=../secret.jsonl 就能读到它。
    fs.writeFileSync(path.join(home, 'secret.jsonl'), JSON.stringify({ role: 'user', content: '越界' }) + '\n');
    for (const raw of ['../secret.jsonl', '..\\secret.jsonl', '/etc/passwd', '..', '.']) {
      const r = await getJson(`/api/events?file=${encodeURIComponent(raw)}`);
      assert.equal(r.status, 400, `file=${JSON.stringify(raw)} 必须 400（只接受 basename，防目录穿越）`);
    }
    const okName = await getJson(`/api/events?file=${encodeURIComponent('secret.jsonl')}`);
    assert.equal(okName.status, 404, 'basename 形式的未知会话必须 404（穿越护栏不能把正常参数一起拦掉）');
    ok('⑮ /api/events：路径分隔符 / .. / 绝对路径 → 400；正常 basename 照常进入 404 分支');
  }

  // ---------- 9. /api/events：会话不存在 404 ----------
  {
    const missing = await getJson(`/api/events?file=${encodeURIComponent('no-such-session.jsonl')}`);
    assert.equal(missing.status, 404, '会话文件不存在必须 404');
    assert.ok(missing.j.error, '404 必须带可读 error');
    ok('⑯ /api/events：会话不存在 → 404（且带可读 error）');
  }

  // ---------- 10. /api/session 的 lastEventSeq 基线 ----------
  {
    const r = await getJson(`/api/session?file=${encodeURIComponent(sessionFile)}`);
    assert.equal(r.status, 200, '/api/session 必须 200');
    assert.equal(r.j.lastEventSeq, allEvents.lastSeq, 'lastEventSeq 必须等于事件日志最大 seq（前端据此建基线）');
    const old = await getJson(`/api/session?file=${encodeURIComponent('old-session.jsonl')}`);
    assert.equal(old.status, 200, '旧会话 /api/session 必须 200');
    assert.equal(old.j.lastEventSeq, 0, '旧会话（无事件文件）lastEventSeq 必须为 0');
    ok('⑰ /api/session：lastEventSeq = 事件日志最大 seq；旧会话为 0');
  }

  // ---------- 11. 事件日志的 seq 与 continuityOf 一致（服务端自检可用） ----------
  {
    const r = await getJson(`/api/events?file=${encodeURIComponent(sessionFile)}`);
    const c = E.continuityOf(r.j.events.map((e) => e.seq));
    assert.equal(c.ok, true, `continuityOf 必须判定 /api/events 窗口连续（gaps=${JSON.stringify(c.gaps)}）`);
    assert.equal(c.gaps.length, 0, '完整窗口不得有缺口');
    ok('⑱ continuityOf 与 /api/events 对拍：完整窗口无缺口');
  }
} finally {
  await new Promise((r) => srv.close(r));
  await new Promise((r) => mock.close(r));
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(`\nevent-cursor：${passed} 项全部通过`);
process.exit(0);
