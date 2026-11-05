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
const S = await import(pathToFileURL(path.join(srcDir, 'session.js')).href);
const A = await import(pathToFileURL(path.join(srcDir, 'agent.js')).href);
const C = await import(pathToFileURL(path.join(srcDir, 'config.js')).href);
const { createIO } = await import(pathToFileURL(path.join(srcDir, 'ui.js')).href);

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
  assert.equal(E.eventFileFor('/x/sessions/a.jsonl'), '/x/sessions/a.events.ndjson', '会话文件的事件侧车必须同名同目录');
  assert.equal(E.eventFileFor('/x/sessions/a.events.ndjson'), '/x/sessions/a.events.ndjson', '已经是事件文件时不得二次拼接');
  assert.equal(E.eventFileFor('/x/sessions/a'), '/x/sessions/a.events.ndjson', '无扩展名时补 .events.ndjson');
  assert.equal(E.isEventLogName('a.events.ndjson'), true, '事件侧车判定');
  assert.equal(E.isEventLogName('a.jsonl'), false, '普通会话不得被误判为事件侧车');
  ok('② 事件文件命名 <session>.events.ndjson（与 .jsonl 同级）');
}

// ---------- 2. seq 单调且无洞（连续 20 条） ----------
const seqFile = path.join(base, 'seq.events.ndjson');
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
  const f = path.join(base, 'recreate.events.ndjson');
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
  const concFile = path.join(base, 'concurrent.events.ndjson');
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
  const torn = path.join(base, 'torn.events.ndjson');
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
  const unknown = path.join(base, 'unknown.events.ndjson');
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
  const missing = path.join(base, 'no-such.events.ndjson');
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
    r = E.appendEvent(path.join(base, 'bad-type.events.ndjson'), { type: 'not.a.type', data: {} });
  }, 'appendEvent 未知 type 不得抛异常');
  assert.equal(r.ok, false, 'appendEvent 未知 type 必须返回 ok:false');
  assert.ok(String(r.error).includes('未知事件类型'), 'appendEvent 未知 type 必须说明原因');
  ok('⑮ appendEvent 未知 type 返回 {ok:false,error}（不抛、不写）');
}

{
  const failFile = path.join(base, 'write-fail.events.ndjson');
  const realAppend = fs.appendFileSync;
  fs.appendFileSync = function (/** @type {any} */ p, /** @type {any} */ ...args) {
    if (String(p).includes('.events.ndjson')) {
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


// ---------- 10. 双写接线：会话消息落盘后追加 message.append（重放对拍） ----------
{
  const file = path.join(process.env.MINGDAO_HOME || '', 'sessions', 'wired.jsonl');
  const msgs = [
    { role: 'user', content: '双写测试：你好' },
    { role: 'assistant', content: '双写测试：你好！' },
  ];
  S.appendMessages(file, msgs);
  const eventFile = E.eventFileFor(file);
  assert.equal(fs.existsSync(eventFile), true, 'appendMessages 必须创建事件侧车 <session>.events.ndjson');
  const read = E.readEvents(eventFile);
  assert.equal(read.ok, true, '双写后事件文件必须可读');
  assert.equal(read.skipped, 0, '双写的事件文件不得有坏行');
  assert.equal(read.events[0].type, 'session.start', '事件流第一条必须是 session.start');
  assert.deepEqual(
    read.events.filter((e) => e.type === 'message.append').map((e) => e.data.message.role),
    ['user', 'assistant'],
    'appendMessages 必须为每条消息追加一条 message.append（顺序不变）'
  );
  const loaded = S.loadSession(file).messages;
  assert.deepEqual(
    E.replayToMessages(read.events),
    loaded,
    '双写对拍：replayToMessages(事件流) 必须与 loadSession(会话文件) 的消息数组 deepEqual'
  );
  ok('⑱ 双写：appendMessages 追加 message.append，重放结果与 loadSession 逐字节 deepEqual');
}

// ---------- 11. 旧会话（没有 events 文件）与既有读取路径完全不受影响 ----------
{
  const oldFile = path.join(process.env.MINGDAO_HOME || '', 'sessions', 'legacy.jsonl');
  const legacy = [{ role: 'system', content: '旧 system' }, { role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回答' }];
  fs.writeFileSync(oldFile, legacy.map((m) => JSON.stringify(m)).join('\n') + '\n');
  const missingName = E.eventFileFor(oldFile);
  assert.equal(fs.existsSync(missingName), false, '夹具前提：旧会话没有事件侧车');
  const read = E.readEvents(missingName);
  assert.equal(read.ok, true, '旧会话没有 events 文件时 readEvents 必须成功返回空流');
  assert.deepEqual(read.events, [], '旧会话没有 events 文件时必须返回空事件数组');
  assert.equal(read.skipped, 0, '旧会话没有 events 文件时 skipped=0');
  assert.deepEqual(E.replayToMessages([]), [], '旧会话空事件流重放必须为空数组');
  const loaded = S.loadSession(oldFile);
  assert.deepEqual(loaded.messages, legacy, '旧会话读取路径必须完全不受事件日志影响（内容/顺序/无 ts 回填）');
  assert.equal(loaded.file, oldFile, 'loadSession 返回值形状不变');
  ok('⑲ 旧会话（无 events 文件）：readEvents 为空、replay 为空、loadSession 原样返回');
}

// ---------- 12. 事件侧车不得污染会话列表 / 最近会话 ----------
{
  const name = path.basename(E.eventFileFor(path.join(process.env.MINGDAO_HOME || '', 'sessions', 'listed.jsonl')));
  S.appendMessages(path.join(process.env.MINGDAO_HOME || '', 'sessions', 'listed.jsonl'), [{ role: 'user', content: '列表测试' }]);
  const listed = S.listSessions(process.env.MINGDAO_HOME || '').map((s) => s.name);
  assert.equal(listed.includes(name), false, '事件侧车不得出现在会话列表（它不是会话）');
  // v0.6.35 补：**正常会话必须仍在列表里**——否则"把一切都当侧车"的变异会让列表变空，
  // 而"侧车不在列表里"这条断言反而照样通过（这就是 batch76 ⑩ 一开始逃逸的原因）。
  assert.equal(
    listed.some((n) => n.startsWith('listed') && n.endsWith('.jsonl')),
    true,
    '正常会话必须仍在会话列表里（isEventLogName 不得误伤真实会话）'
  );
  assert.equal(listed.some((n) => n.endsWith('.events.ndjson')), false, '任何 .events.ndjson 都不得被当成会话');
  const latest = S.latestSession(process.env.MINGDAO_HOME || '');
  assert.ok(!String(latest?.name || '').endsWith('.events.ndjson'), '事件侧车不得抢占 latestSession（mtime 更新也不行）');
  ok('⑳ 事件侧车被会话列表/最近会话排除（旧会话列表行为不变）');
}

// ---------- 13. 开关：cfg.eventLog=false / 进程开关 / 环境变量 ----------
{
  assert.equal(E.eventLogEnabled({ eventLog: false }), false, 'cfg.eventLog=false 必须关闭事件日志');
  assert.equal(E.eventLogEnabled({ eventLog: true }), true, 'cfg.eventLog=true 必须开启（默认开）');
  assert.equal(E.eventLogEnabled({}), true, '未配置 eventLog 时默认开');
  E.setEventLogEnabled(false);
  const offFile = path.join(base, 'switch-off.jsonl');
  S.appendMessages(offFile, [{ role: 'user', content: '开关关闭' }]);
  assert.equal(fs.existsSync(E.eventFileFor(offFile)), false, '开关关闭时必须完全停止事件写入（不得留下半份事件流）');
  assert.equal(S.loadSession(offFile).messages.length, 1, '开关关闭不影响会话消息写入');
  E.setEventLogEnabled(true);
  const onFile = path.join(base, 'switch-on.jsonl');
  S.appendMessages(onFile, [{ role: 'user', content: '开关打开' }]);
  assert.equal(fs.existsSync(E.eventFileFor(onFile)), true, '开关恢复后必须重新双写');
  ok('㉑ 开关：cfg.eventLog=false / setEventLogEnabled(false) 完全停止双写，会话写入不受影响');
}

{
  const envFile = path.join(base, 'switch-env.jsonl');
  const prev = process.env.MINGDAO_EVENT_LOG;
  process.env.MINGDAO_EVENT_LOG = '0';
  try {
    assert.equal(E.eventLogEnabled({}), false, 'MINGDAO_EVENT_LOG=0 必须关闭事件日志');
    S.appendMessages(envFile, [{ role: 'user', content: '环境变量关闭' }]);
    assert.equal(fs.existsSync(E.eventFileFor(envFile)), false, 'MINGDAO_EVENT_LOG=0 时必须完全停止事件写入');
  } finally {
    if (prev === undefined) delete process.env.MINGDAO_EVENT_LOG;
    else process.env.MINGDAO_EVENT_LOG = prev;
  }
  assert.equal(E.eventLogEnabled({}), true, '恢复环境变量后事件日志重新启用');
  ok('㉒ 环境变量 MINGDAO_EVENT_LOG=0 是独立回滚开关（不依赖改 config）');
}

// ---------- 12b. config.eventLog=false 经 loadConfig 生效（Web 先落盘、后建 agent 的顺序也不漏） ----------
{
  const home = process.env.MINGDAO_HOME || '';
  const cfgFile = path.join(home, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ provider: 'deepseek', eventLog: false }) + '\n');
  const cfg = C.loadConfig();
  assert.equal(cfg.eventLog, false, '夹具：loadConfig 必须读回 eventLog=false');
  assert.equal(E.eventLogEnabled(), false, 'loadConfig 必须把 config.eventLog=false 同步到事件日志进程开关');
  const offFile = path.join(base, 'config-off.jsonl');
  S.appendMessages(offFile, [{ role: 'user', content: '配置关闭' }]);
  assert.equal(fs.existsSync(E.eventFileFor(offFile)), false, 'config.eventLog=false 时 appendMessages 必须完全停止事件写入');
  fs.writeFileSync(cfgFile, JSON.stringify({ provider: 'deepseek', eventLog: true }) + '\n');
  C.loadConfig();
  assert.equal(E.eventLogEnabled(), true, 'config.eventLog=true 必须重新开启事件日志');
  ok('㉓ config.eventLog=false 经 loadConfig 生效（先落盘、后建 agent 的路径不漏）');
}

// ---------- 13b. agent 事件边界：turn/step/tool/usage 都写进同一条事件流 ----------
{
  const work = path.join(base, 'agent-work');
  fs.mkdirSync(work, { recursive: true });
  const eventFile = path.join(base, 'agent-boundaries.events.ndjson');
  let call = 0;
  const provider = {
    async chat() {
      call += 1;
      if (call === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'call_evt_1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'event-proof.txt', content: 'ok' }) } }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
          finish: 'tool_calls',
        };
      }
      return { text: '完成', toolCalls: null, usage: { prompt_tokens: 8, completion_tokens: 4 }, finish: 'stop' };
    },
  };
  const agent = A.createAgent({
    provider,
    permission: { async check() { return true; } },
    io: createIO({ quiet: true }),
    modelName: 'deepseek-v4-flash',
    workingDir: work,
    cfg: { permission: 'auto', eventFile, eventLog: true },
    sessionRef: { name: 'agent-boundaries.jsonl' },
    maxSteps: 5,
  });
  const messages = [
    { role: 'system', content: '系统' },
    { role: 'user', content: '写一个文件' },
  ];
  await agent.runTurn(messages);
  const read = E.readEvents(eventFile);
  assert.equal(read.ok, true, 'agent 事件流必须可读');
  const types = read.events.map((e) => e.type);
  for (const t of ['turn.start', 'step.start', 'tool.start', 'tool.end', 'usage', 'step.end', 'turn.end']) {
    assert.ok(types.includes(t), `agent 事件边界必须写入 ${t}（实际：${types.join(',')}）`);
  }
  assert.ok(types.indexOf('turn.start') < types.indexOf('step.start'), 'turn.start 必须早于 step.start');
  assert.ok(types.indexOf('tool.start') < types.indexOf('tool.end'), 'tool.start 必须早于 tool.end');
  assert.ok(types.indexOf('step.end') < types.indexOf('turn.end'), 'step.end 必须早于 turn.end');
  const usage = read.events.find((e) => e.type === 'usage');
  assert.equal(usage.data.usage.prompt_tokens, 7, 'usage 事件必须携带本步真实用量');
  ok('㉔ agent 事件边界：turn/step/tool/usage 成对写入且顺序正确');
}

// ---------- 14. 双写失败不得影响会话写入（注入 EACCES） ----------
{
  const file = path.join(base, 'doublewrite-fail.jsonl');
  // 预置空事件文件：跳过 session.start 分支，确保失败发生在 message.append 双写路径上。
  fs.writeFileSync(E.eventFileFor(file), '');
  const realAppend = fs.appendFileSync;
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  fs.appendFileSync = function (/** @type {any} */ p, /** @type {any} */ ...args) {
    if (String(p).includes('.events.ndjson')) {
      const err = new Error('injected EACCES for ' + String(p));
      /** @type {any} */ (err).code = 'EACCES';
      throw err;
    }
    return /** @type {any} */ (realAppend).call(fs, p, ...args);
  };
  try {
    assert.doesNotThrow(() => {
      S.appendMessages(file, [{ role: 'user', content: '事件写失败但会话必须成功' }]);
    }, '双写失败绝不能影响会话写入');
  } finally {
    fs.appendFileSync = realAppend;
    console.warn = realWarn;
  }
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, '双写失败时会话文件仍必须写成功（1 条消息）');
  assert.equal(JSON.parse(lines[0]).content, '事件写失败但会话必须成功', '会话写入内容必须完整');
  assert.ok(warns.some((w) => w.includes('⚠') && w.includes('事件日志写入失败')), '双写失败必须有可见 warn（不能静默）');
  ok('㉕ 双写失败注入（EACCES）：不抛、会话写入成功、warn 可见');
}

console.log(`\nsession-events：${passed} 项全部通过`);

// ===========================================================================
// ㉖–㉞ v0.6.35 补齐：派生摘要 / 缺占位 id / 失败告警去重（此前 0 覆盖）
// ===========================================================================
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-events-extra-'));
  try {
    // ㉖ deriveTurnSummaries：两轮、工具计数、usage 归属、status 变化
    const ev = path.join(base, 'two-turns.events.ndjson');
    const t0 = 1_700_000_000_000;
    const push = (type, data, at) => {
      const r = E.appendEvent(ev, { type, data, at });
      assert.equal(r.ok, true, `appendEvent(${type}) 应成功：${JSON.stringify(r)}`);
      return r;
    };
    push('turn.start', {}, t0);
    push('step.start', {}, t0 + 10);
    push('tool.start', { name: 'read' }, t0 + 20);
    push('tool.end', { name: 'read', ok: true }, t0 + 30);
    push('usage', { usage: { prompt_tokens: 100, completion_tokens: 20 } }, t0 + 40);
    push('turn.end', { status: 'done' }, t0 + 50);
    push('turn.start', {}, t0 + 60);
    push('turn.end', { status: 'capped' }, t0 + 70);
    const sums = E.deriveTurnSummaries(E.readEvents(ev).events);
    assert.equal(sums.length, 2, '两轮必须有两条摘要');
    assert.equal(sums[0].turn, 1, '轮号从 1 开始');
    assert.equal(sums[0].status, 'done', '第 1 轮状态取 turn.end');
    assert.equal(sums[0].toolCalls, 1, '第 1 轮工具计数');
    assert.equal(sums[0].steps, 1, '第 1 轮 step 计数');
    assert.equal(sums[0].endedAt, t0 + 50, '第 1 轮结束时刻');
    assert.ok(sums[0].usage && sums[0].usage.prompt_tokens === 100, 'usage 必须归到第 1 轮（取 data.usage）');
    assert.equal(sums[1].status, 'capped', '第 2 轮状态');
    assert.equal(sums[1].toolCalls, 0, '第 2 轮没有工具');
    ok('㉖ deriveTurnSummaries：轮号/状态/步数/工具数/usage 归属');

    // ㉗ 没有 turn.start 的事件（孤儿 step）不得崩，也不得凭空造轮
    const orphan = E.deriveTurnSummaries([{ seq: 1, time: 1, type: 'step.start', data: {} }]);
    assert.deepEqual(orphan, [], '孤儿事件不得造出摘要轮');
    ok('㉗ deriveTurnSummaries：孤儿 step 事件被忽略（不造轮）');

    // ㉘ missingToolCallIds：assistant 有 2 个 tool_calls，只回了 1 个 → 返回差集
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a' }, { id: 'b' }] },
      { role: 'tool', tool_call_id: 'a', content: 'ok' },
    ];
    assert.deepEqual(E.missingToolCallIds(msgs), ['b'], '必须返回还没有 tool 响应的 id');
    assert.deepEqual(E.missingToolCallIds([]), [], '空数组返回空');
    assert.deepEqual(E.missingToolCallIds(null), [], '非数组输入不崩');
    assert.deepEqual(E.missingToolCallIds([{ role: 'assistant', tool_calls: [{ id: 'x' }] }, { role: 'tool', tool_call_id: 'x', content: '' }]), [], '全部回应过则为空');
    ok('㉘ missingToolCallIds：差集/空输入/全回应三种情形');

    // ㉙ warnEventFailure：同一文件只告警一次（避免刷屏）
    const warned = [];
    const origWarn = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    try {
      E.warnEventFailure('/tmp/x.events.ndjson', 'EACCES');
      E.warnEventFailure('/tmp/x.events.ndjson', 'EACCES');
      E.warnEventFailure('/tmp/y.events.ndjson', 'EROFS');
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warned.length, 2, '同一文件只告警一次、不同文件各一次');
    assert.match(warned[0], /EACCES/, '告警必须带原始原因');
    assert.match(warned[0], /config\.eventLog=false/, '告警必须给出关闭开关');
    ok('㉙ warnEventFailure：按文件去重且带原因与开关');

    // ㉚ eventLogEnabled / setEventLogEnabled：开关可读可写且可回滚
    const before = E.eventLogEnabled();
    E.setEventLogEnabled(false);
    assert.equal(E.eventLogEnabled(), false, '关闭后必须读到 false');
    E.setEventLogEnabled(true);
    assert.equal(E.eventLogEnabled(), true, '打开后必须读到 true');
    E.setEventLogEnabled(before);
    ok('㉚ eventLogEnabled/setEventLogEnabled：可关可开可回滚');

    // ㉛ readEvents：目录不存在 → 空结果且不抛
    const missing = E.readEvents(path.join(base, 'nope', 'x.events.ndjson'));
    assert.equal(missing.ok, true, '不存在不应报错');
    assert.deepEqual(missing.events, [], '不存在返回空事件流');
    ok('㉛ readEvents：文件不存在返回空（不抛）');

    // ㉜ appendEvent：seq 连续性（同一文件连续 5 条）
    const seqFile = path.join(base, 'seq-check.events.ndjson');
    for (let i = 0; i < 5; i++) E.appendEvent(seqFile, { type: 'message.append', data: { i } });
    const seqs = E.readEvents(seqFile).events.map((e) => e.seq);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5], 'seq 必须 1..5 连续');
    ok('㉜ appendEvent：seq 连续递增');

    // ㉝ replayToMessages：空事件流 → 空数组（旧会话路径）
    assert.deepEqual(E.replayToMessages([]), [], '空事件流重放为空数组');
    ok('㉝ replayToMessages：空事件流返回空数组（旧会话兼容）');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
