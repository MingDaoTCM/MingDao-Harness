// 会话事件日志（src/session-events.js）的独立回归套件（v0.7.0 §1.1 切片 A）。
//
// 为什么单独一套：事件日志是**旁路事实源**，它的全部价值在于「可重放且与消息数组逐字节等价」。
// 这里把三件事钉死：
//   ① 写入侧：seq 单调无洞、并发（真 8 子进程）不重号、torn 行不拖垮读取；
//   ② 读取侧：torn 行 / 未知 type 跳过并计入 skipped（可见），旧会话没有事件文件时为空；
//   ③ 重放侧：4 个场景（单轮 / 工具调用 / compact / interrupt）与消息数组 deepEqual。
//
// 约定：`expect` 关键词就是断言原文——变异批次（batch76）靠它确认「红的是不是这条」。
//
// 运行：node test/session-events.js（不依赖网络）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const E = await import(pathToFileURL(path.join(srcDir, 'session-events.js')).href);

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-session-events-'));
process.env.MINGDAO_HOME = path.join(base, 'home');
fs.mkdirSync(path.join(process.env.MINGDAO_HOME, 'sessions'), { recursive: true });

let passed = 0;
/** @param {string} name */
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

// ---------- 1. 类型清单与文件命名 ----------
{
  assert.deepEqual(
    [...E.EVENT_TYPES],
    [
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
    ],
    '事件类型必须恰好是这 12 个（新增类型要同时改测试与文档）'
  );
  assert.equal(new Set(E.EVENT_TYPES).size, 12, '12 类事件不得重名');
  ok('① 事件类型恰好 12 个且无重复');
}

{
  assert.equal(E.eventFileFor('/x/sessions/a.jsonl'), '/x/sessions/a.events.jsonl', '会话文件的事件侧车必须同名同目录');
  assert.equal(E.eventFileFor('/x/sessions/a.events.jsonl'), '/x/sessions/a.events.jsonl', '已经是事件文件时不得二次拼接');
  assert.equal(E.eventFileFor('/x/sessions/a'), '/x/sessions/a.events.jsonl', '无扩展名时补 .events.jsonl');
  assert.equal(E.isEventLogName('a.events.jsonl'), true, '事件侧车判定');
  assert.equal(E.isEventLogName('a.jsonl'), false, '普通会话不得被误判为事件侧车');
  ok('② 事件文件命名 <session>.events.jsonl（与 .jsonl 同级）');
}

// ---------- 2. seq 单调且无洞（连续 20 条） ----------
const seqFile = path.join(base, 'seq.events.jsonl');
{
  for (let i = 0; i < 20; i += 1) {
    const r = E.appendEvent(seqFile, { type: 'step.start', data: { i }, at: 1700000000000 + i });
    assert.equal(r.ok, true, `第 ${i + 1} 条 append 必须成功：${r.error}`);
  }
  const read = E.readEvents(seqFile);
  assert.equal(read.ok, true, '读取事件文件必须成功');
  assert.equal(read.skipped, 0, '没有坏行时 skipped 必须为 0');
  assert.deepEqual(
    read.events.map((e) => e.seq),
    Array.from({ length: 20 }, (_, i) => i + 1),
    'seq 必须从 1 连续到 20（无洞、无重号）'
  );
  assert.deepEqual(read.events[0], { seq: 1, time: 1700000000000, type: 'step.start', data: { i: 0 } }, '事件形状必须是 {seq,time,type,data}');
  assert.equal(read.events[19].data.i, 19, 'data 必须原样保留');
  ok('③ 连续 append 20 条：seq 1..20 单调无洞，形状 {seq,time,type,data}');
}

{
  // 删除后重建：seq 必须重新从 1 开始（缓存不得凭空跳号）
  const f = path.join(base, 'recreate.events.jsonl');
  E.appendEvent(f, { type: 'turn.start', data: { n: 1 } });
  E.appendEvent(f, { type: 'turn.start', data: { n: 2 } });
  fs.unlinkSync(f);
  const r = E.appendEvent(f, { type: 'turn.start', data: { n: 3 } });
  assert.equal(r.ok, true, '重建后 append 必须成功');
  const read = E.readEvents(f);
  assert.deepEqual(read.events.map((e) => e.seq), [1], '文件删除重建后 seq 必须从 1 重新开始（不得沿用进程缓存跳号）');
  ok('④ 事件文件删除/重建后 seq 从 1 重新开始（缓存不以旧值兜底）');
}

// ---------- 3. 并发 append：8 子进程 × 10 条 ----------
{
  const concFile = path.join(base, 'concurrent.events.jsonl');
  const childScript = path.join(base, 'append-child.mjs');
  const moduleUrl = pathToFileURL(path.join(srcDir, 'session-events.js')).href;
  fs.writeFileSync(
    childScript,
    `
import fs from 'node:fs';
import { appendEvent } from ${JSON.stringify(moduleUrl)};
const [eventFile, ready, go, tag] = process.argv.slice(2);
fs.writeFileSync(ready, '1');
const wait = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(go)) Atomics.wait(wait, 0, 0, 5);
for (let i = 0; i < 10; i += 1) {
  const r = appendEvent(eventFile, { type: 'step.start', data: { child: tag, i } });
  if (!r.ok) { console.error(JSON.stringify(r)); process.exit(2); }
}
`
  );
  const go = path.join(base, 'concurrent.go');
  const kids = [];
  for (let i = 0; i < 8; i += 1) {
    const ready = path.join(base, `concurrent.ready.${i}`);
    const p = spawn(process.execPath, [childScript, concFile, ready, go, String(i)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    kids.push({ p, ready, err: () => err });
  }
  const deadline = Date.now() + 15000;
  while (kids.some((k) => !fs.existsSync(k.ready))) {
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  fs.writeFileSync(go, '1');
  const exits = await Promise.all(
    kids.map(
      (k) =>
        new Promise((resolve) => {
          k.p.on('close', (code) => resolve(code));
        })
    )
  );
  assert.deepEqual(
    kids.map((k) => k.err()).filter(Boolean),
    [],
    '并发 append 子进程不得报错'
  );
  assert.deepEqual(exits, [0, 0, 0, 0, 0, 0, 0, 0], '8 个并发 append 子进程必须全部正常退出');
  const read = E.readEvents(concFile);
  assert.equal(read.events.length, 80, '并发 append：总条数必须是 80');
  const seqs = read.events.map((e) => e.seq).sort((a, b) => a - b);
  assert.deepEqual(
    seqs,
    Array.from({ length: 80 }, (_, i) => i + 1),
    '并发 append：读出来的 seq 集合必须连续且无重复（1..80）'
  );
  ok('⑤ 并发 append（8 子进程 × 10 条）：80 条、seq 集合连续无重复');
}

// ---------- 4. torn 行：跳过并计数，其余可读 ----------
{
  const torn = path.join(base, 'torn.events.jsonl');
  E.appendEvent(torn, { type: 'turn.start', data: { n: 1 } });
  E.appendEvent(torn, { type: 'message.append', data: { message: { role: 'user', content: 'hi' } } });
  // 手工写半行（模拟写一半崩溃）：没有换行、JSON 不完整
  fs.appendFileSync(torn, '{"seq":3,"type":"turn.end","data":');
  let read;
  assert.doesNotThrow(() => {
    read = E.readEvents(torn);
  }, 'torn 行必须跳过且不能整份读崩');
  assert.equal(read.ok, true, 'torn 行必须跳过且不能整份读崩（读取本身要成功）');
  assert.equal(read.skipped, 1, 'torn 行必须跳过且不能整份读崩：必须计入 skipped=1');
  assert.deepEqual(read.events.map((e) => e.seq), [1, 2], 'torn 行之前的事件必须仍可读');
  ok('⑥ torn 行（半截 JSON）被跳过且 skipped=1，其余事件可读');

  // 继续追加：必须自动补换行，新事件独占一行且 seq 接在最后一条**完整**事件之后
  const r = E.appendEvent(torn, { type: 'turn.end', data: { n: 4 } });
  assert.equal(r.ok, true, 'torn 行之后仍必须能追加新事件');
  const read2 = E.readEvents(torn);
  assert.equal(read2.skipped, 1, '追加后 torn 行仍只计一次 skipped');
  assert.deepEqual(read2.events.map((e) => e.seq), [1, 2, 3], 'torn 行之后的新事件 seq 必须接在最后一条完整事件之后');
  ok('⑦ torn 行之后追加：自动补换行、新事件独立成行、seq 不断链');
}

// ---------- 5. 未知 type：跳过并计数（不崩） ----------
{
  const unknown = path.join(base, 'unknown.events.jsonl');
  E.appendEvent(unknown, { type: 'turn.start', data: {} });
  fs.appendFileSync(unknown, JSON.stringify({ seq: 2, time: Date.now(), type: 'future.event', data: { x: 1 } }) + '\n');
  E.appendEvent(unknown, { type: 'turn.end', data: {} });
  let read;
  assert.doesNotThrow(() => {
    read = E.readEvents(unknown);
  }, '未知 type 必须跳过而不能崩');
  assert.equal(read.ok, true, '未知 type 必须跳过而不能崩（读取本身要成功）');
  assert.equal(read.skipped, 1, '未知 type 必须跳过而不能崩：必须计入 skipped=1');
  assert.equal(read.events.length, 2, '未知 type 之外的已知事件必须可读');
  assert.equal(read.events.some((e) => e.type === 'future.event'), false, '未知 type 不得进入事件数组');
  ok('⑧ 未知 type 被跳过并计数（skipped=1），不崩溃');
}

// ---------- 6. 旧会话：没有事件文件 → 空流；空事件流 → 空消息 ----------
{
  const missing = path.join(base, 'no-such.events.jsonl');
  const r = E.readEvents(missing);
  assert.equal(r.ok, true, '事件文件不存在不是错误（旧会话的正常形态）');
  assert.deepEqual(r.events, [], '没有事件文件时必须返回空事件数组');
  assert.equal(r.skipped, 0, '没有事件文件时 skipped=0');
  assert.deepEqual(E.replayToMessages([]), [], '空事件流必须重放出空消息数组');
  assert.deepEqual(E.replayToMessages(/** @type {any} */ (null)), [], 'replayToMessages(null) 必须安全返回空数组');
  ok('⑨ 无事件文件的旧会话：readEvents 为空、replayToMessages([]) 为空');
}

// ---------- 7. 重放对拍（核心）：4 个场景 deepEqual ----------
{
  const user = { role: 'user', content: '你好' };
  const assistant = { role: 'assistant', content: '你好！' };
  const events = [
    { seq: 1, time: 1, type: 'session.start', data: {} },
    { seq: 2, time: 2, type: 'turn.start', data: {} },
    { seq: 3, time: 3, type: 'message.append', data: { message: user } },
    { seq: 4, time: 4, type: 'message.append', data: { message: assistant } },
    { seq: 5, time: 5, type: 'turn.end', data: { status: 'done' } },
  ];
  assert.deepEqual(E.replayToMessages(events), [user, assistant], '单轮对话重放必须与消息数组 deepEqual');
  ok('⑩ 重放场景 1/4：单轮对话（user + assistant）deepEqual');
}

{
  const assistant = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
  };
  const tool = { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true,"output":"A"}' };
  const events = [
    { seq: 1, time: 1, type: 'message.append', data: { message: { role: 'user', content: '读 a.txt' } } },
    { seq: 2, time: 2, type: 'message.append', data: { message: assistant } },
    { seq: 3, time: 3, type: 'tool.start', data: { callId: 'call_1', name: 'read' } },
    { seq: 4, time: 4, type: 'tool.end', data: { callId: 'call_1', name: 'read', ok: true } },
    { seq: 5, time: 5, type: 'message.append', data: { message: tool } },
  ];
  assert.deepEqual(
    E.replayToMessages(events),
    [{ role: 'user', content: '读 a.txt' }, assistant, tool],
    '带工具调用重放必须与消息数组 deepEqual（assistant.tool_calls + tool 结果）'
  );
  ok('⑪ 重放场景 2/4：带工具调用（assistant.tool_calls + tool 结果）deepEqual');
}

{
  const old1 = { role: 'user', content: '很长的旧问题' };
  const old2 = { role: 'assistant', content: '很长的旧回答' };
  const summary = { role: 'user', content: '（压缩摘要）旧问题与旧回答' };
  const newUser = { role: 'user', content: '继续' };
  const newAssistant = { role: 'assistant', content: '好的' };
  const events = [
    { seq: 1, time: 1, type: 'message.append', data: { message: old1 } },
    { seq: 2, time: 2, type: 'message.append', data: { message: old2 } },
    { seq: 3, time: 3, type: 'compact', data: { droppedCount: 2, droppedTokens: 42, messages: [summary] } },
    { seq: 4, time: 4, type: 'message.append', data: { message: newUser } },
    { seq: 5, time: 5, type: 'message.append', data: { message: newAssistant } },
  ];
  assert.deepEqual(
    E.replayToMessages(events),
    [summary, newUser, newAssistant],
    'compact 必须重置重放基线（压缩前的消息不得再出现在结果里）'
  );
  ok('⑫ 重放场景 3/4：发生过 compact（压缩事件重置基线）deepEqual');
}

{
  const user = { role: 'user', content: '跑两个工具' };
  const assistant = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call_a', type: 'function', function: { name: 'read', arguments: '{}' } },
      { id: 'call_b', type: 'function', function: { name: 'read', arguments: '{}' } },
    ],
  };
  const toolA = { role: 'tool', tool_call_id: 'call_a', content: 'A' };
  const events = [
    { seq: 1, time: 1, type: 'message.append', data: { message: user } },
    { seq: 2, time: 2, type: 'message.append', data: { message: assistant } },
    { seq: 3, time: 3, type: 'message.append', data: { message: toolA } },
    { seq: 4, time: 4, type: 'interrupt', data: { reason: 'sigint', toolCallIds: ['call_a', 'call_b'] } },
  ];
  assert.deepEqual(
    E.replayToMessages(events),
    [user, assistant, toolA, { role: 'tool', tool_call_id: 'call_b', content: '（已中断，未执行）' }],
    'interrupt 必须补齐尚未回填的 tool 占位（已回填的 call_a 不得重复）'
  );
  ok('⑬ 重放场景 4/4：interrupt → 补齐 tool 占位 deepEqual');

  // interrupt 事件先到、message.append 后到（真实双写顺序）：占位不得重复/错位
  const lateAssistant = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_c', type: 'function', function: { name: 'bash', arguments: '{}' } }],
  };
  const latePlaceholder = { role: 'tool', tool_call_id: 'call_c', content: '（已中断，未执行）' };
  const orderedEvents = [
    { seq: 1, time: 1, type: 'message.append', data: { message: user } },
    { seq: 2, time: 2, type: 'interrupt', data: { reason: 'sigint', toolCallIds: ['call_c'] } },
    { seq: 3, time: 3, type: 'message.append', data: { message: lateAssistant } },
    { seq: 4, time: 4, type: 'message.append', data: { message: latePlaceholder } },
  ];
  assert.deepEqual(
    E.replayToMessages(orderedEvents),
    [user, lateAssistant, latePlaceholder],
    'interrupt 早于 message.append 时，占位必须延迟补齐且不得重复（真实双写顺序）'
  );
  ok('⑭ interrupt 早于 message.append（真实双写顺序）时占位不重复、不错位');
}

// ---------- 8. 失败形态：未知 type / 写失败都只返回 {ok:false}，绝不抛 ----------
{
  let r;
  assert.doesNotThrow(() => {
    r = E.appendEvent(path.join(base, 'bad-type.events.jsonl'), { type: 'not.a.type', data: {} });
  }, 'appendEvent 未知 type 不得抛异常');
  assert.equal(r.ok, false, 'appendEvent 未知 type 必须返回 ok:false');
  assert.ok(String(r.error).includes('未知事件类型'), 'appendEvent 未知 type 必须说明原因');
  ok('⑮ appendEvent 未知 type 返回 {ok:false,error}（不抛、不写）');
}

{
  const failFile = path.join(base, 'write-fail.events.jsonl');
  const realAppend = fs.appendFileSync;
  fs.appendFileSync = function (/** @type {any} */ p, /** @type {any} */ ...args) {
    if (String(p).includes('.events.jsonl')) {
      const err = new Error('injected EACCES for ' + String(p));
      /** @type {any} */ (err).code = 'EACCES';
      throw err;
    }
    return /** @type {any} */ (realAppend).call(fs, p, ...args);
  };
  let r;
  try {
    assert.doesNotThrow(() => {
      r = E.appendEvent(failFile, { type: 'turn.start', data: {} });
    }, '写失败必须返回 {ok:false} 而不是抛出');
  } finally {
    fs.appendFileSync = realAppend;
  }
  assert.equal(r.ok, false, '注入 EACCES 后 appendEvent 必须返回 ok:false');
  assert.ok(String(r.error).toLowerCase().includes('eacces'), '写失败必须带原始 errno 文本');
  ok('⑯ 写失败注入（EACCES）：appendEvent 返回 {ok:false} 且不抛');
}

// ---------- 9. deriveTurnSummaries（可选 API） ----------
{
  const events = [
    { seq: 1, time: 10, type: 'turn.start', data: {} },
    { seq: 2, time: 11, type: 'step.start', data: { step: 1 } },
    { seq: 3, time: 12, type: 'tool.start', data: { name: 'read' } },
    { seq: 4, time: 13, type: 'usage', data: { usage: { prompt_tokens: 5, completion_tokens: 6 } } },
    { seq: 5, time: 14, type: 'step.start', data: { step: 2 } },
    { seq: 6, time: 15, type: 'turn.end', data: { status: 'done' } },
  ];
  const turns = E.deriveTurnSummaries(events);
  assert.equal(turns.length, 1, '一个 turn.start/end 必须派生一条摘要');
  assert.deepEqual(
    { turn: turns[0].turn, status: turns[0].status, steps: turns[0].steps, toolCalls: turns[0].toolCalls, usage: turns[0].usage },
    { turn: 1, status: 'done', steps: 2, toolCalls: 1, usage: { prompt_tokens: 5, completion_tokens: 6 } },
    'turn 摘要必须从事件自己推导（步数/工具数/用量）'
  );
  assert.deepEqual(E.deriveTurnSummaries([]), [], '空事件流派生空摘要');
  ok('⑰ deriveTurnSummaries：步数/工具数/用量/turn 边界全部从事件推导');
}

console.log(`\nsession-events：${passed} 项全部通过`);
