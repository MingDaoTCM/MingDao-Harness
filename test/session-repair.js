// 悬空事件闭合（v0.6.40）的独立回归套件：`findDangling` / `synthClosers` / `repairEventLog`。
//
// 为什么单独一套：事件日志 append-only，进程被 kill / 崩溃 / 用户在「等审批」时关应用，
// 都会留下没有配对的事件。修补器的全部价值在于三条硬性质：
//   ① 只看不写：`findDangling` / `synthClosers` 是纯函数，能准确说出哪几条没闭合；
//   ② 只追加不改历史：`repairEventLog` 的既有字节**逐字节不变**，closers 走 appendEvent 拿连续 seq；
//   ③ 可重复：第二次跑必须 repaired:0（closers 已配对），损坏日志必须 ok:false 且一字不写。
//
// 约定：`expect` 关键词就是断言原文——变异批次（batch82）靠它确认「红的是不是这条」。
//
// 运行：node test/session-repair.js（不依赖网络）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const E = await import(pathToFileURL(path.join(srcDir, 'session-events.js')).href);
const S = await import(pathToFileURL(path.join(srcDir, 'session.js')).href);

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-session-repair-'));
process.env.MINGDAO_HOME = path.join(base, 'home');
fs.mkdirSync(path.join(process.env.MINGDAO_HOME, 'sessions'), { recursive: true });
delete process.env.MINGDAO_EVENT_LOG;
E.setEventLogEnabled(true);

let passed = 0;
/** @param {string} name */
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

let caseNo = 0;
/** 每个用例独立目录/文件：repairSessionEvents 的进程内去重按文件路径记，不能互相干扰。 */
function newCase() {
  caseNo += 1;
  const dir = path.join(base, `case-${caseNo}`);
  fs.mkdirSync(dir, { recursive: true });
  const sessionFile = path.join(dir, 'session.jsonl');
  return { dir, sessionFile, eventFile: E.eventFileFor(sessionFile) };
}

/** 夹具：追加一条事件并断言写入成功（失败会给出原因，避免后续断言在空文件上假绿）。 */
function put(eventFile, type, data, at = null) {
  const r = E.appendEvent(eventFile, { type, data, at });
  assert.equal(r.ok, true, `夹具写入 ${type} 必须成功：${r.error}`);
  return r.seq;
}

/** @param {string} eventFile */
function eventsOf(eventFile) {
  const read = E.readEvents(eventFile);
  assert.equal(read.ok, true, '夹具前提：事件文件必须可读');
  assert.equal(read.skipped, 0, '夹具前提：事件文件不得有坏行');
  return read.events;
}

try {
  // ---------- 1. findDangling：单条悬空 ask ----------
  {
    const { eventFile } = newCase();
    put(eventFile, 'approval.asked', { requestId: 'req-1', tool: 'write' });
    const d = E.findDangling(eventsOf(eventFile));
    assert.equal(d.asks.length, 1, '单条悬空 ask 必须被识别');
    assert.equal(d.asks[0].type, 'approval.asked', '悬空 ask 的类型必须原样返回');
    assert.equal(d.asks[0].data.requestId, 'req-1', '悬空 ask 必须带原关联键');
    assert.equal(d.tools.length, 0, '没有 tool.start 时 tools 必须为空');
    assert.equal(d.turns.length, 0, '没有 turn.start 时 turns 必须为空');
    ok('① findDangling：单条悬空 approval.asked 被识别（asks=1 / tools=0 / turns=0）');
  }

  // ---------- 2. findDangling：单条悬空 tool.start ----------
  {
    const { eventFile } = newCase();
    put(eventFile, 'tool.start', { callId: 'call-1', name: 'read_file' });
    const d = E.findDangling(eventsOf(eventFile));
    assert.equal(d.tools.length, 1, '悬空 tool.start 必须被识别');
    assert.equal(d.tools[0].data.callId, 'call-1', '悬空 tool.start 必须带 callId');
    assert.equal(d.asks.length, 0, '没有 ask 时 asks 必须为空');
    assert.equal(d.turns.length, 0, '没有 turn 时 turns 必须为空');
    ok('② findDangling：单条悬空 tool.start 被识别（tools=1 且带 callId）');
  }

  // ---------- 3. findDangling：单条悬空 turn ----------
  {
    const { eventFile } = newCase();
    put(eventFile, 'turn.start', { model: 'deepseek' });
    const d = E.findDangling(eventsOf(eventFile));
    assert.equal(d.turns.length, 1, '悬空 turn.start 必须被识别');
    assert.equal(d.turns[0].type, 'turn.start', '悬空 turn 必须是 turn.start 本身');
    assert.equal(d.asks.length, 0, '没有 ask 时 asks 必须为空');
    assert.equal(d.tools.length, 0, '没有 tool 时 tools 必须为空');
    ok('③ findDangling：单条悬空 turn.start 被识别（turns=1）');
  }

  // ---------- 4. 三类同时悬空 + 按 seq 排序 + 同 id 以最后一次为准 ----------
  {
    const { eventFile } = newCase();
    put(eventFile, 'turn.start', { n: 1 });
    put(eventFile, 'tool.start', { callId: 't1', name: 'old' });
    put(eventFile, 'tool.start', { callId: 't1', name: 'new' }); // 同 id 第二次：最后一次为准
    put(eventFile, 'approval.asked', { requestId: 'a1', v: 1 });
    put(eventFile, 'approval.asked', { requestId: 'a1', v: 2 }); // 同 id 第二次
    put(eventFile, 'tool.start', { callId: 't2', name: 'second' });
    const d = E.findDangling(eventsOf(eventFile));
    assert.equal(d.asks.length, 1, '同一个 requestId 的多次 ask 只能算一条');
    assert.equal(d.asks[0].data.v, 2, '同 id 多次出现必须取最后一次');
    assert.equal(d.tools.length, 2, 't1（覆盖后一次）+ t2 必须恰好两条悬空');
    assert.deepEqual(
      d.tools.map((e) => e.data.name),
      ['new', 'second'],
      '悬空事件必须按 seq 升序排列'
    );
    assert.equal(d.turns.length, 1, '一条悬空 turn 必须被识别');
    assert.deepEqual(d.tools.map((e) => e.seq), [...d.tools.map((e) => e.seq)].sort((a, b) => a - b), '每类悬空事件必须按 seq 升序');
    ok('④ findDangling：ask/tool/turn 三类并存、按 seq 排序、同 id 取最后一次');
  }

  // ---------- 5. synthClosers：字段 / 顺序 / 时间 / 原因 ----------
  {
    const { eventFile } = newCase();
    put(eventFile, 'turn.start', {});
    put(eventFile, 'approval.asked', { requestId: 'req-9' });
    put(eventFile, 'tool.start', { callId: 'call-9', name: 'shell' });
    const d = E.findDangling(eventsOf(eventFile));
    const closers = E.synthClosers(d, { at: 1700000000000, reason: '崩溃恢复测试' });
    assert.deepEqual(
      closers.map((c) => c.type),
      ['approval.decided', 'tool.end', 'turn.end'],
      '合成顺序必须是 approval.decided → tool.end → turn.end（先 turn.end 再 tool.end 是错的）'
    );
    for (const c of closers) {
      assert.equal(c.time, 1700000000000, '合成事件必须使用传入的 at 时间');
      assert.equal(c.data.synthetic, true, '每条合成事件必须带 synthetic 字段');
      assert.equal(c.data.reason, '崩溃恢复测试', '每条合成事件必须带 reason 字段');
      assert.equal('seq' in c, false, 'synthClosers 不得预分配 seq（seq 必须由 appendEvent 在锁内分配）');
    }
    assert.equal(closers[0].data.decision, 'aborted', '悬空 ask 的合成决定必须是 aborted');
    assert.equal(closers[0].data.requestId, 'req-9', '合成 decided 必须继承原 ask 的关联键');
    assert.equal(closers[1].data.ok, false, '悬空 tool 的合成 tool.end 必须是 ok:false');
    assert.equal(closers[1].data.error, '进程中断，工具结果未知', '合成 tool.end 必须给出「结果未知」原因');
    assert.equal(closers[1].data.name, 'shell', '合成 tool.end 必须保留工具名');
    assert.equal(closers[2].data.status, 'aborted', '悬空 turn 的合成 turn.end 必须是 aborted');
    ok('⑤ synthClosers：顺序/at/synthetic/reason/decision/ok:false/error/status 全部正确');
  }

  // ---------- 6. 已闭合的事件不重复合成 ----------
  {
    const { eventFile } = newCase();
    put(eventFile, 'turn.start', {});
    put(eventFile, 'turn.end', { status: 'done' });
    put(eventFile, 'approval.asked', { requestId: 'req-closed' });
    put(eventFile, 'approval.decided', { requestId: 'req-closed', decision: 'allow' });
    put(eventFile, 'tool.start', { callId: 'call-closed' });
    put(eventFile, 'tool.end', { callId: 'call-closed', ok: true });
    const d = E.findDangling(eventsOf(eventFile));
    assert.deepEqual(d, { asks: [], tools: [], turns: [] }, '全部配对后不得再报悬空');
    assert.deepEqual(E.synthClosers(d), [], '没有悬空时不得合成任何闭合事件');
    ok('⑥ 已闭合的 ask/tool/turn 不重复合成（findDangling 空 / synthClosers 空）');
  }

  // ---------- 7. repairEventLog：单条 ask → 追加 decided，历史字节不变 ----------
  {
    const { eventFile } = newCase();
    put(eventFile, 'approval.asked', { requestId: 'req-r1' });
    const before = fs.readFileSync(eventFile);
    const r = E.repairEventLog(eventFile, { reason: '启动修复' });
    assert.equal(r.ok, true, '正常日志的修补必须成功');
    assert.equal(r.repaired, 1, '单条悬空 ask 必须恰好补一条事件');
    assert.equal(r.dangling.asks.length, 1, '返回值必须报告修补前的悬空 ask');
    const after = fs.readFileSync(eventFile);
    assert.equal(after.subarray(0, before.length).equals(before), true, '修补器绝不能改写/删除既有字节');
    const all = eventsOf(eventFile);
    const last = all[all.length - 1];
    assert.equal(last.type, 'approval.decided', '最后一条必须是合成的 approval.decided');
    assert.equal(last.data.decision, 'aborted', '合成 decided 的决定必须是 aborted');
    assert.equal(last.data.synthetic, true, '追加后的 decided 必须仍带 synthetic:true');
    assert.equal(last.data.reason, '启动修复', '追加后的 decided 必须仍带 reason');
    assert.equal(last.data.requestId, 'req-r1', '合成 decided 必须能配回原 ask');
    ok('⑦ repairEventLog：单条悬空 ask 合成 decided(aborted,synthetic) 且历史字节不变');
  }

  // ---------- 8. repairEventLog：三类同时悬空 ----------
  {
    const { eventFile } = newCase();
    put(eventFile, 'turn.start', {});
    put(eventFile, 'approval.asked', { requestId: 'req-all' });
    put(eventFile, 'tool.start', { callId: 'call-all', name: 'write_file' });
    const r = E.repairEventLog(eventFile, { reason: '三类同时' });
    assert.equal(r.ok, true, '三类同时悬空的修补必须成功');
    assert.equal(r.repaired, 3, '三类同时悬空必须恰好补三条');
    const types = eventsOf(eventFile).map((e) => e.type);
    assert.deepEqual(
      types.slice(-3),
      ['approval.decided', 'tool.end', 'turn.end'],
      '三条闭合事件必须按 approval → tool → turn 的顺序接在尾部'
    );
    const d2 = E.findDangling(eventsOf(eventFile));
    assert.deepEqual(d2, { asks: [], tools: [], turns: [] }, '修补后必须没有悬空事件');
    ok('⑧ repairEventLog：三类同时悬空 → decided/tool.end/turn.end 各一条，修补后零悬空');
  }

  // ---------- 9. 幂等：连续跑两次，第二次 repaired:0 ----------
  {
    const { eventFile } = newCase();
    put(eventFile, 'turn.start', {});
    put(eventFile, 'tool.start', { callId: 'call-idem' });
    const first = E.repairEventLog(eventFile, { reason: '幂等测试' });
    assert.equal(first.ok, true, '第一次修补必须成功');
    assert.equal(first.repaired, 2, '第一次必须补两条');
    const afterFirst = fs.readFileSync(eventFile);
    const second = E.repairEventLog(eventFile, { reason: '幂等测试' });
    assert.equal(second.ok, true, '第二次修补必须成功（不是报错）');
    assert.equal(second.repaired, 0, '幂等：第二次必须 repaired:0（closers 已配对，不得重复追加）');
    assert.equal(fs.readFileSync(eventFile).equals(afterFirst), true, '幂等：第二次不得再写一个字节');
    ok('⑨ 幂等：连续两次第二次 repaired:0，文件字节不变');
  }

  // ---------- 10. 多回合只闭合最后未闭合的 turn ----------
  {
    const { eventFile } = newCase();
    put(eventFile, 'turn.start', { n: 1 });
    put(eventFile, 'turn.end', { status: 'done' });
    put(eventFile, 'turn.start', { n: 2 });
    const d = E.findDangling(eventsOf(eventFile));
    assert.equal(d.turns.length, 1, '多回合时只有最后一个未闭合 turn 是悬空的');
    assert.equal(d.turns[0].data.n, 2, '悬空 turn 必须是最后一个 turn.start');
    const r = E.repairEventLog(eventFile, { reason: '多回合' });
    assert.equal(r.repaired, 1, '多回合只补一条 turn.end');
    const after = eventsOf(eventFile);
    assert.equal(after.filter((e) => e.type === 'turn.end').length, 2, '原有 1 条 + 合成 1 条 turn.end');
    assert.equal(after[after.length - 1].data.status, 'aborted', '最后补的 turn.end 必须是 aborted');
    assert.equal(E.findDangling(after).turns.length, 0, '补完后不得再有悬空 turn');
    ok('⑩ 多回合：只闭合最后未闭合的 turn（补 1 条，不补历史已闭合的）');
  }

  // ---------- 11. 损坏日志（半行）：ok:false 且文件字节不变 ----------
  {
    const { eventFile } = newCase();
    const valid = JSON.stringify({ seq: 1, time: Date.now(), type: 'tool.start', data: { callId: 'x' } }) + '\n';
    fs.writeFileSync(eventFile, valid + '{"seq":2,"type":"tool.end","data":');
    const before = fs.readFileSync(eventFile);
    const r = E.repairEventLog(eventFile, { reason: '损坏测试' });
    assert.equal(r.ok, false, '损坏（半行）日志必须返回 ok:false');
    assert.equal(r.repaired, 0, '损坏日志不得修补任何事件');
    assert.match(String(r.error), /损坏|跳过/, '损坏日志的错误必须说明原因');
    assert.equal(fs.readFileSync(eventFile).equals(before), true, '损坏日志必须一个字节都不写');
    ok('⑪ 损坏日志（半行）：ok:false、repaired:0 且文件字节不变');
  }

  // ---------- 12. 不存在的事件文件：不报错、不创建文件 ----------
  {
    const { eventFile } = newCase();
    const r = E.repairEventLog(eventFile, { reason: '空日志' });
    assert.equal(r.ok, true, '没有事件文件是旧会话的正常形态，不是错误');
    assert.equal(r.repaired, 0, '空日志没有可修补的事件');
    assert.equal(fs.existsSync(eventFile), false, '没有悬空事件时不得为了修补而创建事件文件');
    ok('⑫ 不存在的事件文件：ok:true/repaired:0，且不创建文件');
  }

  // ---------- 13. cfg.eventLog=false：跳过修补，不写一个字节 ----------
  {
    const { sessionFile, eventFile } = newCase();
    put(eventFile, 'tool.start', { callId: 'call-off' });
    const before = fs.readFileSync(eventFile);
    const skipped = S.repairSessionEvents(sessionFile, { eventLog: false });
    assert.equal(skipped.skipped, true, 'cfg.eventLog=false 时必须标记 skipped');
    assert.equal(skipped.repaired, 0, 'cfg.eventLog=false 时不得修补');
    assert.equal(fs.readFileSync(eventFile).equals(before), true, 'cfg.eventLog=false 时不得写一个字节');
    // 关闭只应跳过本次；恢复配置后同一文件仍可修补（去重集合不得被 false 提前占用）
    const on = S.repairSessionEvents(sessionFile, { eventLog: true });
    assert.equal(on.repaired, 1, 'cfg.eventLog=true 时必须正常修补悬空 tool.start');
    ok('⑬ cfg.eventLog=false 跳过修补（不写一个字节），恢复后仍能修补');
  }

  // ---------- 14. loadSession 接线：首次读取修补一次，进程内去重 ----------
  {
    const { sessionFile, eventFile } = newCase();
    fs.writeFileSync(sessionFile, JSON.stringify({ role: 'user', content: '悬空会话' }) + '\n');
    put(eventFile, 'turn.start', {});
    const loaded = S.loadSession(sessionFile);
    assert.deepEqual(loaded.messages.map((m) => m.content), ['悬空会话'], 'loadSession 的消息读取必须完全不受修补影响');
    assert.equal(loaded.file, sessionFile, 'loadSession 返回值形状不变');
    const repairedOnce = fs.readFileSync(eventFile);
    assert.equal(eventsOf(eventFile).some((e) => e.type === 'turn.end'), true, '首次 loadSession 必须闭合悬空 turn');
    // 第二次 loadSession / 显式调用 repairSessionEvents：进程内去重，不再读也不再写
    S.loadSession(sessionFile);
    const again = S.repairSessionEvents(sessionFile);
    assert.equal(again.deduped, true, '同一会话在进程内只修补一次（第二次必须 deduped）');
    assert.equal(again.repaired, 0, '去重后不得再修补');
    assert.equal(fs.readFileSync(eventFile).equals(repairedOnce), true, '去重后不得再写事件文件');
    ok('⑭ loadSession 首次读取修补一次；同一会话进程内去重（第二次 deduped/repaired:0）');
  }

  // ---------- 15. seq 连续：合成事件接在尾部不重号 ----------
  {
    const { eventFile } = newCase();
    for (let i = 0; i < 5; i += 1) put(eventFile, 'message.append', { message: { role: 'user', content: `m${i}` } });
    put(eventFile, 'turn.start', {});
    put(eventFile, 'approval.asked', { requestId: 'seq-ask' });
    put(eventFile, 'tool.start', { callId: 'seq-tool' });
    const before = eventsOf(eventFile).map((e) => e.seq);
    const r = E.repairEventLog(eventFile, { reason: 'seq 测试' });
    assert.equal(r.repaired, 3, 'seq 用例：三类悬空各补一条');
    const seqs = eventsOf(eventFile).map((e) => e.seq);
    assert.deepEqual(
      seqs,
      Array.from({ length: seqs.length }, (_, i) => i + 1),
      '合成事件必须接在尾部：seq 连续 1..N，不重号'
    );
    assert.equal(new Set(seqs).size, seqs.length, 'seq 不得重号');
    assert.ok(seqs[seqs.length - 1] > before[before.length - 1], '合成事件的 seq 必须严格大于修补前的最大 seq');
    ok('⑮ 合成事件接在尾部：seq 连续 1..N 且不重号');
  }
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(`\nsession-repair：${passed} 项全部通过`);
